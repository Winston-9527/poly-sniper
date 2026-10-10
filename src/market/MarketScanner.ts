/**
 * 市场扫描与异动检测（首要信号：「哪个市场在动」）。
 *
 * 数据来源与成本：
 *   - gamma `/markets?order=volume24hr` 一页（默认 500 条）就能拿到几百个市场的
 *     价格 / 盘口(bestBid,bestAsk,spread) / 24h 量 / 流动性 / 1h·24h 变化 → 1 次请求。
 *   - 只有被判定为异动的 token 才去 CLOB 补精确盘口（/price?side=buy|sell + /spread），
 *     避免为整个市场面消耗请求。
 *
 * 判定基于**本机观察到的窗口变化**（自有历史），gamma 给的 1h/24h 只作为背景展示，
 * 不拿别人的口径当自己的证据。
 */
import { Repos } from '../db/repos.js';
import { DataApiClient } from '../sources/DataApi.js';
import { HttpClient, RequestBudget } from '../sources/http.js';
import { GammaMarket, assignSyntheticKeys, CONTRACT_VERSION } from '../sources/contracts.js';
import { slimPayload } from '../ledger/Collector.js';
import { Config, RULES_VERSION } from '../config.js';
import { Dec, add as addDec, cmp, decToNumber, decToString, mul, parseDec, sub, abs, ZERO } from '../util/decimal.js';
import { nowIso } from '../util/time.js';

export interface MarketSnapshot {
    conditionId: string;
    tokenId: string | null;
    outcome: string | null;
    price: Dec | null;
    bestBid: Dec | null;
    bestAsk: Dec | null;
    spread: Dec | null;
    lastTradePrice: Dec | null;
    change1h: Dec | null;
    change24h: Dec | null;
    volume24h: Dec | null;
    liquidity: Dec | null;
    observedAt: string;
}

export interface AnomalyRules {
    /** 价格变化（概率差，0.05 = 5 个百分点） */
    priceMove: number;
    priceMoveHigh: number;
    /** 观察窗口（分钟） */
    windowMinutes: number;
    /** 盘口走阔：spread / mid 比例 */
    spreadRatio: number;
    spreadRatioHigh: number;
    /** 价差相对上一条的放大倍数（必须是「变宽」，不是「本来宽」） */
    spreadGrowth: number;
    /** 中间价下限（分币市场不判相对价差）与绝对价差下限 */
    minMidPrice: number;
    minAbsSpread: number;
    /** 成交量突增倍数 */
    volumeSurge: number;
    volumeSurgeHigh: number;
    /** 最低 24h 成交量（过滤死市场）与最低流动性 */
    minVolume24h: number;
    minLiquidity: number;
    /** 同一市场/方向的报警冷却（分钟） */
    cooldownMinutes: number;
}

export interface AnomalyCandidate {
    conditionId: string;
    tokenId: string | null;
    outcome: string | null;
    kind: 'price_move' | 'spread_widen' | 'volume_surge';
    windowMinutes: number;
    priceBefore: Dec | null;
    priceAfter: Dec | null;
    delta: Dec | null;
    priority: 'high' | 'medium' | 'low';
    reason: string;
    dataQuality: 'verified' | 'partial' | 'incomplete';
    dedupeKey: string;
    eventAt: string;
}

export function anomalyRulesFromConfig(cfg: Config): AnomalyRules {
    return {
        priceMove: cfg.rules.marketPriceMove ?? 0.05,
        priceMoveHigh: cfg.rules.marketPriceMoveHigh ?? 0.1,
        windowMinutes: cfg.rules.marketWindowMinutes ?? 15,
        spreadRatio: cfg.rules.marketSpreadRatio ?? 0.1,
        spreadRatioHigh: cfg.rules.marketSpreadRatioHigh ?? 0.25,
        spreadGrowth: cfg.rules.marketSpreadGrowth ?? 2,
        minMidPrice: cfg.rules.marketMinMidPrice ?? 0.08,
        minAbsSpread: cfg.rules.marketMinAbsSpread ?? 0.02,
        volumeSurge: cfg.rules.marketVolumeSurge ?? 3,
        volumeSurgeHigh: cfg.rules.marketVolumeSurgeHigh ?? 8,
        minVolume24h: cfg.rules.marketMinVolume24h ?? 5000,
        minLiquidity: cfg.rules.marketMinLiquidity ?? 5000,
        cooldownMinutes: cfg.rules.alertCooldownMinutes,
    };
}

