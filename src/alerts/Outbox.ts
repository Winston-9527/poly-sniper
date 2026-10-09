/**
 * 持久化报警队列（方案 §7.3）。
 *   - 每个钱包/市场/行为过程有去重键；重复采集不会重复报警。
 *   - 达到限速后不丢消息：溢出条目合并成摘要，随下一个窗口投递。
 *   - 失败按退避重试，超过最大次数转 dead 并保留原因（可人工复盘）。
 *   - 发送成功但回写前崩溃会重发（至少一次），不承诺跨网络恰好一次 —— 在状态页说明。
 */
import { Repos } from '../db/repos.js';
import type { Row } from '../db/Database.js';
import { Config } from '../config.js';
import { nowIso } from '../util/time.js';

export interface AlertPayload {
    chatId: string;
    title: string;
    body: string;
    eventId?: number;
    wallet?: string;
    conditionId?: string;
    priority?: string;
    dataQuality?: string;
}

export interface SendResult { ok: boolean; messageId?: string; error?: string; }

export type Sender = (chatId: string, html: string) => Promise<SendResult>;

export interface FlushReport {
    sent: number; failed: number; retried: number; dead: number; merged: number; deferredByRateLimit: number; details: string[];
}

export class AlertOutbox {
    constructor(private repos: Repos, private config: Config, private sender: Sender, private log: (m: string) => void = () => { }) { }

    /** 发送器可在装配阶段替换（例如接入 Telegram 或影子发送器） */
    setSender(sender: Sender): void { this.sender = sender; }

    enqueue(key: string, payload: AlertPayload): { inserted: boolean; id: number } {
        return this.repos.enqueueAlert(key, JSON.stringify(payload));
    }

    /** 把一份报告入队（去重键=行为事件去重键） */
    enqueueReport(key: string, payload: AlertPayload): { inserted: boolean; id: number } {
        return this.enqueue(`alert:${key}`, payload);
    }

    /** 启动/恢复：卡住的 sending 回到 retry */
    recover(now = nowIso()): number {
        const olderThan = new Date(Date.parse(now) - 5 * 60_000).toISOString();
        const n = this.repos.resetStuckSending(olderThan, now);
        if (n) this.log(`[outbox] 恢复 ${n} 条卡在 sending 的报警（可能重复投递一次）`);
        return n;
    }

    /** 投递到期条目，受每分钟限速约束 */
    async flush(now = new Date()): Promise<FlushReport> {
        const report: FlushReport = { sent: 0, failed: 0, retried: 0, dead: 0, merged: 0, deferredByRateLimit: 0, details: [] };
        const nowIsoStr = now.toISOString();
        const since = new Date(now.getTime() - 60_000).toISOString();
        let budget = Math.max(0, this.config.push.maxPerMinute - this.repos.sentSince(since));

        const due = this.repos.dueAlerts(nowIsoStr, this.config.push.maxPerMinute * 10);
        for (const row of due) {
            const id = Number(row.id);
            if (budget <= 0) {
                // 限速：合并进摘要窗口，不丢（方案 §7.3）
                const digestId = this.digestFor(now);
                this.repos.mergeAlert(id, digestId, nowIsoStr);
                report.merged++;
                report.deferredByRateLimit++;
                continue;
            }
            const payload = JSON.parse(String(row.payload)) as AlertPayload;
            if (!this.repos.claimAlert(id, nowIsoStr)) continue;
            const res = await this.sender(payload.chatId, payload.body);
            if (res.ok) {
                this.repos.markAlertSent(id, res.messageId ?? null, nowIsoStr);
                budget--;
                report.sent++;
            } else {
                const attempts = Number(row.attempts ?? 0);
                const backoff = this.config.push.retryBackoffSeconds[Math.min(attempts, this.config.push.retryBackoffSeconds.length - 1)];
                const exhausted = attempts + 1 >= this.config.push.maxAttempts;
                const next = exhausted ? null : new Date(now.getTime() + backoff * 1000).toISOString();
                const status = this.repos.markAlertFailure(id, res.error ?? '未知错误', next, nowIsoStr);
                if (status === 'dead') { report.dead++; this.log(`[outbox] 报警 ${id} 转为 dead：${res.error}`); }
                else { report.retried++; }
                report.failed++;
                report.details.push(`#${id} ${status}: ${res.error}`);
            }
        }
        return report;
    }

    /** 摘要窗口（每分钟一个），承载被限速挤掉的条目 */
    private digestFor(now: Date): number {
        const bucket = Math.floor(now.getTime() / 60_000);
        const key = `digest:${bucket}`;
        const existing = this.repos.db.get<{ id: number }>('SELECT id FROM alert_outbox WHERE dedupe_key=?', key);
        if (existing) return Number(existing.id);
        const payload: AlertPayload = {
            chatId: this.config.telegram.chatIds[0] ?? '',
            title: `合并摘要（限速溢出）`,
            body: '本轮限速期间有告警被合并，详情见下方列表。',
        };
        return this.repos.enqueueAlert(key, JSON.stringify(payload)).id;
    }

    /** 把已合并条目的标题写进摘要正文（发送前调用） */
    renderDigest(digestId: number): string {
        const rows = this.repos.db.all<{ payload: string }>('SELECT payload FROM alert_outbox WHERE merged_into=?', digestId);
        const titles = rows.map((r) => {
            try { return (JSON.parse(r.payload) as AlertPayload).title; } catch { return '（无法解析）'; }
        });
        const payload: AlertPayload = {
            chatId: this.config.telegram.chatIds[0] ?? '',
            title: `合并摘要：${titles.length} 条告警`,
            body: ['被限速合并的告警：', ...titles.map((t) => `• ${t}`)].join('\n'),
        };
        this.repos.updateAlertPayload(digestId, JSON.stringify(payload));
        return payload.body;
    }

    stats(): Record<string, number> { return this.repos.outboxStats(); }
    pendingCount(): number {
        const r = this.repos.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM alert_outbox WHERE status IN ('pending','retry','sending')`);
        return r?.n ?? 0;
    }
    list(limit = 20): Row[] { return this.repos.db.all('SELECT * FROM alert_outbox ORDER BY created_at DESC LIMIT ?', limit); }
}
