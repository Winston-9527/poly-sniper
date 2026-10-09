import { fetch, ProxyAgent } from 'undici';
import { Holder, TradeRecord, UserActivity } from './types.js';

/** 一次活动的汇总（由 data-api /activity ASC 排序取到的最早若干条推导） */
export interface ActivityProfile {
    /** 取到的活动条数（== limit 时说明会话被截断） */
    count: number;
    truncated: boolean;
    /** 首次活动时间（秒）——ASC 排序下第一条，精确值 */
    firstActivityTs?: number;
    /** 首次活动所在交易哈希（用作链上注资扫描的锚点） */
    firstActivityTxHash?: string;
    /** 最早若干条活动里出现过的事件数 */
    distinctEvents: number;
    /** 最早若干条活动里出现过的市场数 */
    distinctMarkets: number;
}

export interface MarketTokenInfo {
    conditionId: string;
    tokenIds: string[];
    outcomes: string[];
    title: string;
    slug?: string;
    liquidity?: number;
    volume24hr?: number;
}

export class GammaClient {
    private baseUrl = "https://gamma-api.polymarket.com";
    private dataApiUrl = "https://data-api.polymarket.com";
    private dispatcher: any;
    private tokenPairCache: Map<string, MarketTokenInfo> = new Map();

    constructor() {
        const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
        if (proxyUrl) {
            console.log(`[GammaClient] 使用代理: ${proxyUrl}`);
            this.dispatcher = new ProxyAgent(proxyUrl);
        }
    }