/**
 * 异动判定（纯函数）。返回可能的多条信号；每个信号自带可解释原因。
 * 数据不足时返回「数据不足」而不是伪造异动。
 */
export function detectAnomaly(prev: MarketSnapshot | null, cur: MarketSnapshot, rules: AnomalyRules): { candidates: AnomalyCandidate[]; insufficient?: string } {
    const out: AnomalyCandidate[] = [];
    const bucket = (kind: string) => `ma:${cur.conditionId}:${cur.tokenId ?? '-'}:${kind}:b${Math.floor(Date.parse(cur.observedAt) / (Math.max(1, rules.cooldownMinutes) * 60_000))}`;
    const vol = cur.volume24h, liq = cur.liquidity;
    const minVol = parseDec(rules.minVolume24h)!;
    const minLiq = parseDec(rules.minLiquidity)!;
    const liquidEnough = (vol === null || cmp(vol, minVol) >= 0) && (liq === null || cmp(liq, minLiq) >= 0);

    if (!prev) {
        return { candidates: [], insufficient: '这是该市场的第一条观察，还没有窗口可比较（下一次扫描才能判定异动）' };
    }
    const windowMinutes = Math.max(1, Math.round((Date.parse(cur.observedAt) - Date.parse(prev.observedAt)) / 60_000));

    // ---- 价格异动 ----
    if (prev.price !== null && cur.price !== null) {
        const delta = sub(cur.price, prev.price)!;
        const move = Math.abs(decToNumber(delta) ?? 0);
        if (move >= rules.priceMove) {
            const high = move >= rules.priceMoveHigh;
            out.push({
                conditionId: cur.conditionId, tokenId: cur.tokenId, outcome: cur.outcome, kind: 'price_move', windowMinutes,
                priceBefore: prev.price, priceAfter: cur.price, delta,
                priority: liquidEnough && high ? 'high' : liquidEnough ? 'medium' : 'low',
                reason: `${windowMinutes} 分钟内价格 ${decToString(prev.price)} → ${decToString(cur.price)}（变化 ${(move * 100).toFixed(1)} 个百分点，阈值 ${(rules.priceMove * 100).toFixed(0)}）`
                    + (liquidEnough ? '' : '；24h 成交量或流动性低于下限，仅记录'),
                dataQuality: 'verified', dedupeKey: bucket('price_move'), eventAt: cur.observedAt,
            });
        }
    } else {
        return { candidates: [], insufficient: '价格缺失（盘口为空或来源未给出），不能判定价格异动' };
    }

    // ---- 盘口走阔：必须是「相对自己上一条变宽」，不是「本来就很宽」 ----
    // 分币市场的相对价差没有意义（0.001/0.002 的中间价 → 66%），所以要求：
    // 中间价 ≥ minMidPrice、绝对价差 ≥ minAbsSpread、且价差相比上一条放大 ≥ spreadGrowth 倍
    if (cur.bestBid !== null && cur.bestAsk !== null && cur.spread !== null) {
        const mid = (decToNumber(cur.bestBid)! + decToNumber(cur.bestAsk)!) / 2;
        const ratio = mid > 0 ? (decToNumber(cur.spread)! / mid) : null;
        const prevSpread = prev.spread === null ? null : decToNumber(prev.spread)!;
        const growth = prevSpread !== null && prevSpread > 0 ? decToNumber(cur.spread)! / prevSpread : null;
        const penny = mid < rules.minMidPrice;
        const tooThin = decToNumber(cur.spread)! < rules.minAbsSpread;
        const widened = growth !== null && growth >= rules.spreadGrowth;
        if (ratio !== null && ratio >= rules.spreadRatio && liquidEnough && !penny && !tooThin && widened) {
            out.push({
                conditionId: cur.conditionId, tokenId: cur.tokenId, outcome: cur.outcome, kind: 'spread_widen', windowMinutes,
                priceBefore: prev.bestBid ?? null, priceAfter: cur.bestBid, delta: cur.spread,
                priority: ratio >= rules.spreadRatioHigh ? 'high' : 'medium',
                reason: `盘口走阔：买 ${decToString(cur.bestBid)} / 卖 ${decToString(cur.bestAsk)}，价差 ${decToString(cur.spread)}（占中间价 ${(ratio * 100).toFixed(1)}%；较上一条 ${decToString(prev.spread!)} 放大 ${growth!.toFixed(1)} 倍，阈值 ${rules.spreadGrowth} 倍）`,
                dataQuality: 'verified', dedupeKey: bucket('spread_widen'), eventAt: cur.observedAt,
            });
        }
    }

    // ---- 成交量突增 ----
    if (prev.volume24h !== null && cur.volume24h !== null) {
        const pv = decToNumber(prev.volume24h)!, cv = decToNumber(cur.volume24h)!;
        if (pv > 0) {
            const mult = cv / pv;
            if (mult >= rules.volumeSurge && cv >= rules.minVolume24h) {
                out.push({
                    conditionId: cur.conditionId, tokenId: cur.tokenId, outcome: cur.outcome, kind: 'volume_surge', windowMinutes,
                    priceBefore: prev.volume24h, priceAfter: cur.volume24h, delta: null,
                    priority: mult >= rules.volumeSurgeHigh ? 'high' : 'medium',
                    reason: `成交量突增：${windowMinutes} 分钟内 24h 成交量 $${pv.toFixed(0)} → $${cv.toFixed(0)}（${mult.toFixed(1)} 倍，阈值 ${rules.volumeSurge} 倍）`,
                    dataQuality: 'verified', dedupeKey: bucket('volume_surge'), eventAt: cur.observedAt,
                });
            }
        }
    }
    return { candidates: out };
}

