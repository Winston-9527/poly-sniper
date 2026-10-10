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
    /** 每个被合并事件一行（市场名｜钱包短｜金额（%）｜优先级），供摘要按市场归并 */
    digestLines?: string[];
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

    /** 投递到期条目，受「每分钟限速」与「每日上限」双重约束（防刷屏）。
     *  高优先级另有独立预算（maxHighPerDay）：不被普通日上限挤掉，但也不会无限刷。 */
    async flush(now = new Date()): Promise<FlushReport> {
        const report: FlushReport = { sent: 0, failed: 0, retried: 0, dead: 0, merged: 0, deferredByRateLimit: 0, details: [] };
        const nowIsoStr = now.toISOString();
        const since = new Date(now.getTime() - 60_000).toISOString();
        // 0/负数 = 不限量（观察期）：用 Infinity 表达，避免出现“上限 0 条”这种误读
        const unlimited = (v: number) => !(v > 0);
        let budget = unlimited(this.config.push.maxPerMinute) ? Number.POSITIVE_INFINITY : Math.max(0, this.config.push.maxPerMinute - this.repos.sentSince(since));
        // 日上限：超过后不再即时推送，全部并入「当日摘要」，次日只发一条汇总
        const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
        let dayBudget = unlimited(this.config.push.maxPerDay) ? Number.POSITIVE_INFINITY : Math.max(0, this.config.push.maxPerDay - this.repos.sentSince(dayStart));
        let highBudget = unlimited(this.config.push.maxHighPerDay) ? Number.POSITIVE_INFINITY : Math.max(0, this.config.push.maxHighPerDay - this.repos.sentHighSince(dayStart));

        const due = this.repos.dueAlerts(nowIsoStr, unlimited(this.config.push.maxPerMinute) ? 500 : this.config.push.maxPerMinute * 10);
        let attempted = 0;
        for (const row of due) {
            const id = Number(row.id);
            let payload: AlertPayload;
            try { payload = JSON.parse(String(row.payload)) as AlertPayload; }
            catch { payload = { chatId: '', title: '（无法解析）', body: '' }; }
            const isHigh = String(payload.priority ?? '') === 'high';
            const dayBlocked = dayBudget <= 0 && !(isHigh && highBudget > 0);
            if (budget <= 0 || dayBlocked) {
                const overDay = dayBlocked;
                const digestId = overDay ? this.dayDigestFor(now) : this.digestFor(now);
                this.repos.mergeAlert(id, digestId, nowIsoStr);
                report.merged++;
                report.deferredByRateLimit++;
                if (overDay) report.details.push(`已达日上限 ${this.config.push.maxPerDay} 条，合并进当日摘要（次日发送）`);
                continue;
            }
            // 摘要类条目在发送前用当前被合并的标题/正文刷新
            if (String(row.dedupe_key ?? '').startsWith('digest')) {
                payload.body = this.renderDigest(id);
                payload.title = this.digestTitle(id) ?? payload.title;
            }
            if (!this.repos.claimAlert(id, nowIsoStr)) continue;
            // 不限量时会一次发很多条：用最小间隔（默认 1.1s）避免 Telegram 限流，这不是产品上限
            if (attempted > 0 && this.config.push.minIntervalMs > 0) {
                await new Promise((r) => setTimeout(r, this.config.push.minIntervalMs));
            }
            attempted++;
            const res = await this.sender(payload.chatId, payload.body);
            if (res.ok) {
                this.repos.markAlertSent(id, res.messageId ?? null, nowIsoStr);
                budget--;
                if (isHigh && dayBudget <= 0) highBudget--;
                else dayBudget--;
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
            body: '当日即时推送已达上限；本条在次日 00:05 后发送，正文会列出被合并的告警（按市场归并）。',
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

    private mergedChildren(digestId: number): { title: string; body: string; digestLines: string[]; market?: string }[] {
        const rows = this.repos.db.all<{ payload: string }>('SELECT payload FROM alert_outbox WHERE merged_into=? ORDER BY created_at', digestId);
        return rows.map((r) => {
            try {
                const p = JSON.parse(r.payload) as AlertPayload;
                return { title: p.title ?? '（无标题）', body: p.body ?? '', digestLines: Array.isArray(p.digestLines) ? p.digestLines : [] };
            } catch { return { title: '（无法解析）', body: '', digestLines: [] }; }
        });
    }

    /**
     * 把被合并条目渲染成有内容的摘要（发送前调用）：
     * 按市场归并，每行「钱包｜金额（变化%）｜优先级」，而不是只列标题。
     */
    renderDigest(digestId: number): string {
        const children = this.mergedChildren(digestId);
        const groups = new Map<string, string[]>();
        const fallback: string[] = [];
        let shown = 0;
        const MAX_LINES = 40;
        for (const c of children) {
            if (!c.digestLines.length) { fallback.push(c.title); continue; }
            for (const line of c.digestLines) {
                const cut = line.indexOf('｜');
                const market = cut > 0 ? line.slice(0, cut) : '（市场未知）';
                const rest = cut > 0 ? line.slice(cut + 1) : line;
                const arr = groups.get(market) ?? [];
                arr.push(rest);
                groups.set(market, arr);
            }
        }
        const lines: string[] = [`被合并的告警（${children.length} 条）：按市场归并，每行「钱包｜金额（变化%）｜优先级」`];
        for (const [market, items] of groups) {
            if (shown >= MAX_LINES) break;
            lines.push(`▸ ${market}`);
            for (const it of items.slice(0, 6)) {
                lines.push(`  · ${it}`);
                shown++;
                if (shown >= MAX_LINES) break;
            }
            if (items.length > 6) lines.push(`  · …另有 ${items.length - 6} 条同类`);
        }
        if (fallback.length) {
            lines.push('▸ 其他（缺市场信息）');
            for (const t of fallback.slice(0, 10)) lines.push(`  · ${t}`);
        }
        if (shown >= MAX_LINES) lines.push(`（其余已折叠；完整记录在库里，可用 /status 查看队列）`);
        lines.push('金额为按该 token 自身价格的估算；「未知」不等于 0。');
        const payload: AlertPayload = {
            chatId: this.config.telegram.chatIds[0] ?? '',
            title: this.digestTitle(digestId) ?? '合并摘要',
            body: lines.join('\n'),
        };
        this.repos.updateAlertPayload(digestId, JSON.stringify({ ...payload, digestLines: [] }));
        return payload.body;
    }

    stats(): Record<string, number> { return this.repos.outboxStats(); }
    pendingCount(): number {
        const r = this.repos.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM alert_outbox WHERE status IN ('pending','retry','sending')`);
        return r?.n ?? 0;
    }
    list(limit = 20): Row[] { return this.repos.db.all('SELECT * FROM alert_outbox ORDER BY created_at DESC LIMIT ?', limit); }
}
