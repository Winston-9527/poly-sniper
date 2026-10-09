/**
 * 持仓过程与账本（方案 §6.3、§7.2）。
 *
 * 设计要点：
 *   - 观察起点之前的持仓作为「观察中的持仓过程」初始状态，不补造历史买入成本。
 *   - 买入/卖出不自动等于建仓/清仓：退出需要「推导份数归零」，且报告里区分是否被快照确认。
 *   - 拆分/合并/赎回/转换等来源先按类型记录，份数变化不能可靠归因时进入「未解释变化」，
 *     不被伪造成买卖（方案 §6.3）。
 *   - 估值按「该 token 自己的价格」计算，绝不拿另一边的价格给这一边估值（方案 §3.2、§12）。
 */
import { Repos } from '../db/repos.js';
import { add, cmp, decToString, div, mul, neg, parseDec, pctChange, sub, Dec, ZERO } from '../util/decimal.js';
import { nowIso } from '../util/time.js';

export type LedgerKind =
    | 'trade_buy' | 'trade_sell' | 'redeem' | 'split' | 'merge' | 'conversion'
    | 'transfer_in' | 'transfer_out' | 'reward' | 'unexplained';

/** 可以可靠量化份数变化的类型 */
const QUANTIFIED: Record<string, LedgerKind> = { TRADE: 'trade_buy' };
/** 已知但份数变化无法从来源单独归因的类型 */
const RECOGNIZED_UNQUANTIFIED: Record<string, LedgerKind> = {
    SPLIT: 'split', MERGE: 'merge', CONVERSION: 'conversion', TRANSFER: 'unexplained',
};
/** 只影响现金、不影响份数的类型 */
const CASH_ONLY = new Set(['YIELD', 'MAKER_REBATE', 'TAKER_REBATE', 'REWARD', 'REFERRAL_REWARD']);

export interface ActivityRow {
    id: number;
    source_record_id: number;
    wallet: string;
    type: string;
    condition_id: string | null;
    token_id: string | null;
    outcome: string | null;
    outcome_index: number | null;
    side: string | null;
    size: string | null;
    price: string | null;
    usdc_size: string | null;
    event_at: string;
    observed_at: string;
    tx_hash: string | null;
    activity_key: string;
}

export interface AppliedChange {
    kind: LedgerKind;
    /** 该条活动是否被当作可靠份数变化 */
    quantified: boolean;
    deltaSize: Dec | null;
    sizeBefore: Dec | null;
    sizeAfter: Dec | null;
    cashDelta: Dec | null;
    /** 归零：推导出的份数变成 0 */
    reachedZero: boolean;
    /** 卖出超过已知持仓，顺序不自洽 */
    oversold: boolean;
    reason: string;
}

export interface LedgerIssue { scope: string; key: string; reason: string; detail: string; }

export class PositionLedger {
    constructor(private repos: Repos) { }

    // ---------------- 观察起点 ----------------

    /**
     * 用快照开启持仓过程。baseline_complete=false 表示起点来自观察，而不是从零建仓，
     * 因此永远不能据此计算历史成本或历史收益。
     */
    openFromSnapshot(w: { wallet: string; tokenId: string; conditionId: string; outcome?: string | null; size: Dec | null; snapshotAt: string; reason?: 'snapshot' | 'first_observed_change' }): { episodeId: number | null; issue?: LedgerIssue } {
        if (w.size === null) {
            return { episodeId: null, issue: { scope: 'wallet', key: `${w.wallet}:${w.tokenId}`, reason: 'query_failed', detail: '快照份数未知，无法建立观察起点' } };
        }
        const existing = this.repos.openEpisodeFor(w.wallet, w.tokenId);
        if (existing) return { episodeId: Number(existing.id) };
        const id = this.repos.openEpisode({
            wallet: w.wallet,
            conditionId: w.conditionId,
            tokenId: w.tokenId,
            outcome: w.outcome ?? null,
            openedAt: w.snapshotAt,
            openedReason: w.reason ?? 'snapshot',
            initialSize: decToString(w.size) ?? '0',
            baselineComplete: false,
        });
        return { episodeId: id };
    }