export class MarketScanner {
    constructor(private deps: { repos: Repos; dataApi: DataApiClient; http: HttpClient; config: Config; budget: RequestBudget; log: (m: string) => void; }) { }
    private get repos() { return this.deps.repos; }

    /**
     * 扫描活跃市场：一次 gamma 调用拿到整页市场的价格与盘口，落成观察记录。
     * 同时把市场元数据（含 slug，用于链接）登记进 markets 表。
     */
    async scan(opts: { pages?: number; pageSize?: number } = {}): Promise<{ observed: number; markets: number; excluded: Record<string, number>; stoppedBecause: string; warnings: string[]; snapshots: MarketSnapshot[] }> {
        const pages = opts.pages ?? 5;
        const pageSize = opts.pageSize ?? 100;   // gamma 单次最多回 100 条：pageSize 必须等于真实页大小，否则第一页就误判“已到末页”
        const cfg = this.deps.config;
        const orders = (cfg.rules.marketScanOrders && cfg.rules.marketScanOrders.length ? cfg.rules.marketScanOrders : ['volume24hr']);
        const warnings: string[] = [];
        let observed = 0, markets = 0;
        const excluded: Record<string, number> = {};
        const seen = new Set<string>();
        const snapshots: MarketSnapshot[] = [];
        let stopped = 'end';
        for (const order of orders) {
        for (let p = 0; p < pages; p++) {
            if (!this.deps.budget.trySpend('gamma/markets')) { stopped = 'budget'; warnings.push('本轮请求预算用尽，市场扫描未完成'); break; }
            const r = await this.deps.dataApi.getMarkets(`limit=${pageSize}&offset=${p * pageSize}&active=true&closed=false&order=${order}&ascending=false`);
            if (!r.ok) {
                this.repos.addGap('source', 'gamma/markets', r.kind === 'contract' ? 'contract_mismatch' : 'query_failed', `市场扫描失败：${r.error}`);
                warnings.push(`市场扫描失败：${r.error}`);
                stopped = r.kind === 'budget' ? 'budget' : 'error';
                break;
            }
            const observedAt = nowIso();
            this.repos.db.tx(() => {
                for (const m of r.data) {
                    if (seen.has(m.conditionId)) continue;
                    seen.add(m.conditionId);
                    // 长尾聚焦：排除高频结算（小时/日频币价盘、当天球赛）与体育/电竞联赛盘
                    const why = this.exclusionReason(m);
                    if (why) { excluded[why] = (excluded[why] ?? 0) + 1; continue; }
                    this.repos.upsertMarket({
                        conditionId: m.conditionId, slug: m.slug, question: m.question,
                        negRisk: m.negRisk, closed: m.closed, endDate: m.endDate,
                    });
                    markets++;
                    for (const t of m.tokens) {
                        this.repos.upsertOutcomeToken({ tokenId: t.tokenId, conditionId: m.conditionId, outcome: t.outcome, outcomeIndex: t.outcomeIndex });
                        // gamma 的标量盘口字段对应 outcomeIndex 0；第二个结果用它的价格，盘口留空（不拿一边的盘口当另一边）
                        const isFirst = t.outcomeIndex === 0;
                        this.repos.insertMarketObservation({
                            conditionId: m.conditionId, tokenId: t.tokenId, outcome: t.outcome, price: t.price,
                            bestBid: isFirst ? m.bestBid : null, bestAsk: isFirst ? m.bestAsk : null,
                            spread: isFirst ? m.spread : null, lastTradePrice: isFirst ? m.lastTradePrice : null,
                            change1h: isFirst ? m.change1h : null, change24h: isFirst ? m.change24h : null,
                            volume24h: m.volume24hr, liquidity: m.liquidity, observedAt,
                        });
                        observed++;
                        snapshots.push({
                            conditionId: m.conditionId, tokenId: t.tokenId, outcome: t.outcome ?? null, price: t.price ? parseDec(t.price) : null,
                            bestBid: isFirst && m.bestBid ? parseDec(m.bestBid) : null, bestAsk: isFirst && m.bestAsk ? parseDec(m.bestAsk) : null,
                            spread: isFirst && m.spread ? parseDec(m.spread) : null, lastTradePrice: isFirst && m.lastTradePrice ? parseDec(m.lastTradePrice) : null,
                            change1h: isFirst && m.change1h ? parseDec(m.change1h) : null, change24h: isFirst && m.change24h ? parseDec(m.change24h) : null,
                            volume24h: m.volume24hr ? parseDec(m.volume24hr) : null, liquidity: m.liquidity ? parseDec(m.liquidity) : null,
                            observedAt,
                        });
                    }
                }
            });
            if (r.data.length < pageSize) break;
            if (p === pages - 1) { stopped = 'max_pages'; warnings.push(`市场扫描（${order}）达到页数上限（${pages} 页），更靠后的市场未纳入`); }
        }
        }
        return { observed, markets, excluded, stoppedBecause: stopped, warnings, snapshots };
    }