    private async getJson(url: string, timeoutMs = 20000): Promise<any> {
        const res = await fetch(url, {
            dispatcher: this.dispatcher,
            // @ts-ignore
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return res.json();
    }

    /**
     * 获取市场的 Top 持仓者
     * @param conditionId 市场的 Condition ID
     * @param tokenId 特定的 Token ID (用于过滤 Yes/No)
     * @param limit 获取前多少名
     */
    async getTopHolders(conditionId: string, tokenId: string, limit: number = 20): Promise<Holder[]> {
        try {
            const url = `${this.dataApiUrl}/holders?market=${conditionId}&limit=${limit}`;
            const data = await this.getJson(url) as any[];
            const tokenData = data.find(item => item.token === tokenId);
            if (!tokenData || !tokenData.holders) {
                return [];
            }
            return tokenData.holders.map((item: any) => ({
                address: item.proxyWallet || item.userAddress,
                balance: parseFloat(item.amount)
            }));
        } catch (error) {
            console.error(`[GammaClient] 获取持仓者失败:`, error);
            return [];
        }
    }

    /**
     * 该市场全部 tokenId（Yes / No 双边）+ 标题等元数据。
     * 画像器需要它来判断「另一边」的成交（用 No 边下注等价于 Yes 边的反向）。
     */
    async getTokenPair(conditionIdOrTokenId: string): Promise<MarketTokenInfo | null> {
        const cached = this.tokenPairCache.get(conditionIdOrTokenId);
        if (cached) return cached;
        const isCondition = conditionIdOrTokenId.startsWith('0x');
        const url = isCondition
            ? `${this.baseUrl}/markets?condition_ids=${encodeURIComponent(conditionIdOrTokenId)}`
            : `${this.baseUrl}/markets?clob_token_ids=${encodeURIComponent(conditionIdOrTokenId)}`;
        try {
            const data = await this.getJson(url) as any[];
            if (!Array.isArray(data) || data.length === 0) return null;
            const m = data[0];
            const info: MarketTokenInfo = {
                conditionId: m.conditionId,
                tokenIds: JSON.parse(m.clobTokenIds || "[]"),
                outcomes: JSON.parse(m.outcomes || "[]"),
                title: m.question,
                slug: m.slug,
                liquidity: parseFloat(m.liquidity),
                volume24hr: parseFloat(m.volume24hr),
            };
            this.tokenPairCache.set(conditionIdOrTokenId, info);
            if (info.conditionId) this.tokenPairCache.set(info.conditionId, info);
            for (const t of info.tokenIds) this.tokenPairCache.set(t, info);
            return info;
        } catch (error) {
            console.warn(`[GammaClient] 解析市场 token 对失败 ${conditionIdOrTokenId}:`, (error as Error).message);
            return null;
        }
    }

    /**
     * 根据 Token ID 查找对应的市场元数据
     */
    async getMarketMetadataByTokenId(tokenId: string): Promise<{ id: string, conditionId: string } | null> {
        const info = await this.getTokenPair(tokenId);
        if (!info) return null;
        return { id: info.tokenIds[0] || tokenId, conditionId: info.conditionId };
    }

    /**
     * 根据 Slug 查找市场元数据
     */
    async getMarketMetadataBySlug(slug: string): Promise<{ id: string, conditionId: string, title: string, tokenIds: string[] } | null> {
        try {
            // 1. 尝试作为 Event Slug 查询
            const eventUrl = `${this.baseUrl}/events?slug=${slug}`;
            const data = await this.getJson(eventUrl) as any[];
            if (Array.isArray(data) && data.length > 0 && data[0].markets && data[0].markets.length > 0) {
                const market = data[0].markets[0];
                return {
                    id: market.id,
                    conditionId: market.conditionId,
                    title: market.question,
                    tokenIds: JSON.parse(market.clobTokenIds || "[]")
                };
            }
        } catch {
            // 继续尝试 market slug
        }
        try {
            const mData = await this.getJson(`${this.baseUrl}/markets?slug=${slug}`) as any[];
            if (Array.isArray(mData) && mData.length > 0) {
                return {
                    id: mData[0].id,
                    conditionId: mData[0].conditionId,
                    title: mData[0].question,
                    tokenIds: JSON.parse(mData[0].clobTokenIds || "[]")
                };
            }
        } catch (error) {
            console.error("[GammaClient] Failed to resolve slug:", error);
        }
        return null;
    }

    /**
     * 获取用户的最近活动 (历史接口，仍供旧调用方使用)
     */
    async getUserActivity(address: string, limit: number = 50): Promise<UserActivity[]> {
        try {
            const url = `${this.dataApiUrl}/activity?user=${address}&limit=${limit}`;
            const data = await this.getJson(url) as any[];
            return data.map(item => ({
                timestamp: item.timestamp,
                type: item.type,
                slug: item.slug,
                eventSlug: item.eventSlug,
                marketId: item.marketId || item.conditionId,
                asset: item.asset,
                side: item.side,
                size: item.size,
                usdcSize: item.usdcSize,
                transactionHash: item.transactionHash
            }));
        } catch (error) {
            console.warn(`[GammaClient] 获取用户活动失败 ${address}:`, (error as Error).message);
            return [];
        }
    }

    /**
     * 该钱包的「最早活动」汇总：一次请求拿到真实首次活动时间和专注度。
     *
     * 关键点：data-api /activity 支持 `sortBy=TIMESTAMP&sortDirection=ASC`，
     * 所以第一条就是**真实首笔活动**。v1 用的是「最近 50 条里最老的一条」，对活跃老号
     * 会把年龄算成几小时，是稳定的误报源。
     */
    async getActivityProfile(address: string, limit: number = 200): Promise<ActivityProfile> {
        const empty: ActivityProfile = { count: 0, truncated: false, distinctEvents: 0, distinctMarkets: 0 };
        try {
            const url = `${this.dataApiUrl}/activity?user=${encodeURIComponent(address)}`
                + `&limit=${limit}&sortBy=TIMESTAMP&sortDirection=ASC`;
            const data = await this.getJson(url, 25000) as any[];
            if (!Array.isArray(data) || data.length === 0) return empty;
            const events = new Set<string>();
            const markets = new Set<string>();
            for (const a of data) {
                const ev = a.eventSlug || a.slug;
                if (ev) events.add(ev);
                if (a.slug) markets.add(a.slug);
            }
            return {
                count: data.length,
                truncated: data.length >= limit,
                firstActivityTs: data[0]?.timestamp,
                firstActivityTxHash: data[0]?.transactionHash,
                distinctEvents: events.size,
                distinctMarkets: markets.size,
            };
        } catch (error) {
            console.warn(`[GammaClient] 获取活动汇总失败 ${address}:`, (error as Error).message);
            return empty;
        }
    }

    /** /trades 单页（供 TradeScanner 之外的工具复用） */
    async getTrades(conditionId: string, limit = 500, offset = 0): Promise<TradeRecord[]> {
        try {
            const url = `${this.dataApiUrl}/trades?market=${encodeURIComponent(conditionId)}&limit=${limit}&offset=${offset}`;
            const data = await this.getJson(url) as any[];
            return Array.isArray(data) ? data : [];
        } catch (error) {
            console.warn(`[GammaClient] 获取成交失败 ${conditionId}:`, (error as Error).message);
            return [];
        }
    }
}