    // ---------------- 应用活动 ----------------

    /** 把一条已入库活动应用到对应持仓过程，返回变化描述；不产生行为事件（由 Behaviors 负责）。 */
    applyActivity(a: ActivityRow): { change: AppliedChange | null; issue?: LedgerIssue } {
        const size = parseDec(a.size);
        const usdc = parseDec(a.usdc_size);
        const base = a.type.replace(/^UNKNOWN:/, '');

        // 无 token 的活动只能是现金类
        if (!a.token_id) {
            if (CASH_ONLY.has(base)) {
                return { change: { kind: 'reward', quantified: false, deltaSize: ZERO, sizeBefore: null, sizeAfter: null, cashDelta: usdc, reachedZero: false, oversold: false, reason: `${base} 只影响现金` } };
            }
            return { change: null, issue: { scope: 'wallet', key: `${a.wallet}:${a.activity_key}`, reason: 'unsupported_activity', detail: `活动 ${base} 没有 token 标识，无法归因到持仓` } };
        }

        const episode = this.repos.openEpisodeFor(a.wallet, a.token_id);
        if (!episode) {
            // 没有观察起点：先建立（不补造历史），再做账
            if (size === null) {
                return { change: null, issue: { scope: 'wallet', key: `${a.wallet}:${a.token_id}`, reason: 'incomplete_record', detail: `活动 ${base} 缺少份数，无法建立持仓过程` } };
            }
            const conditionId = a.condition_id ?? '';
            if (!conditionId) {
                return { change: null, issue: { scope: 'wallet', key: `${a.wallet}:${a.token_id}`, reason: 'incomplete_record', detail: '活动缺少 conditionId，无法建立持仓过程' } };
            }
            const isBuy = base === 'TRADE' && a.side === 'BUY';
            // 从观察起点开始：第一笔若为买入，起点记为 0 之后再加；若为卖出，起点未知（记为 0 并标注缺口）
            const opened = this.openFromSnapshot({ wallet: a.wallet, tokenId: a.token_id, conditionId, outcome: a.outcome, size: ZERO, snapshotAt: a.event_at, reason: 'first_observed_change' });
            if (opened.issue) return { change: null, issue: opened.issue };
            const issue: LedgerIssue | undefined = isBuy ? undefined : { scope: 'wallet', key: `${a.wallet}:${a.token_id}`, reason: 'incomplete_record', detail: '观察起点之前已有持仓：卖出发生在本机首次见到该持仓之前，份数变化只能作为下界' };
            const applied = this.applyActivity(a);
            // 起点为推断的 0：baseline_complete 必须保持 0
            return issue ? { change: applied.change, issue } : applied;
        }
        const episodeId = Number(episode.id);
        const before = parseDec(String(episode.last_size));
        const outcome = String(episode.outcome ?? a.outcome ?? '');

        // ---- 现金类（无份数变化）----
        if (CASH_ONLY.has(base)) {
            this.repos.appendLedgerEntry({
                episodeId, wallet: a.wallet, tokenId: a.token_id, kind: 'reward', deltaSize: '0', cashDelta: decToString(usdc),
                sourceRecordId: a.source_record_id, sourceType: 'verified', eventAt: a.event_at, observedAt: nowIso(),
                note: `${base}`, dedupeKey: `act:${a.id}`,
            });
            return { change: { kind: 'reward', quantified: false, deltaSize: ZERO, sizeBefore: before, sizeAfter: before, cashDelta: usdc, reachedZero: false, oversold: false, reason: `${base} 只影响现金` } };
        }

        // ---- 拆分/合并/转换：份数变化无法从单条来源可靠归因 ----
        const unquantified = RECOGNIZED_UNQUANTIFIED[base];
        if (unquantified) {
            this.repos.appendLedgerEntry({
                episodeId, wallet: a.wallet, tokenId: a.token_id, kind: unquantified, deltaSize: '0',
                cashDelta: decToString(usdc), sourceRecordId: a.source_record_id, sourceType: 'unexplained',
                eventAt: a.event_at, observedAt: nowIso(),
                note: `${base}：份数变化待与快照核对`, dedupeKey: `act:${a.id}`,
            });
            return {
                change: { kind: unquantified, quantified: false, deltaSize: null, sizeBefore: before, sizeAfter: before, cashDelta: usdc, reachedZero: false, oversold: false, reason: `${base} 份数变化无法单独归因` },
                issue: { scope: 'wallet', key: `${a.wallet}:${a.token_id}`, reason: 'unsupported_activity', detail: `来源类型 ${base} 未支持精确归因，已记入未解释变化` },
            };
        }

        // ---- 成交：唯一能可靠量化份数变化的类型 ----
        if (base === 'TRADE') {
            if (size === null) {
                return { change: null, issue: { scope: 'wallet', key: `${a.wallet}:${a.activity_key}`, reason: 'incomplete_record', detail: '成交缺少份数，未入账' } };
            }
            if (a.side !== 'BUY' && a.side !== 'SELL') {
                return { change: null, issue: { scope: 'wallet', key: `${a.wallet}:${a.activity_key}`, reason: 'incomplete_record', detail: `成交方向未知（side=${a.side}），未入账` } };
            }
            const delta = a.side === 'BUY' ? size : neg(size)!;
            const after = add(before, delta)!;
            const oversold = before !== null && after < 0n;
            const cash = usdc === null ? null : (a.side === 'BUY' ? neg(usdc)! : usdc);
            this.repos.appendLedgerEntry({
                episodeId, wallet: a.wallet, tokenId: a.token_id, kind: a.side === 'BUY' ? 'trade_buy' : 'trade_sell',
                deltaSize: decToString(delta)!, cashDelta: decToString(cash), sourceRecordId: a.source_record_id,
                sourceType: 'verified', eventAt: a.event_at, observedAt: nowIso(),
                note: `${outcome || '?'} ${a.side} @ ${a.price ?? '?'}`, dedupeKey: `act:${a.id}`,
            });
            const reachedZero = cmp(after, ZERO) === 0;
            this.repos.updateEpisode(episodeId, {
                lastSize: decToString(after)!,
                ...(reachedZero ? { status: 'closed', closedAt: a.event_at, closedReason: 'derived_zero' } : {}),
                ...(oversold ? { status: 'unknown' } : {}),
            });
            return {
                change: { kind: a.side === 'BUY' ? 'trade_buy' : 'trade_sell', quantified: true, deltaSize: delta, sizeBefore: before, sizeAfter: after, cashDelta: cash, reachedZero, oversold, reason: oversold ? '卖出份数超过已知持仓，顺序不自洽' : '' },
                issue: oversold ? { scope: 'wallet', key: `${a.wallet}:${a.token_id}`, reason: 'unexplained_change', detail: `卖出后推导份数为 ${decToString(after)}（负数），说明起点缺失或存在未记录变化` } : undefined,
            };
        }

        // ---- 赎回：份数归零 + 现金流入；份数变化由「当前推导持仓」推导，标记为 derived ----
        if (base === 'REDEEM') {
            const delta = before === null ? null : neg(before)!;
            const after = before === null ? null : ZERO;
            this.repos.appendLedgerEntry({
                episodeId, wallet: a.wallet, tokenId: a.token_id, kind: 'redeem', deltaSize: decToString(delta) ?? '0',
                cashDelta: decToString(usdc), sourceRecordId: a.source_record_id, sourceType: 'derived',
                eventAt: a.event_at, observedAt: nowIso(), note: '赎回：按推导持仓归零', dedupeKey: `act:${a.id}`,
            });
            if (after !== null) this.repos.updateEpisode(episodeId, { lastSize: '0', status: 'closed', closedAt: a.event_at, closedReason: 'redeem' });
            return {
                change: { kind: 'redeem', quantified: after !== null, deltaSize: delta, sizeBefore: before, sizeAfter: after, cashDelta: usdc, reachedZero: after !== null, oversold: false, reason: '赎回按推导持仓归零' },
                ...(before === null ? { issue: { scope: 'wallet', key: `${a.wallet}:${a.token_id}`, reason: 'incomplete_record', detail: '赎回时推导份数未知，归零未量化' } } : {}),
            };
        }

        // ---- 其它未知类型：保留证据，不伪造买卖 ----
        this.repos.appendLedgerEntry({
            episodeId, wallet: a.wallet, tokenId: a.token_id, kind: 'unexplained', deltaSize: '0',
            cashDelta: decToString(usdc), sourceRecordId: a.source_record_id, sourceType: 'unexplained',
            eventAt: a.event_at, observedAt: nowIso(), note: `未识别类型 ${a.type}`, dedupeKey: `act:${a.id}`,
        });
        return {
            change: { kind: 'unexplained', quantified: false, deltaSize: null, sizeBefore: before, sizeAfter: before, cashDelta: usdc, reachedZero: false, oversold: false, reason: `未识别活动类型 ${a.type}` },
            issue: { scope: 'wallet', key: `${a.wallet}:${a.token_id}`, reason: 'unsupported_activity', detail: `未识别类型 ${a.type}，已记入未解释变化` },
        };
    }