    /** 取某 token 的上一条观察（异动判定的基准） */
    previousSnapshot(tokenId: string, beforeIso: string): MarketSnapshot | null {
        const row = this.repos.db.get<Record<string, unknown>>(
            `SELECT * FROM market_observations WHERE token_id=? AND observed_at < ? ORDER BY observed_at DESC LIMIT 1`, tokenId, beforeIso,
        );
        if (!row) return null;
        return this.rowToSnapshot(row);
    }

    /** 最新一条观察（用于报告里的市场背景） */
    latestSnapshot(conditionId: string): MarketSnapshot | null {
        const row = this.repos.db.get<Record<string, unknown>>(
            `SELECT * FROM market_observations WHERE condition_id=? ORDER BY observed_at DESC LIMIT 1`, conditionId,
        );
        return row ? this.rowToSnapshot(row) : null;
    }

    private rowToSnapshot(row: Record<string, unknown>): MarketSnapshot {
        const d = (v: unknown) => parseDec(v === null || v === undefined ? null : String(v));
        return {
            conditionId: String(row.condition_id), tokenId: row.token_id === null ? null : String(row.token_id),
            outcome: row.outcome === null ? null : String(row.outcome),
            price: d(row.price), bestBid: d(row.best_bid), bestAsk: d(row.best_ask), spread: d(row.spread),
            lastTradePrice: d(row.last_trade_price), change1h: d(row.change_1h), change24h: d(row.change_24h),
            volume24h: d(row.volume_24h), liquidity: d(row.liquidity), observedAt: String(row.observed_at),
        };
    }

