/**
 * 钱包画像（方案 §7.1）。核心约束：
 *   - 「本机首次看到」「最早已获取活动」「首次可验证活动」三者分开存储与展示，本机首次看到不能用来证明账户新。
 *   - 历史被截断时只报告「已覆盖区间内」的事实，不把局部当终身（方案 §12）。
 *   - 基线计算排除当前待评估行为。
 *   - 成本不完整时，不输出精确胜率/收益率。
 */
import { Repos } from '../db/repos.js';
import { Dec, ZERO, cmp, decToString, decToNumber, fromDb, mul, parseDec, sumDec } from '../util/decimal.js';
import { durationText, nowIso } from '../util/time.js';
import { ALGORITHM_VERSION } from '../config.js';

export interface Coverage {
    earliestObservedActivity: string | null;
    reachedSourceStart: boolean;
    truncated: boolean;
    truncationReason: string | null;
    firstSeenLocally: string;
    lastActivity: string | null;
    activityCount: number;
}

export interface SizeStats { samples: number; p50: string | null; p90: string | null; max: string | null; windowDays: number; excludedEvents: number; aggregation: string; }

export interface ProfileMetrics {
    coverage: Coverage;
    activityByType: Record<string, number>;
    distinctEventsInCoverage: number;
    distinctMarketsInCoverage: number;
    tradeNotional: SizeStats;
    shareSize: SizeStats;
    positions: { tokenId: string; conditionId: string; outcome: string | null; size: string | null; price: string | null; value: string | null; completeness: string }[];
    positionValueCovered: string | null;
    relations: { to: string; type: string; strength: string; evidence: string }[];
    pnl: { available: false; reason: string };
    notes: string[];
}

function quantile(values: Dec[], q: number): Dec | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
    return sorted[idx];
}

export class Profiler {
    constructor(private repos: Repos) { }

