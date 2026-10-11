/**
 * Polymarket 数据来源客户端。每个方法返回 Result，失败带上 kind，绝不静默返回 []。
 * 契约校验失败按 kind='contract' 返回，并附带样例片段（方案 §6.1）。
 */
import { HttpClient, Result, err, ok, POLYMARKET } from './http.js';
import {
    ContractError, HoldersPage, RawActivity, RawPosition, RawPortfolioValue, RawTrade,
    validateActivity, validateHolders, validatePositions, validateTrades, validateValue,
    GammaMarket, validateGammaMarkets, validateGammaEvents,
} from './contracts.js';

export class DataApiClient {
    constructor(private http: HttpClient) { }

    /** /holders —— 重要存量持有人入口（方案 §5.1） */
    async getHolders(conditionId: string, limit = 100): Promise<Result<HoldersPage[]>> {
        const url = `${POLYMARKET.dataApi}/holders?market=${encodeURIComponent(conditionId)}&limit=${limit}`;
        const r = await this.http.getJson(url, 'data-api/holders');
        if (!r.ok) return r;
        try { return ok(validateHolders(r.data), { url, status: r.status, ms: r.ms }); }
        catch (e) { return this.contractErr(e, url, r.ms); }
    }

    /** /trades —— 近期成交入口。默认只含 taker 行；需要 maker 行时 takerOnly=false（方案 §6.1） */
    async getTrades(conditionId: string, opts: { limit?: number; offset?: number; takerOnly?: boolean } = {}): Promise<Result<Omit<RawTrade, 'syntheticKey' | 'keyCollision'>[]>> {
        const limit = opts.limit ?? 500, offset = opts.offset ?? 0;
        const taker = opts.takerOnly === false ? '&takerOnly=false' : '';
        const url = `${POLYMARKET.dataApi}/trades?market=${encodeURIComponent(conditionId)}&limit=${limit}&offset=${offset}${taker}`;
        const r = await this.http.getJson(url, 'data-api/trades');
        if (!r.ok) return r;
        try { return ok(validateTrades(r.data), { url, status: r.status, ms: r.ms }); }
        catch (e) { return this.contractErr(e, url, r.ms); }
    }

    /** /activity —— 钱包级事实来源（含非成交活动类型） */
    async getActivity(wallet: string, opts: { limit?: number; offset?: number; direction?: 'ASC' | 'DESC' } = {}): Promise<Result<RawActivity[]>> {
        const limit = opts.limit ?? 500, offset = opts.offset ?? 0, dir = opts.direction ?? 'DESC';
        const url = `${POLYMARKET.dataApi}/activity?user=${encodeURIComponent(wallet)}&limit=${limit}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=${dir}`;
        const r = await this.http.getJson(url, 'data-api/activity');
        if (!r.ok) return r;
        try { return ok(validateActivity(r.data), { url, status: r.status, ms: r.ms }); }
        catch (e) { return this.contractErr(e, url, r.ms); }
    }

    /** /positions —— 当前持仓快照（不是流量；方案 §3.2） */
    async getPositions(wallet: string, limit = 100): Promise<Result<RawPosition[]>> {
        const url = `${POLYMARKET.dataApi}/positions?user=${encodeURIComponent(wallet)}&limit=${limit}&sortBy=CURRENT&sortDirection=DESC`;
        const r = await this.http.getJson(url, 'data-api/positions');
        if (!r.ok) return r;
        try { return ok(validatePositions(r.data), { url, status: r.status, ms: r.ms }); }
        catch (e) { return this.contractErr(e, url, r.ms); }
    }

    /** /value —— 组合总价值（USDC 口径由来源决定，报告需注明） */
    async getValue(wallet: string): Promise<Result<RawPortfolioValue[]>> {
        const url = `${POLYMARKET.dataApi}/value?user=${encodeURIComponent(wallet)}`;
        const r = await this.http.getJson(url, 'data-api/value');
        if (!r.ok) return r;
        try { return ok(validateValue(r.data), { url, status: r.status, ms: r.ms }); }
        catch (e) { return this.contractErr(e, url, r.ms); }
    }

    /** gamma /markets（含 negRisk 与结果 token 映射） */
    async getMarkets(query: string): Promise<Result<GammaMarket[]>> {
        const url = `${POLYMARKET.gamma}/markets?${query}`;
        const r = await this.http.getJson(url, 'gamma/markets');
        if (!r.ok) return r;
        try { return ok(validateGammaMarkets(r.data), { url, status: r.status, ms: r.ms }); }
        catch (e) { return this.contractErr(e, url, r.ms); }
    }