    /**
     * 精确盘口：CLOB `/price` 双边（买=buy、卖=sell），价差用二者相减自行计算。
     * 只对「即将报警的异动 token」调用，每轮有次数上限；缺失写 null 而不是 0。
     * 注意：gamma 的标量盘口只对应第一个结果，所以第二个结果必须走这里补。
     */
    async enrichBook(tokenId: string): Promise<{ ok: boolean; bestBid: string | null; bestAsk: string | null; spread: string | null; error?: string; requests: number }> {
        // 实测口径（与 gamma 的 bestBid/bestAsk 对齐过）：
        //   /price?side=buy  → 买一价（bestBid）
        //   /price?side=sell → 卖一价（bestAsk）
        const bidRes = await this.deps.http.getJson<{ price?: string }>(`https://clob.polymarket.com/price?token_id=${tokenId}&side=buy`, 'clob/price');
        const askRes = await this.deps.http.getJson<{ price?: string }>(`https://clob.polymarket.com/price?token_id=${tokenId}&side=sell`, 'clob/price');
        const bidP = bidRes.ok ? (bidRes.data.price ?? null) : null;
        const askP = askRes.ok ? (askRes.data.price ?? null) : null;
        let spread: string | null = null;
        if (bidP && askP) {
            // 买一 > 卖一 是瞬时错位/口径异常：不写负数价差，按「未知」处理并留证据
            const raw = sub(parseDec(askP), parseDec(bidP))!;
            spread = cmp(raw, ZERO) > 0 ? decToString(raw) : null;
        }
        if (!bidRes.ok && !askRes.ok) return { ok: false, bestBid: null, bestAsk: null, spread: null, error: bidRes.error, requests: 2 };
        return { ok: true, bestBid: bidP, bestAsk: askP, spread, requests: 2 };
    }

    /**
     * 为异动市场补一次成交流水（1 页 = 500 笔），用于报告里的「谁在动」。
     * 同一市场在 freshMinutes 内不重复拉取；只存原始记录 + 登记钱包，不写入候选/关注名单。
     */
    async ensureTradesFor(conditionId: string, opts: { freshMinutes?: number; windowHours?: number } = {}): Promise<{ ok: boolean; rows: number; skipped?: string; error?: string }> {
        const freshMinutes = opts.freshMinutes ?? 10;
        const last = this.repos.db.get<{ observed_at: string }>(
            `SELECT observed_at FROM source_records WHERE source='data-api/trades' AND market_condition_id=? ORDER BY id DESC LIMIT 1`,
            conditionId,
        );
        if (last?.observed_at && Date.now() - Date.parse(String(last.observed_at)) < freshMinutes * 60_000) {
            return { ok: true, rows: 0, skipped: `该市场成交流水在 ${freshMinutes} 分钟内已取过，不重复请求` };
        }
        const r = await this.deps.dataApi.getTrades(conditionId, { limit: 500, offset: 0 });
        if (!r.ok) {
            this.repos.addGap('market', conditionId, r.kind === 'contract' ? 'contract_mismatch' : r.kind === 'budget' ? 'budget_exhausted' : 'query_failed', `异动市场的成交流水未取到：${r.error}`);
            return { ok: false, rows: 0, error: r.error };
        }
        const keyed = assignSyntheticKeys(r.data);
        const observedAt = nowIso();
        // 聚合出「谁在动」并存成一条小记录：
        // 原始页会因体积上限被截断（截断后 movers 读不出），所以聚合结果单独落库。
        const movers = MarketScanner.aggregateMovers(keyed as unknown as Record<string, unknown>[], opts.windowHours ?? 6, 5);
        this.repos.db.tx(() => {
            this.repos.insertSourceRecord({
                source: 'data-api/trades', sourceKey: `trades:${conditionId}:anomaly`, syntheticKey: true, wallet: null,
                conditionId, payload: slimPayload(keyed), eventAt: keyed[0]?.eventAt ?? null, observedAt, contractVersion: CONTRACT_VERSION,
            });
            this.repos.insertSourceRecord({
                source: 'derived/movers', sourceKey: `movers:${conditionId}:${observedAt}`, syntheticKey: true, wallet: null,
                conditionId, payload: JSON.stringify({ movers, rows: keyed.length, windowHours: opts.windowHours ?? 6 }),
                eventAt: observedAt, observedAt, contractVersion: CONTRACT_VERSION,
            });
            for (const t of keyed) this.repos.ensureWallet(t.wallet);
        });
        return { ok: true, rows: keyed.length };
    }

    /**
     * 「谁在动」：从最近落库的成交流水里取该市场窗口内成交额最大的几个钱包。
     * 只报告已获取到的页，并注明口径（不宣称全市场）。
     */
    recentMovers(conditionId: string, limit = 3): { wallet: string; buy: string; sell: string; trades: number }[] {
        const row = this.repos.db.get<{ payload: string }>(
            `SELECT payload FROM source_records WHERE source='derived/movers' AND market_condition_id=? ORDER BY id DESC LIMIT 1`,
            conditionId,
        );
        if (!row) return [];
        try {
            const parsed = JSON.parse(row.payload) as { movers?: unknown };
            const arr = Array.isArray(parsed.movers) ? parsed.movers as { wallet: string; buy: string; sell: string; trades: number }[] : [];
            return arr.slice(0, limit);
        } catch { return []; }
    }

