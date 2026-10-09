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

    /** 投递到期条目，受「每分钟限速」与「每日上限」双重约束（防刷屏） */
    async flush(now = new Date()): Promise<FlushReport> {
        const report: FlushReport = { sent: 0, failed: 0, retried: 0, dead: 0, merged: 0, deferredByRateLimit: 0, details: [] };
        const nowIsoStr = now.toISOString();
        const since = new Date(now.getTime() - 60_000).toISOString();
        let budget = Math.max(0, this.config.push.maxPerMinute - this.repos.sentSince(since));
        // 日上限：超过后不再即时推送，全部并入「当日摘要」，次日只发一条汇总
        const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
        let dayBudget = Math.max(0, this.config.push.maxPerDay - this.repos.sentSince(dayStart));

        const due = this.repos.dueAlerts(nowIsoStr, this.config.push.maxPerMinute * 10);
        for (const row of due) {
            const id = Number(row.id);
            if (budget <= 0 || dayBudget <= 0) {
                const overDay = dayBudget <= 0;
                const digestId = overDay ? this.dayDigestFor(now) : this.digestFor(now);
                this.repos.mergeAlert(id, digestId, nowIsoStr);
                report.merged++;
                report.deferredByRateLimit++;
                if (overDay) report.details.push(`已达日上限 ${this.config.push.maxPerDay} 条，合并进当日摘要（次日发送）`);
                continue;
            }
            const payload = JSON.parse(String(row.payload)) as AlertPayload;
            // 摘要类条目在发送前用当前被合并的标题刷新正文
            if (String(row.dedupe_key ?? '').startsWith('digest')) {
                payload.body = this.renderDigest(id);
                payload.title = this.digestTitle(id) ?? payload.title;
            }
            if (!this.repos.claimAlert(id, nowIsoStr)) continue;
            const res = await this.sender(payload.chatId, payload.body);
            if (res.ok) {
                this.repos.markAlertSent(id, res.messageId ?? null, nowIsoStr);
                budget--; dayBudget--;
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

    /**
     * 当日摘要（每天一个）：日上限用尽后所有告警并入这里，**次日**才投递一条汇总。
     * 这是防刷屏的硬闸：宁可晚一天给汇总，也不在半天里把消息打满。
     */
    private dayDigestFor(now: Date): number {
        const day = now.toISOString().slice(0, 10);
        const key = `digest-day:${day}`;
        const existing = this.repos.db.get<{ id: number }>('SELECT id FROM alert_outbox WHERE dedupe_key=?', key);
        if (existing) return Number(existing.id);
        const payload: AlertPayload = {
            chatId: this.config.telegram.chatIds[0] ?? '',
            title: `当日汇总（${day}）：已达日上限`,
            body: '当日推送已达上限，其余告警并入本条汇总。',
        };
        const id = this.repos.enqueueAlert(key, JSON.stringify(payload)).id;
        // 次日 00:05（UTC）之后才到期
        const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5));
        this.repos.db.run('UPDATE alert_outbox SET next_attempt_at=? WHERE id=?', next.toISOString(), id);
        return id;
    }

    private digestTitle(id: number): string | null {
        const row = this.repos.db.get<{ dedupe_key: string }>('SELECT dedupe_key FROM alert_outbox WHERE id=?', id);
        const key = String(row?.dedupe_key ?? '');
        const n = this.mergedChildren(id).length;
        if (key.startsWith('digest-day')) return `当日汇总（${key.slice(11)}）：${n} 条告警被合并`;
        return n ? `合并摘要：${n} 条告警` : null;
    }

    private mergedChildren(digestId: number): { title: string; body: string }[] {
        const rows = this.repos.db.all<{ payload: string }>('SELECT payload FROM alert_outbox WHERE merged_into=? ORDER BY created_at', digestId);
        return rows.map((r) => {
            try {
                const p = JSON.parse(r.payload) as AlertPayload;
                return { title: p.title ?? '（无标题）', body: p.body ?? '' };
            } catch { return { title: '（无法解析）', body: '' }; }
        });
    }

    /** 把已合并条目的标题写进摘要正文（发送前调用） */
    renderDigest(digestId: number): string {
        const children = this.mergedChildren(digestId);
        const head = `被合并的告警（${children.length} 条）：`;
        const shown = children.slice(0, 30).map((c) => `• ${c.title}`);
        if (children.length > 30) shown.push(`…另有 ${children.length - 30} 条`);
        const payload: AlertPayload = {
            chatId: this.config.telegram.chatIds[0] ?? '',
            title: this.digestTitle(digestId) ?? '合并摘要',
            body: [head, ...shown].join('\n'),
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