    /**
     * 生成画像。excludeEpisodeId 用于排除「当前待评估行为」所在的持仓过程。
     */
    build(wallet: string, opts: { excludeEpisodeId?: number; windowsDays: number[]; asOf?: string }): ProfileMetrics {
        const w = wallet.toLowerCase();
        const asOf = opts.asOf ?? nowIso();
        const walletRow = this.repos.db.get<{ first_seen_at: string }>('SELECT first_seen_at FROM wallets WHERE address=?', w);
        const state = this.repos.getState(`activity:${w}`);
        const activities = this.repos.activitiesFor(w);
        const notes: string[] = [];

        const coverage: Coverage = {
            earliestObservedActivity: (state?.earliest_ts as string | null) ?? null,
            reachedSourceStart: Number(state?.reached_start ?? 0) === 1,
            truncated: Number(state?.truncated ?? 0) === 1,
            truncationReason: (state?.truncation_reason as string | null) ?? null,
            firstSeenLocally: walletRow?.first_seen_at ?? asOf,
            lastActivity: (state?.latest_ts as string | null) ?? null,
            activityCount: activities.length,
        };
        if (coverage.truncated) notes.push('该钱包的活动历史被截断：以下统计只代表「已获取区间」，不代表其全部历史');

        const activityByType: Record<string, number> = {};
        const events = new Set<string>(), markets = new Set<string>();
        for (const a of activities) {
            const t = String(a.type);
            activityByType[t] = (activityByType[t] ?? 0) + 1;
            if (a.event_slug) events.add(String(a.event_slug));
            if (a.market_slug) markets.add(String(a.market_slug));
        }

        // 交易规模基线：排除当前待评估行为（同一持仓过程 + 同一时间之后）
        const excluded = new Set<number>();
        let excludedSince: string | null = null;
        if (opts.excludeEpisodeId !== undefined) {
            const entries = this.repos.ledgerForEpisode(opts.excludeEpisodeId);
            for (const e of entries) excluded.add(Number(e.id));
            const first = entries[0];
            if (first) excludedSince = String(first.event_at);
        }
        const windowDays = opts.windowsDays[opts.windowsDays.length - 1] ?? 90;
        const since = new Date(Date.parse(asOf) - windowDays * 86400_000).toISOString();
        const notional: Dec[] = [];
        const shares: Dec[] = [];
        let excludedCount = 0;
        for (const a of activities) {
            if (String(a.type) !== 'TRADE') continue;
            if (String(a.event_at) < since) continue;
            const size = fromDb(a.size as string | null);
            const price = fromDb(a.price as string | null);
            const usdc = fromDb(a.usdc_size as string | null);
            if (excludedSince && String(a.event_at) >= excludedSince) { excludedCount++; continue; }
            if (size !== null) shares.push(size < 0n ? -size : size);
            const n = usdc !== null ? (usdc < 0n ? -usdc : usdc) : (size !== null && price !== null ? mul(size < 0n ? -size : size, price) : null);
            if (n !== null) notional.push(n);
        }
        const stats = (v: Dec[]): SizeStats => ({
            samples: v.length,
            p50: decToString(quantile(v, 0.5)),
            p90: decToString(quantile(v, 0.9)),
            max: v.length ? decToString(v.reduce((a, b) => (a > b ? a : b))) : null,
            windowDays,
            excludedEvents: excludedCount,
            aggregation: `按 ${windowDays} 天窗口内单笔成交统计（未合并同订单拆单；同向成交在行为识别阶段聚合）`,
        });

        // 当前组合：按「各 token 自己的价格」估值（方案 §3.2）
        const snaps = this.repos.latestPositionSnapshots(w);
        const positions = snaps.map((s) => {
            const size = fromDb(s.size as string | null);
            const price = fromDb(s.price as string | null);
            const value = size !== null && price !== null ? mul(size, price) : fromDb(s.current_value as string | null);
            return {
                tokenId: String(s.token_id), conditionId: String(s.condition_id ?? ''), outcome: (s.outcome as string | null),
                size: decToString(size), price: decToString(price), value: decToString(value), completeness: String(s.completeness),
            };
        });
        const completePositions = positions.filter((p) => p.completeness === 'complete');
        const positionValueCovered = completePositions.length
            ? decToString(sumDec(completePositions.map((p) => parseDec(p.value))))
            : null;
        if (!completePositions.length) notes.push('当前组合没有完整快照，无法给出组合价值');
        notes.push('组合价值只覆盖已获取到的持仓，不等于全部财富；不同结果之间的方向风险不能相加成一个净方向金额');

        const relations = this.repos.relationsFrom(w).map((r) => ({
            to: String(r.to_address), type: String(r.relation_type), strength: String(r.strength), evidence: String(r.evidence),
        }));

        return {
            coverage,
            activityByType,
            distinctEventsInCoverage: events.size,
            distinctMarketsInCoverage: markets.size,
            tradeNotional: stats(notional),
            shareSize: stats(shares),
            positions,
            positionValueCovered,
            relations,
            pnl: { available: false, reason: '观察起点之前的建仓成本不完整，按方案不输出胜率/收益率；只保留之后可核验的份数与现金变化' },
            notes,
        };
    }

    /** 活跃历史的一句话表述（严禁把截断样本说成完整历史） */
    describeActivityHistory(m: ProfileMetrics): string {
        const c = m.coverage;
        const parts: string[] = [];
        if (c.earliestObservedActivity) {
            const d = durationText(c.earliestObservedActivity, nowIso());
            parts.push(c.reachedSourceStart
                ? `已获取到来源起点，可验证活动约 ${d}`
                : `最早已获取活动约 ${d}（历史可能更长，尚未取到起点）`);
        } else {
            parts.push('尚未取到可验证活动时间');
        }
        parts.push(`覆盖区间内 ${c.activityCount} 条活动、${m.distinctEventsInCoverage} 个事件`);
        parts.push(`本机首次见到该地址：${c.firstSeenLocally}（这只能说明本机何时开始观察，不能证明账户新旧）`);
        return parts.join('；');
    }

    /** 持久化画像版本（可回放「当时已经获取的信息」） */
    persist(wallet: string, metrics: ProfileMetrics, asOf: string): void {
        this.repos.insertProfileVersion({
            wallet,
            asOf,
            coverageFrom: metrics.coverage.earliestObservedActivity,
            coverageTo: metrics.coverage.lastActivity,
            coverageComplete: metrics.coverage.reachedSourceStart && !metrics.coverage.truncated,
            metrics: JSON.stringify(metrics),
            algorithmVersion: ALGORITHM_VERSION,
        });
    }
}
