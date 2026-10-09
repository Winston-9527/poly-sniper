/**
 * 采集器（方案 §5、§6）。要点：
 *   - 冷启动先取当前快照与近期活动，形成一个有时间戳的起点；历史补全在后台，且不阻塞已有可信数据的展示。
 *   - 增量用「重叠窗口」读取，去重后幂等入库；原始记录入库与采集水位推进在同一事务里提交。
 *   - 任何失败都写 collection_state + data_gaps；失败绝不产生「未发现异常」的成功结论。
 *   - 请求预算全局共享；预算耗尽时记录缺口与「实际覆盖」，而不是宣称完整覆盖。
 */
import { Repos } from '../db/repos.js';
import { DataApiClient } from '../sources/DataApi.js';
import { ChainSource } from '../sources/Chain.js';
import { RequestBudget } from '../sources/http.js';
import { assignSyntheticKeys, CONTRACT_VERSION, KNOWN_ACTIVITY_TYPES, RawActivity } from '../sources/contracts.js';
import { Config } from '../config.js';
import { nowIso } from '../util/time.js';
import { decToString, mul, parseDec, sumDec, add as addDec, ZERO, Dec } from '../util/decimal.js';

export interface CollectOutcome {
    inserted: number;
    pages: number;
    stoppedBecause: 'end' | 'watermark' | 'max_pages' | 'budget' | 'error' | 'unchanged';
    error?: string;
    warnings: string[];
}

/** 活动合成键的序号消歧（同一批次内完全相同的组合不丢） */
export function assignActivityKeys(rows: RawActivity[]): (RawActivity & { activityKey: string; keyCollision: boolean })[] {
    const seen = new Map<string, number>();
    return rows.map((r) => {
        const base = `${r.txHash ?? 'no-tx'}|${r.type}|${r.tokenId ?? '-'}|${r.side ?? '-'}|${r.size ?? '-'}|${r.price ?? '-'}|${r.timestamp}|${r.wallet}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        return { ...r, activityKey: n === 1 ? base : `${base}#${n}`, keyCollision: n > 1 };
    });
}

/** 规范化活动的必需字段检查：不完整就记缺口，不静默丢（INSERT OR IGNORE 会吞掉约束失败） */
export function isCompleteActivity(a: { eventAt?: unknown; type?: unknown; wallet?: unknown }): boolean {
    return typeof a.eventAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(a.eventAt)
        && typeof a.type === 'string' && a.type.length > 0
        && typeof a.wallet === 'string' && /^0x[0-9a-f]{40}$/.test(a.wallet);
}

/** 原始记录瘦身：去掉长文本与图片字段，限制单条体积；保留全部参与计算的字段 */
export function slimPayload(rows: unknown[]): string {
    const out = rows.map((r) => {
        const o = { ...(r as Record<string, unknown>) };
        for (const k of ['bio', 'profileImage', 'profileImageOptimized', 'icon', 'name', 'pseudonym']) delete o[k];
        return o;
    });
    const s = JSON.stringify(out);
    return s.length > 8000 ? JSON.stringify({ truncated: true, note: '原始载荷超过 8KB 已截断', head: out.slice(0, 20) }) : s;
}

export class Collector {
    constructor(private deps: { repos: Repos; dataApi: DataApiClient; chain: ChainSource; config: Config; budget: RequestBudget; log: (m: string) => void; }) { }
    private get repos() { return this.deps.repos; }

    // ---------------- 活动 ----------------