    /**
     * 排除判定：返回排除原因（null = 保留）。
     * 目标=长尾市场机会，所以排掉高频结算与体育/电竞盘：
     *   1) 距结束不足 minHoursToEnd（小时级币价盘、当天球赛）
     *   2) slug 首段命中联赛表（nba/epl/atp/cs2…）
     *   3) slug 命中高频模式正则（updown/hourly/15m/1h）
     */
    exclusionReason(m: GammaMarket): string | null {
        const r = this.deps.config.rules;
        const slug = String(m.slug ?? '').toLowerCase();
        if (!slug) return 'no_slug';
        const prefixes = r.marketExcludePrefixes ?? [];
        const head = slug.split('-')[0];
        if (prefixes.includes(head)) return `sports_esports_slug:${head}`;
        const re = r.marketExcludeSlugRegex;
        if (re && new RegExp(re, 'i').test(slug)) return 'high_frequency_slug';
        const minH = r.marketMinHoursToEnd ?? 0;
        if (minH > 0 && m.endDate) {
            const end = Date.parse(String(m.endDate));
            if (Number.isFinite(end)) {
                const hours = (end - Date.now()) / 3600_000;
                if (hours < minH) return hours < 0 ? 'already_ended' : `settles_soon:${hours.toFixed(1)}h`;
            }
        }
        return null;
    }

    /** 把成交流水聚合成「谁在动」（金额用精确十进制相乘，不做二进制浮点累加） */
    static aggregateMovers(rows: Record<string, unknown>[], windowHours: number, limit: number): { wallet: string; buy: string; sell: string; trades: number }[] {
        const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
        const agg = new Map<string, { wallet: string; buy: Dec; sell: Dec; trades: number }>();
        for (const t of rows) {
            const at = t.eventAt ? String(t.eventAt) : null;
            if (!at || at < since) continue;
            const wallet = String(t.wallet ?? '');
            if (!wallet) continue;
            const size = parseDec(t.size === null || t.size === undefined ? null : String(t.size));
            const price = parseDec(t.price === null || t.price === undefined ? null : String(t.price));
            const notional = size !== null && price !== null ? abs(mul(size, price)) : null;
            const a = agg.get(wallet) ?? { wallet, buy: ZERO, sell: ZERO, trades: 0 };
            if (String(t.side) === 'BUY') { if (notional !== null) a.buy += notional; }
            else if (String(t.side) === 'SELL') { if (notional !== null) a.sell += notional; }
            a.trades++;
            agg.set(wallet, a);
        }
        return [...agg.values()]
            .sort((x, y) => cmp(addDec(y.buy, y.sell)!, addDec(x.buy, x.sell)!) as number)
            .slice(0, limit)
            .map((a) => ({ wallet: a.wallet, buy: decToString(a.buy) ?? '0', sell: decToString(a.sell) ?? '0', trades: a.trades }));
    }

    /** 持久化异动候选 */
    recordAnomaly(c: AnomalyCandidate, snap: MarketSnapshot, ruleVersion = RULES_VERSION): { inserted: boolean; id: number } {
        return this.repos.insertMarketAnomaly({
            dedupeKey: c.dedupeKey, conditionId: c.conditionId, tokenId: c.tokenId, outcome: c.outcome, kind: c.kind,
            windowMinutes: c.windowMinutes, priceBefore: decToString(c.priceBefore), priceAfter: decToString(c.priceAfter),
            delta: decToString(c.delta), bestBid: decToString(snap.bestBid), bestAsk: decToString(snap.bestAsk),
            spread: decToString(snap.spread), volume24h: decToString(snap.volume24h), liquidity: decToString(snap.liquidity),
            change1h: decToString(snap.change1h), change24h: decToString(snap.change24h),
            priority: c.priority, reason: c.reason, dataQuality: c.dataQuality, ruleVersion,
            eventAt: c.eventAt, observedAt: nowIso(),
        });
    }
}

export function isFlat(a: Dec | null): boolean { return a !== null && cmp(a, ZERO) === 0; }
export function absDelta(a: Dec | null, b: Dec | null): Dec | null { return a === null || b === null ? null : abs(sub(a, b)); }