    /**
     * 按 conditionId 取市场元数据（报告的市场维度依赖它）。
     * 顺序：gamma 默认 → gamma closed=true（已结算市场默认不返回）→ CLOB /markets/<id> 兜底。
     * 全部失败返回 ok(null)：调用方按「市场信息缺失」记录缺口，不臆造标题。
     */
    async getMarketByCondition(conditionId: string): Promise<Result<GammaMarket | null>> {
        const q = `condition_ids=${encodeURIComponent(conditionId)}`;
        const first = await this.getMarkets(q);
        if (first.ok && first.data.length) return ok(first.data[0], { url: first.url, status: first.status, ms: first.ms });
        if (!first.ok && (first.kind === 'contract' || first.kind === 'budget')) return first;
        const inclClosed = await this.getMarkets(`${q}&closed=true`);
        if (inclClosed.ok && inclClosed.data.length) return ok(inclClosed.data[0], { url: inclClosed.url, status: inclClosed.status, ms: inclClosed.ms });
        const clob = await this.getClobMarket(conditionId);
        if (clob.ok && clob.data) return clob;
        const src = first.ok ? first : inclClosed;
        if (!src.ok) return src;
        return ok(null, { url: src.url, status: src.status, ms: src.ms });
    }

    /** CLOB 兜底：/markets/<conditionId> 直接给出 question/slug/tokens（含已结算的短周期市场） */
    async getClobMarket(conditionId: string): Promise<Result<GammaMarket | null>> {
        const url = `${POLYMARKET.clob}/markets/${encodeURIComponent(conditionId)}`;
        const r = await this.http.getJson(url, 'clob/markets');
        if (!r.ok) return r;
        try {
            const d = (typeof r.data === 'object' && r.data !== null ? r.data : {}) as Record<string, unknown>;
            const rawTokens = Array.isArray(d.tokens) ? (d.tokens as Record<string, unknown>[]) : [];
            const market: GammaMarket = {
                conditionId: String(d.condition_id ?? conditionId),
                slug: typeof d.market_slug === 'string' && d.market_slug ? d.market_slug : undefined,
                question: typeof d.question === 'string' && d.question ? d.question : undefined,
                eventSlug: undefined,
                negRisk: typeof d.neg_risk === 'boolean' ? d.neg_risk : null,
                closed: typeof d.closed === 'boolean' ? d.closed : null,
                endDate: typeof d.end_date_iso === 'string' ? d.end_date_iso : undefined,
                tokens: rawTokens
                    .map((t, i) => ({ tokenId: String(t.token_id ?? ''), outcome: String(t.outcome ?? ''), outcomeIndex: i }))
                    .filter((t) => t.tokenId !== ''),
                volume24hr: null,
                liquidity: null,
            };
            if (!market.question) return ok(null, { url, status: r.status, ms: r.ms });
            return ok(market, { url, status: r.status, ms: r.ms });
        } catch (e) { return this.contractErr(e, url, r.ms); }
    }

    async getMarketBySlug(slug: string): Promise<Result<GammaMarket | null>> {
        const evUrl = `${POLYMARKET.gamma}/events?slug=${encodeURIComponent(slug)}`;
        const ev = await this.http.getJson(evUrl, 'gamma/events');
        if (ev.ok) {
            try {
                const events = validateGammaEvents(ev.data);
                if (events[0]?.markets?.length) return ok(events[0].markets[0], { url: evUrl, status: ev.status, ms: ev.ms });
            } catch (e) { /* 落到 /markets?slug= 再试一次 */ }
        }
        const m = await this.getMarkets(`slug=${encodeURIComponent(slug)}`);
        if (!m.ok) return m;
        return ok(m.data[0] ?? null, { url: m.url, status: m.status, ms: m.ms });
    }

    /** 活跃市场列表（用于发现入口与状态页） */
    async getActiveEvents(limit = 10): Promise<Result<{ slug: string; title: string; markets: GammaMarket[] }[]>> {
        const url = `${POLYMARKET.gamma}/events?limit=${limit}&active=true&closed=false&order=volume24hr&ascending=false`;
        const r = await this.http.getJson(url, 'gamma/events');
        if (!r.ok) return r;
        try { return ok(validateGammaEvents(r.data), { url, status: r.status, ms: r.ms }); }
        catch (e) { return this.contractErr(e, url, r.ms); }
    }

    private contractErr(e: unknown, url: string, ms: number): Result<never> {
        if (e instanceof ContractError) return err('contract', e.message, url, { ms, bodySnippet: e.payloadSnippet });
        return err('contract', String((e as Error)?.message ?? e), url, { ms });
    }
}