    /** 拉取钱包活动（DESC 增量 + 冷启动时 ASC 取最早） */
    async collectActivity(wallet: string, opts: { cold: boolean; pages?: number } = { cold: false }): Promise<CollectOutcome> {
        const w = wallet.toLowerCase();
        const key = `activity:${w}`;
        const cfg = this.deps.config;
        const st = this.repos.getState(key);
        const watermark = (st?.watermark_ts as string | null) ?? null;
        const overlapFloor = watermark
            ? new Date(Date.parse(watermark) - cfg.rules.incrementalOverlapHours * 3600_000).toISOString()
            : null;
        const warnings: string[] = [];
        let inserted = 0, pages = 0, stopped: CollectOutcome['stoppedBecause'] = 'end';
        const maxPages = opts.pages ?? cfg.budgets.activityPagesPerPull;
        let earliest: string | null = null, latest: string | null = null;
        let collision = false;

        for (let p = 0; p < maxPages; p++) {
            const r = await this.deps.dataApi.getActivity(w, { limit: 500, offset: p * 500, direction: 'DESC' });
            if (!r.ok) {
                this.repos.upsertState(key, { lastRunAt: nowIso(), failures: (Number(st?.consecutive_failures ?? 0) + 1), lastError: `${r.kind}: ${r.error}` });
                this.repos.addGap('wallet', w, r.kind === 'contract' ? 'contract_mismatch' : r.kind === 'budget' ? 'budget_exhausted' : 'query_failed', `${r.url} → ${r.error}`);
                return { inserted, pages, stoppedBecause: r.kind === 'budget' ? 'budget' : 'error', error: `${r.kind}: ${r.error}`, warnings };
            }
            pages++;
            const rows = assignActivityKeys(r.data);
            if (rows.some((x) => x.keyCollision)) {
                collision = true;
                warnings.push(`第 ${p} 页存在合成键冲突（同一交易内完全相同的成交），已用序号区分`);
            }
            if (rows.length) {
                earliest = earliest ?? rows[rows.length - 1].eventAt;
                latest = rows[0].eventAt;
            }
            const pageSourceKey = `activity:${w}:desc:${p}`;
            // 原始记录 + 规范化活动 + 水位推进在同一事务提交（方案 §6.2 第 4 条）
            inserted += this.repos.db.tx(() => {
                const srId = this.repos.insertSourceRecord({
                    source: 'data-api/activity', sourceKey: pageSourceKey, syntheticKey: true, wallet: w,
                    conditionId: null, payload: slimPayload(rows), eventAt: rows.length ? rows[0].eventAt : null,
                    observedAt: nowIso(), contractVersion: CONTRACT_VERSION,
                });
                let n = 0;
                for (const a of rows) {
                    if (!isCompleteActivity(a)) {
                        this.repos.addGap('wallet', w, 'contract_mismatch', `活动缺少规范化必需字段（eventAt/type/wallet）：${JSON.stringify({ t: a.type, at: a.eventAt, wallet: a.wallet }).slice(0, 160)}`);
                        continue;
                    }
                    if (a.eventAt <= (overlapFloor ?? '')) continue;
                    const res = this.repos.insertActivity({
                        sourceRecordId: srId, activityKey: a.activityKey, syntheticKey: true, wallet: w, type: a.type,
                        sourceType: a.recognized ? 'verified' : 'unsupported', conditionId: a.conditionId, tokenId: a.tokenId,
                        outcomeIndex: a.outcomeIndex, outcome: a.outcome, side: a.side, size: a.size, price: a.price,
                        usdcSize: a.usdcSize, eventAt: a.eventAt, observedAt: nowIso(), txHash: a.txHash,
                        marketSlug: a.slug ?? null, eventSlug: a.eventSlug ?? null,
                    });
                    if (!a.recognized) this.repos.addGap('wallet', w, 'unsupported_activity', `未识别活动类型 ${a.type}（${a.eventAt}）`);
                    if (a.size === null && a.type === 'TRADE') this.repos.addGap('wallet', w, 'incomplete_record', `成交缺少份数（${a.eventAt}）`);
                    if (res.inserted) n++;
                }
                this.repos.upsertState(key, {
                    cursor: JSON.stringify({ pages: p + 1, pageSize: 500 }),
                    watermarkTs: latest ?? watermark, latestTs: latest ?? null,
                    lastRunAt: nowIso(), lastOkAt: nowIso(), failures: 0, lastError: null,
                });
                return n;
            });

            if (rows.length < 500) { stopped = 'end'; break; }
            if (overlapFloor && rows[rows.length - 1].eventAt <= overlapFloor) { stopped = 'watermark'; break; }
            if (p === maxPages - 1) stopped = 'max_pages';
        }

        // 冷启动/补全：ASC 取最早，判断是否真正到来源起点（方案 §3.3）
        if (opts.cold || !Number(st?.reached_start ?? 0)) {
            const asc = await this.deps.dataApi.getActivity(w, { limit: 500, offset: 0, direction: 'ASC' });
            if (asc.ok && asc.data.length) {
                const firstTs = asc.data[0].eventAt;
                this.repos.db.tx(() => {
                    const srId = this.repos.insertSourceRecord({
                        source: 'data-api/activity', sourceKey: `activity:${w}:asc:0`, syntheticKey: true, wallet: w,
                        conditionId: null, payload: slimPayload(asc.data), eventAt: firstTs, observedAt: nowIso(), contractVersion: CONTRACT_VERSION,
                    });
                    for (const a of assignActivityKeys(asc.data)) {
                        if (!isCompleteActivity(a)) {
                            this.repos.addGap('wallet', w, 'contract_mismatch', `ASC 页活动缺少必需字段：${JSON.stringify({ t: a.type, at: a.eventAt }).slice(0, 120)}`);
                            continue;
                        }
                        this.repos.insertActivity({
                            sourceRecordId: srId, activityKey: a.activityKey, syntheticKey: true, wallet: w, type: a.type,
                            sourceType: a.recognized ? 'verified' : 'unsupported', conditionId: a.conditionId, tokenId: a.tokenId,
                            outcomeIndex: a.outcomeIndex, outcome: a.outcome, side: a.side, size: a.size, price: a.price,
                            usdcSize: a.usdcSize, eventAt: a.eventAt, observedAt: nowIso(), txHash: a.txHash,
                            marketSlug: a.slug ?? null, eventSlug: a.eventSlug ?? null,
                        });
                    }
                    const reachedStart = asc.data.length < 500;
                    this.repos.upsertState(key, {
                        earliestTs: firstTs, reachedStart, truncated: !reachedStart,
                        truncationReason: reachedStart ? null : `ASC 首页已满 500 条，起点未取到（${firstTs}）`,
                        lastOkAt: nowIso(),
                    });
                });
                if (asc.data.length >= 500) {
                    warnings.push(`历史被截断：ASC 首页 500 条已满，最早已取到 ${firstTs}，不代表该钱包的最早活动`);
                    this.repos.addGap('wallet', w, 'truncated', `活动历史未取到起点，最早已取到 ${firstTs}`);
                }
            } else if (!asc.ok) {
                this.repos.addGap('wallet', w, asc.kind === 'contract' ? 'contract_mismatch' : 'query_failed', `ASC 拉取失败：${asc.error}`);
                warnings.push(`最早活动未取到（${asc.kind}: ${asc.error}），画像只能给出下界`);
            }
        }
        if (collision) this.repos.addGap('wallet', w, 'synthetic_key', '来源无稳定成交 ID，存在合成键冲突，已用序号区分并保留核对记录');
        return { inserted, pages, stoppedBecause: stopped, warnings };
    }