    // ---------------- 对账 ----------------

    /**
     * 用来源快照核对账本推导。返回问题清单；
     * 「份数归零」只有在快照确认后才算完全核实（方案 §3.2、§12）。
     */
    reconcileWithSnapshot(w: { wallet: string; tokenId: string; snapshotSize: Dec | null; completeness: 'complete' | 'partial' | 'failed'; snapshotAt: string }): { issue?: LedgerIssue; confirmedZero: boolean; confirmed: boolean } {
        const ep = this.repos.openEpisodeFor(w.wallet, w.tokenId)
            ?? this.repos.db.get<{ id: number; last_size: string; status: string }>(`SELECT id, last_size, status FROM position_episodes WHERE wallet=? AND token_id=? ORDER BY opened_at DESC LIMIT 1`, w.wallet.toLowerCase(), w.tokenId);
        if (!ep) return { confirmedZero: false, confirmed: false };
        if (w.completeness !== 'complete' || w.snapshotSize === null) {
            return {
                confirmedZero: false,
                confirmed: false,
                issue: { scope: 'wallet', key: `${w.wallet}:${w.tokenId}`, reason: w.completeness === 'failed' ? 'query_failed' : 'truncated', detail: `快照完整度=${w.completeness}，无法与账本对账` },
            };
        }
        const derived = parseDec(String(ep.last_size));
        if (derived === null) return { confirmedZero: false, confirmed: false };
        if (cmp(derived, w.snapshotSize) === 0) {
            return { confirmedZero: cmp(w.snapshotSize, ZERO) === 0, confirmed: true };
        }
        return {
            confirmedZero: false,
            confirmed: false,
            issue: {
                scope: 'wallet', key: `${w.wallet}:${w.tokenId}`, reason: 'unexplained_change',
                detail: `账本推导 ${decToString(derived)} 份 与来源快照 ${decToString(w.snapshotSize)} 份不一致（${w.snapshotAt}）`,
            },
        };
    }

    // ---------------- 估值 ----------------

    /**
     * 按该 token 自己的价格估值。绝不用另一边的价格（方案 §12：Yes=0.9、仅持有 No 时不能按 0.9 估值）。
     */
    valuePosition(size: Dec | null, tokenPrice: Dec | null): Dec | null {
        if (size === null || tokenPrice === null) return null;
        return mul(size, tokenPrice);
    }

    /** 份数变化比例；起点为 0/未知时返回 null，不用 0 制造无限倍数 */
    changeRatio(before: Dec | null, after: Dec | null): Dec | null {
        if (before === null || after === null) return null;
        if (before === ZERO) return null;
        return pctChange(before, after);
    }

    /** 相对历史典型规模的倍数（用于「显著变化」；典型规模样本不足时返回 null） */
    relativeToTypical(notional: Dec | null, typical: Dec | null): Dec | null {
        if (notional === null || typical === null || typical === ZERO) return null;
        return div(notional, typical);
    }
}