    // ---------------- 持仓快照 ----------------

    /** 当前持仓快照 + 组合价值。失败/部分失败都显式记录。 */
    async collectPositions(wallet: string): Promise<{ outcome: CollectOutcome; snapshotAt: string; positions: { tokenId: string; conditionId: string; outcome: string | null; size: string | null; price: string | null; value: string | null; redeemable: boolean | null; conditionQuestion?: string }[] }> {
        const w = wallet.toLowerCase();
        const snapshotAt = nowIso();
        const warnings: string[] = [];
        const r = await this.deps.dataApi.getPositions(w, 500);
        if (!r.ok) {
            this.repos.addGap('wallet', w, r.kind === 'contract' ? 'contract_mismatch' : r.kind === 'budget' ? 'budget_exhausted' : 'query_failed', `持仓快照失败：${r.error}`);
            this.repos.insertPositionSnapshot({ wallet: w, tokenId: '*', size: null, completeness: 'failed', snapshotAt });
            return { outcome: { inserted: 0, pages: 0, stoppedBecause: r.kind === 'budget' ? 'budget' : 'error', error: r.error, warnings }, snapshotAt, positions: [] };
        }
        if (r.data.length >= 500) {
            warnings.push('持仓列表达到分页上限 500，可能存在未取到的持仓');
            this.repos.addGap('wallet', w, 'truncated', '持仓列表达到 500 条上限');
        }
        const positions: { tokenId: string; conditionId: string; outcome: string | null; size: string | null; price: string | null; value: string | null; redeemable: boolean | null }[] = [];
        this.repos.db.tx(() => {
            const srId = this.repos.insertSourceRecord({
                source: 'data-api/positions', sourceKey: `positions:${w}:${snapshotAt}`, wallet: w, conditionId: null,
                payload: slimPayload(r.data), eventAt: snapshotAt, observedAt: snapshotAt, contractVersion: CONTRACT_VERSION,
            });
            for (const p of r.data) {
                this.repos.upsertMarket({ conditionId: p.conditionId });
                this.repos.upsertOutcomeToken({ tokenId: p.tokenId, conditionId: p.conditionId, outcome: p.outcome, outcomeIndex: null });
                this.repos.insertPositionSnapshot({
                    sourceRecordId: srId, wallet: w, tokenId: p.tokenId, conditionId: p.conditionId, outcome: p.outcome,
                    size: p.size, currentValue: p.currentValue, price: p.price, avgPrice: p.avgPrice,
                    redeemable: p.redeemable, completeness: 'complete', snapshotAt,
                });
                positions.push({ tokenId: p.tokenId, conditionId: p.conditionId, outcome: p.outcome, size: p.size, price: p.price, value: p.currentValue, redeemable: p.redeemable });
            }
        });
        // 组合价值（USDC 口径，来源为 /value）
        const v = await this.deps.dataApi.getValue(w);
        if (v.ok && v.data[0]) {
            this.repos.insertBalanceSnapshot({ wallet: w, asset: 'USDC_PORTFOLIO_VALUE', amount: v.data[0].value, completeness: 'complete', snapshotAt });
        } else if (!v.ok) {
            warnings.push(`组合价值未取到：${v.kind}: ${v.error}`);
            this.repos.addGap('wallet', w, 'query_failed', `组合价值查询失败：${v.error}`);
        }
        return { outcome: { inserted: positions.length, pages: 1, stoppedBecause: 'end', warnings }, snapshotAt, positions };
    }

    // ---------------- 控制关系（关系证据） ----------------

    /** 读取代理合约控制关系；读不出是「未知」，写缺口而不写「无关系」 */
    async collectControlRelations(wallet: string): Promise<{ status: 'verified' | 'unknown' | 'failed'; owners: string[]; threshold: number | null; siblings: string[] }> {
        const w = wallet.toLowerCase();
        const r = await this.deps.chain.readControl(w);
        if (!r.ok) {
            this.repos.addGap('wallet', w, 'query_failed', `控制关系读取失败（${r.kind}: ${r.error}）`);
            return { status: 'failed', owners: [], threshold: null, siblings: [] };
        }
        const e = r.data;
        const checkedAt = nowIso();
        if (e.status === 'unknown') {
            this.repos.addGap('wallet', w, 'unsupported_contract', e.reason ?? '代理形态不支持 owner/getOwners');
            return { status: 'unknown', owners: [], threshold: null, siblings: [] };
        }
        const evidence = JSON.stringify({ method: e.owner ? 'owner()' : 'getOwners()', bytecodeSize: e.bytecodeSize, blockNumber: e.blockNumber, threshold: e.threshold, owners: e.owners ?? [e.owner] });
        // 单签名者（owner() 或 1-of-1 的 getOwners()）才算控制关系，可用于判断「同一实体名下多个代理钱包」
        const single = e.owner ?? (e.owners?.length === 1 && (e.threshold === null || e.threshold <= 1) ? e.owners[0] : null);
        if (single) {
            this.repos.insertRelation({ from: single, to: w, relationType: 'owner', evidence, strength: 'verified', checkedAt });
        }
        if (e.owners && e.owners.length > 1) {
            // 多签：记录完整签名者集合与阈值，但共享签名者不合并身份（方案 §3.1、§12）
            for (const signer of e.owners) {
                this.repos.insertRelation({ from: signer, to: w, relationType: 'multisig_signer', evidence, strength: 'verified', checkedAt });
            }
            this.repos.addGap('wallet', w, 'unsupported_activity', `多签钱包：${e.owners.length} 个签名者共享阈值 ${e.threshold ?? '未知'}，不据此认定同一人`);
        }
        return { status: 'verified', owners: e.owners ?? (e.owner ? [e.owner] : []), threshold: e.threshold, siblings: this.repos.siblingsByOwner(w) };
    }

    /**
     * 补齐市场元数据（question / slug / 24h 量 / 流动性）。
     * 顺序：① 用活动自带的 slug 免费补；② 元数据缺失或观察过期才发请求（受请求预算约束）。
     * 返回 true 表示「现在报告里能拿到市场标题」。
     */
    async ensureMarketMeta(conditionId: string, opts: { maxAgeMinutes?: number } = {}): Promise<boolean> {
        const maxAge = opts.maxAgeMinutes ?? 180;
        const before = this.repos.market(conditionId);
        if (before && !before.slug) {
            const s = this.repos.marketSlugFor(conditionId);
            if (s && (s.market_slug || s.event_slug)) {
                this.repos.upsertMarket({ conditionId, slug: s.market_slug ?? undefined, eventSlug: s.event_slug ?? undefined });
            }
        }
        const cur = this.repos.market(conditionId);
        const obs = this.repos.latestMarketObservation(conditionId);
        const ageMin = obs?.observed_at ? (Date.now() - Date.parse(obs.observed_at)) / 60_000 : Number.POSITIVE_INFINITY;
        if (cur?.question && ageMin <= maxAge) return true;
        const r = await this.observeMarket(conditionId);
        return r.ok;
    }

    // ---------------- 候选发现 ----------------

    /** 市场观察：市场元数据 + 价格/成交量背景 */
    async observeMarket(conditionId: string): Promise<{ ok: boolean; question?: string; tokens: { tokenId: string; outcome: string }[]; error?: string }> {
        const r = await this.deps.dataApi.getMarketByCondition(conditionId);
        if (!r.ok) {
            this.repos.addGap('market', conditionId, r.kind === 'contract' ? 'contract_mismatch' : 'query_failed', `市场元数据失败：${r.error}`);
            return { ok: false, error: r.error, tokens: [] };
        }
        const m = r.data;
        if (!m) {
            this.repos.addGap('market', conditionId, 'query_failed', '市场元数据为空（gamma 默认/closed/CLOB 三条路都查不到，不是「没有异动」）');
            return { ok: false, error: 'no market', tokens: [] };
        }
        this.repos.upsertMarket({ conditionId: m.conditionId, slug: m.slug, question: m.question, negRisk: m.negRisk, closed: m.closed, endDate: m.endDate });
        for (const t of m.tokens) this.repos.upsertOutcomeToken({ tokenId: t.tokenId, conditionId: m.conditionId, outcome: t.outcome, outcomeIndex: t.outcomeIndex });
        this.repos.insertMarketObservation({ conditionId: m.conditionId, price: null, volume24h: m.volume24hr, liquidity: m.liquidity, observedAt: nowIso() });
        if (!m.question || m.question === '') {
            this.repos.addGap('market', conditionId, 'incomplete_record', '市场标题缺失（元数据源没给 question）');
        }
        return { ok: true, question: m.question, tokens: m.tokens.map((t) => ({ tokenId: t.tokenId, outcome: t.outcome })) };
    }

    /**
     * 从市场成交与存量持有人发现候选（方案 §5.1）。
     * 双边都纳入：不做「只选顺着价格的人」的过滤。
     */
    async discoverFromMarket(conditionId: string, opts: { pages?: number; windowHours?: number } = {}): Promise<{
        added: number; skippedOverBudget: number; considered: number; byEntry: Record<string, number>;
        aggregates: { wallet: string; buy: string; sell: string; trades: number; first: string; last: string; directionChanged: boolean }[];
    }> {
        const cfg = this.deps.config;
        const pages = opts.pages ?? 4;
        const windowStart = new Date(Date.now() - (opts.windowHours ?? cfg.rules.tradeWindowHours) * 3600_000).toISOString();
        const agg = new Map<string, { wallet: string; buy: Dec; sell: Dec; buyUnknown: boolean; sellUnknown: boolean; trades: number; first: string; last: string; sides: Set<string> }>();

        for (let p = 0; p < pages; p++) {
            const r = await this.deps.dataApi.getTrades(conditionId, { limit: 500, offset: p * 500 });
            if (!r.ok) {
                this.repos.addGap('market', conditionId, r.kind === 'contract' ? 'contract_mismatch' : r.kind === 'budget' ? 'budget_exhausted' : 'query_failed', `成交拉取失败：${r.error}`);
                break;
            }
            const keyed = assignSyntheticKeys(r.data);
            this.repos.db.tx(() => {
                const srId = this.repos.insertSourceRecord({
                    source: 'data-api/trades', sourceKey: `trades:${conditionId}:${p}`, syntheticKey: true, wallet: null,
                    conditionId, payload: slimPayload(keyed), eventAt: keyed[0]?.eventAt ?? null, observedAt: nowIso(), contractVersion: CONTRACT_VERSION,
                });
                for (const t of keyed) {
                    const at = t.eventAt;
                    if (!at || at < windowStart) continue;
                    const cur = agg.get(t.wallet) ?? {
                        wallet: t.wallet, buy: ZERO, sell: ZERO, buyUnknown: false, sellUnknown: false,
                        trades: 0, first: at, last: at, sides: new Set<string>(),
                    };
                    const sizeD = parseDec(t.size), priceD = parseDec(t.price);
                    const notional = sizeD !== null && priceD !== null ? mul(sizeD, priceD) : null;
                    if (t.side === 'BUY') {
                        if (notional === null) cur.buyUnknown = true; else cur.buy = cur.buy + notional;
                    }
                    if (t.side === 'SELL') {
                        if (notional === null) cur.sellUnknown = true; else cur.sell = cur.sell + notional;
                    }
                    if (t.side === null) { cur.buyUnknown = true; cur.sellUnknown = true; } // 方向未知 → 金额口径不完整
                    cur.trades++;
                    cur.first = at < cur.first ? at : cur.first;
                    cur.last = at > cur.last ? at : cur.last;
                    if (t.side) cur.sides.add(t.side);
                    agg.set(t.wallet, cur);
                    // 成交也作为「该钱包在市场内的活动」证据存起来（后续 /check 可用）
                    this.repos.ensureWallet(t.wallet);
                }
                void srId;
            });
            if (r.data.length < 500) break;
            if (p === pages - 1) {
                this.repos.addGap('market', conditionId, 'budget_exhausted', `成交翻页达到上限（${pages} 页 / ${pages * 500} 笔），窗口内更早的成交未纳入`);
            }
        }

        const aggregates = [...agg.values()].map((a) => ({
            wallet: a.wallet, buy: decToString(a.buy) ?? '0', sell: decToString(a.sell) ?? '0',
            buyUnknown: a.buyUnknown, sellUnknown: a.sellUnknown,
            trades: a.trades, first: a.first, last: a.last, directionChanged: a.sides.size > 1,
        })).sort((x, y) => {
            const nx = Number(x.buy) + Number(x.sell), ny = Number(y.buy) + Number(y.sell);
            return ny - nx;
        });

        // 显著成交入口：双向都算，金额或累计额达标
        const threshold = cfg.rules.significantTradeNotional;
        const sumThreshold = cfg.rules.significantTradeSum;
        const candidates = aggregates.filter((a) => {
            const sideMax = Math.max(parseFloat(a.buy), parseFloat(a.sell));
            const total = parseFloat(a.buy) + parseFloat(a.sell);
            return sideMax >= threshold || total >= sumThreshold;
        });

        const byEntry: Record<string, number> = {};
        let added = 0, skipped = 0;
        for (const c of candidates.slice(0, cfg.budgets.newCandidatesPerCycle)) {
            const partial = c.buyUnknown || c.sellUnknown ? '（部分成交缺少价格/方向，金额为已知部分的下界）' : '';
            this.repos.watch(c.wallet, {
                marketConditionId: conditionId, source: 'significant_trade', tier: 2,
                reason: `窗口内买入 $${c.buy} / 卖出 $${c.sell}（${c.trades} 笔${c.directionChanged ? '，双向都有成交' : ''}）${partial}`,
                nextCollectAt: nowIso(),
            });
            byEntry.significant_trade = (byEntry.significant_trade ?? 0) + 1;
            added++;
        }
        if (candidates.length > cfg.budgets.newCandidatesPerCycle) {
            skipped = candidates.length - cfg.budgets.newCandidatesPerCycle;
            this.repos.addGap('market', conditionId, 'budget_exhausted', `候选 ${candidates.length} 个，本轮只纳入 ${cfg.budgets.newCandidatesPerCycle} 个（预算限制，不是「没有异常」）`);
        }

        // 重要存量持有人入口：不因近期没有成交而被排除
        const h = await this.deps.dataApi.getHolders(conditionId, 500);
        if (!h.ok) {
            this.repos.addGap('market', conditionId, h.kind === 'contract' ? 'contract_mismatch' : 'query_failed', `持仓者拉取失败：${h.error}`);
        } else {
            let holdersAdded = 0;
            for (const group of h.data) {
                const sorted = [...group.holders].sort((a, b) => Number(b.amount ?? 0) - Number(a.amount ?? 0));
                for (const holder of sorted.slice(0, cfg.rules.holderTopN)) {
                    const amount = parseDec(holder.amount ?? null);
                    if (amount === null || amount < parseDec(cfg.rules.holderMinSize)!) continue;
                    this.repos.watch(holder.address, {
                        marketConditionId: conditionId, source: 'major_holder', tier: 2,
                        reason: `该 token 前 ${cfg.rules.holderTopN} 持仓者（${decToString(amount)} 份）`,
                        nextCollectAt: nowIso(),
                    });
                    holdersAdded++;
                }
            }
            byEntry.major_holder = holdersAdded;
            added += holdersAdded;
        }

        return { added, skippedOverBudget: skipped, considered: aggregates.length + (byEntry.major_holder ?? 0), byEntry, aggregates };
    }

    /**
     * 低频观察：长期不交易的存量大户降级但不退出（方案 §5.1、§12）。
     * 只有用户手动关注才不降级；归档只发生在用户取消关注时。
     */
    applyTierPolicy(now = nowIso()): { downgraded: number } {
        const rows = this.repos.db.all<{ address: string; market_condition_id: string; priority_tier: number; source: string; last_collect_at: string | null }>(
            `SELECT address, market_condition_id, priority_tier, source, last_collect_at FROM watchlist
             WHERE withdrawn_at IS NULL AND source != 'manual' AND priority_tier < 3`,
        );
        let downgraded = 0;
        for (const r of rows) {
            const since = r.last_collect_at ?? null;
            if (!since) continue;
            if (Date.now() - Date.parse(since) > this.deps.config.rules.reactivationHours * 3600_000 * 4) {
                this.repos.setWatchState(r.address, r.market_condition_id, { tier: 3, state: 'lowfreq' });
                downgraded++;
            }
        }
        return { downgraded };
    }

    /** 下一次采集时间：按关注等级（配置即假设，实际延迟在 /status 里展示） */
    nextCollectAt(tier: number, now = new Date()): string {
        const m = this.deps.config.rules.collectIntervalMinutes;
        const minutes = tier === 1 ? m.manual : tier === 2 ? m.majorHolder : m.lowfreq;
        return new Date(now.getTime() + minutes * 60_000).toISOString();
    }

    static knownActivityTypes(): readonly string[] { return KNOWN_ACTIVITY_TYPES; }

    /** 热门市场（发现入口的默认来源；失败返回错误，不返回空列表冒充「没有市场」） */
    async topMarkets(limit = 3): Promise<{ ok: true; markets: string[]; slugs: string[] } | { ok: false; error: string }> {
        const r = await this.deps.dataApi.getActiveEvents(limit);
        if (!r.ok) {
            this.repos.addGap('source', 'gamma/events', r.kind === 'contract' ? 'contract_mismatch' : 'query_failed', `热门市场列表失败：${r.error}`);
            return { ok: false, error: r.error };
        }
        const markets: string[] = [], slugs: string[] = [];
        for (const ev of r.data) {
            for (const m of ev.markets) {
                this.repos.upsertMarket({ conditionId: m.conditionId, slug: m.slug, eventSlug: ev.slug, question: m.question, negRisk: m.negRisk, closed: m.closed, endDate: m.endDate });
                for (const t of m.tokens) this.repos.upsertOutcomeToken({ tokenId: t.tokenId, conditionId: m.conditionId, outcome: t.outcome, outcomeIndex: t.outcomeIndex });
                this.repos.insertMarketObservation({ conditionId: m.conditionId, volume24h: m.volume24hr, liquidity: m.liquidity, observedAt: nowIso() });
                markets.push(m.conditionId);
                slugs.push(ev.slug);
            }
        }
        return { ok: true, markets: markets.slice(0, limit), slugs };
    }
}
