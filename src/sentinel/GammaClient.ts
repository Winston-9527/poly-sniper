import { fetch, ProxyAgent } from 'undici';
import { Holder, UserActivity } from './types.js';
import { isHighPriorityActive } from "../workflow/analysisRunner.js";
import { configureProxyAgents, getProxyUrl, getUndiciDispatcher } from '../network/proxy.js';

// Data API 超时
const DATA_API_TIMEOUT_MS = 10000;
// Gamma/Polymarket API 超时
const GAMMA_API_TIMEOUT_MS = 12000;

export class GammaClient {
    private baseUrl = "https://gamma-api.polymarket.com";
    private dataApiUrl = "https://data-api.polymarket.com";
    private dispatcher: any;
    private readonly holdersCache = new Map<string, { data: Holder[]; expiresAt: number }>();
    private readonly activityCache = new Map<string, { data: UserActivity[]; expiresAt: number }>();
    private readonly holdersCacheTtl = Number(process.env.DATA_API_HOLDERS_CACHE_TTL_MS || 300000);
    private readonly activityCacheTtl = Number(process.env.DATA_API_ACTIVITY_CACHE_TTL_MS || 120000);
    private readonly dataApiTimeoutMs = DATA_API_TIMEOUT_MS;
    private readonly gammaApiTimeoutMs = GAMMA_API_TIMEOUT_MS;
    private dataApiInFlight = 0;
    private readonly dataApiConcurrencyLimit = Number(process.env.DATA_API_CONCURRENCY_LIMIT || 2);
    private readonly dataApiPriorityConcurrencyLimit = Number(process.env.DATA_API_PRIORITY_CONCURRENCY_LIMIT || 1);
    private dataApiFailureCount = 0;
    private dataApiCircuitUntil = 0;
    private readonly dataApiFailureThreshold = Number(process.env.DATA_API_FAILURE_THRESHOLD || 3);
    private readonly dataApiCooldownMs = Number(process.env.DATA_API_COOLDOWN_MS || 30000);

    constructor() {
        configureProxyAgents();
        const proxyUrl = getProxyUrl();
        if (proxyUrl) {
            console.log(`[GammaClient] 使用代理: ${proxyUrl}`);
            this.dispatcher = getUndiciDispatcher();
        }
    }

    private toNumber(value: unknown): number | undefined {
        if (value === null || value === undefined) {
            return undefined;
        }
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === "string") {
            const parsed = Number.parseFloat(value);
            return Number.isFinite(parsed) ? parsed : undefined;
        }
        return undefined;
    }

    private async fetchWithTimeout(url: string, timeoutMs: number) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, {
                dispatcher: this.dispatcher,
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * 获取市场的 Top 持仓者
     * @param conditionId 市场的 Condition ID
     * @param tokenId 特定的 Token ID (用于过滤 Yes/No)
     * @param limit 获取前多少名
     */
    async getTopHolders(conditionId: string, tokenId: string, limit: number = 20): Promise<Holder[]> {
        const cacheKey = `${conditionId}:${tokenId}:${limit}`;
        const cached = this.holdersCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.data;
        }

        if (this.isDataApiCircuitOpen()) {
            console.warn("[GammaClient] Data API 熔断中，跳过持仓请求");
            return [];
        }

        const url = `${this.dataApiUrl}/holders?market=${conditionId}&limit=${limit}`;
        const maxAttempts = 3;

        await this.waitForDataApiSlot();
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                console.log(`[GammaClient] 正在请求: ${url}`);
                const response = await this.fetchWithTimeout(url, this.dataApiTimeoutMs);
                if (!response.ok) {
                    this.recordDataApiFailure();
                    console.error(`[GammaClient] Data API 错误: ${response.status} ${response.statusText}`);
                    if (attempt < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
                        continue;
                    }
                    return [];
                }

                const data = await response.json() as any[];
                console.log(`[GammaClient] 收到数据，长度: ${data.length}`);
                const tokenData = data.find(item => item.token === tokenId);
                if (!tokenData || !tokenData.holders) {
                    console.log(`[GammaClient] 未找到 Token ID ${tokenId} 的持仓数据`);
                    return [];
                }

                const holders = tokenData.holders.map((item: any) => ({
                    address: item.proxyWallet || item.userAddress,
                    balance: parseFloat(item.amount)
                }));
                this.holdersCache.set(cacheKey, { data: holders, expiresAt: Date.now() + this.holdersCacheTtl });
                this.resetDataApiFailures();
                return holders;
            } catch (error) {
                this.recordDataApiFailure();
                console.error(`[GammaClient] 获取持仓者失败 (尝试 ${attempt}/${maxAttempts}):`, error);
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 500 * attempt));
                    continue;
                }
                return [];
            } finally {
                this.releaseDataApiSlot();
            }
        }

        return [];
    }

    private async waitForDataApiSlot() {
        const maxWaitMs = Number(process.env.DATA_API_QUEUE_TIMEOUT_MS || 8000);
        const start = Date.now();
        const limit = isHighPriorityActive() ? this.dataApiPriorityConcurrencyLimit : this.dataApiConcurrencyLimit;
        while (this.dataApiInFlight >= limit) {
            if (Date.now() - start > maxWaitMs) {
                console.warn("[GammaClient] Data API 排队超时，继续尝试");
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        this.dataApiInFlight += 1;
    }

    private releaseDataApiSlot() {
        this.dataApiInFlight = Math.max(0, this.dataApiInFlight - 1);
    }

    private isDataApiCircuitOpen() {
        return Date.now() < this.dataApiCircuitUntil;
    }

    private recordDataApiFailure() {
        this.dataApiFailureCount += 1;
        if (this.dataApiFailureCount >= this.dataApiFailureThreshold) {
            this.dataApiCircuitUntil = Date.now() + this.dataApiCooldownMs;
            console.warn(`[GammaClient] Data API 熔断 ${this.dataApiCooldownMs}ms`);
            this.dataApiFailureCount = 0;
        }
    }

    private resetDataApiFailures() {
        this.dataApiFailureCount = 0;
        this.dataApiCircuitUntil = 0;
    }

    /**
     * 根据 Token ID 查找对应的市场元数据
     */
    async getMarketMetadataByTokenId(tokenId: string): Promise<{ id: string, conditionId: string, title?: string, slug?: string, liquidity?: number, tvl?: number, volume?: number } | null> {
        try {
            const url = `${this.baseUrl}/markets?clob_token_ids=${tokenId}`;
            const response = await this.fetchWithTimeout(url, this.gammaApiTimeoutMs);
            if (!response.ok) return null;

            const data = await response.json() as any[];
            if (data.length > 0) {
                const market = data[0];
                const marketLiquidity = this.toNumber(market.liquidityNum) ?? this.toNumber(market.liquidity);
                let tvl = marketLiquidity;
                let volume = this.toNumber(market.volumeNum) ?? this.toNumber(market.volume);
                let resolvedLiquidity = marketLiquidity;

                if (market.slug) {
                    const [eventMetrics, marketMetrics] = await Promise.all([
                        this.getEventMetricsBySlug(market.slug),
                        this.getMarketMetricsBySlug(market.slug)
                    ]);
                    resolvedLiquidity = marketMetrics?.liquidity ?? marketLiquidity;
                    tvl = resolvedLiquidity ?? eventMetrics?.liquidity ?? tvl;
                    volume = marketMetrics?.volume ?? eventMetrics?.volume ?? volume;
                }

                return {
                    id: market.id,
                    conditionId: market.conditionId,
                    title: market.question,
                    slug: market.slug,
                    liquidity: resolvedLiquidity,
                    tvl,
                    volume
                };
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    private async getEventMetricsBySlug(slug: string): Promise<{ liquidity?: number; volume?: number } | null> {
        try {
            const eventUrl = `https://polymarket.com/api/event?slug=${slug}`;
            const response = await this.fetchWithTimeout(eventUrl, this.gammaApiTimeoutMs);
            if (!response.ok) {
                return null;
            }
            const data = await response.json() as any;
            const liquidity = this.toNumber(data?.liquidity);
            const volume = this.toNumber(data?.volume);
            return { liquidity, volume };
        } catch {
            return null;
        }
    }

    private async getMarketMetricsBySlug(slug: string): Promise<{ liquidity?: number; volume?: number } | null> {
        try {
            const marketUrl = `https://polymarket.com/api/market?slug=${slug}`;
            const response = await this.fetchWithTimeout(marketUrl, this.gammaApiTimeoutMs);
            if (!response.ok) {
                return null;
            }
            const data = await response.json() as any;
            const liquidity = this.toNumber(data?.liquidityNum) ?? this.toNumber(data?.liquidity);
            const volume = this.toNumber(data?.volumeNum) ?? this.toNumber(data?.volume);
            return { liquidity, volume };
        } catch {
            return null;
        }
    }

    /**
     * 根据 Slug 查找市场元数据
     */
    async getMarketMetadataBySlug(slug: string): Promise<{ id: string, conditionId: string, title: string, tokenIds: string[], liquidity?: number, tvl?: number, volume?: number } | null> {
        try {
            // 1. 尝试作为 Event Slug 查询
            const eventUrl = `${this.baseUrl}/events?slug=${slug}`;
            const response = await this.fetchWithTimeout(eventUrl, this.gammaApiTimeoutMs);

            if (response.ok) {
                const data = await response.json() as any[];
                if (data.length > 0 && data[0].markets && data[0].markets.length > 0) {
                    // 通常取第一个市场作为主市场
                    const market = data[0].markets[0];
                    const eventLiquidity = this.toNumber(data[0].liquidity);
                    const eventVolume = this.toNumber(data[0].volume);
                    const [eventMetrics, marketMetrics] = await Promise.all([
                        this.getEventMetricsBySlug(slug),
                        this.getMarketMetricsBySlug(slug)
                    ]);
                    const marketLiquidity = this.toNumber(market.liquidity);
                    const resolvedLiquidity = marketMetrics?.liquidity ?? eventMetrics?.liquidity ?? marketLiquidity;
                    const resolvedVolume = marketMetrics?.volume ?? eventMetrics?.volume ?? eventVolume;
                    return {
                        id: market.id,
                        conditionId: market.conditionId,
                        title: market.question,
                        tokenIds: JSON.parse(market.clobTokenIds || "[]"),
                        liquidity: resolvedLiquidity,
                        tvl: resolvedLiquidity ?? eventLiquidity,
                        volume: resolvedVolume
                    };
                }
            }

            // 2. 尝试作为 Market Slug 查询
            const marketUrl = `${this.baseUrl}/markets?slug=${slug}`;
            const mResponse = await this.fetchWithTimeout(marketUrl, this.gammaApiTimeoutMs);
            if (mResponse.ok) {
                const mData = await mResponse.json() as any[];
                if (mData.length > 0) {
                    const [eventMetrics, marketMetrics] = await Promise.all([
                        this.getEventMetricsBySlug(slug),
                        this.getMarketMetricsBySlug(slug)
                    ]);
                    const liquidity = this.toNumber(mData[0].liquidityNum) ?? this.toNumber(mData[0].liquidity);
                    const resolvedLiquidity = marketMetrics?.liquidity ?? liquidity;
                    const resolvedVolume = marketMetrics?.volume
                        ?? eventMetrics?.volume
                        ?? (this.toNumber(mData[0].volumeNum) ?? this.toNumber(mData[0].volume));
                    return {
                        id: mData[0].id,
                        conditionId: mData[0].conditionId,
                        title: mData[0].question,
                        tokenIds: JSON.parse(mData[0].clobTokenIds || "[]"),
                        liquidity: resolvedLiquidity,
                        tvl: resolvedLiquidity ?? eventMetrics?.liquidity ?? liquidity,
                        volume: resolvedVolume
                    };
                }
            }

            return null;
        } catch (error) {
            console.error("[GammaClient] Failed to resolve slug:", error);
            return null;
        }
    }

    /**
     * 获取用户的最近活动 (用于修正交易次数和市场专注度)
     * @param address 钱包地址
     * @param limit 获取的条目数 (默认 50，足以判断活跃度)
     */
    async getUserActivity(address: string, limit: number = 50): Promise<UserActivity[]> {
        const cacheKey = `${address}:${limit}`;
        const cached = this.activityCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.data;
        }

        if (this.isDataApiCircuitOpen()) {
            console.warn("[GammaClient] Data API 熔断中，跳过活动请求");
            return [];
        }

        await this.waitForDataApiSlot();
        try {
            const url = `${this.dataApiUrl}/activity?user=${address}&limit=${limit}`;
            const response = await this.fetchWithTimeout(url, this.dataApiTimeoutMs);

            if (!response.ok) {
                this.recordDataApiFailure();
                console.warn(`[GammaClient] Activity API Error: ${response.status}`);
                return [];
            }

            // Data API 返回的是直接的数组
            const data = await response.json() as any[];
            const activities = data.map(item => ({
                timestamp: item.timestamp,
                type: item.type,
                slug: item.slug,
                eventSlug: item.eventSlug, // Added Mapping
                marketId: item.marketId || item.conditionId, // 兼容不同字段
                asset: item.asset,
                side: item.side,
                size: item.size,
                usdcSize: item.usdcSize
            }));
            this.activityCache.set(cacheKey, { data: activities, expiresAt: Date.now() + this.activityCacheTtl });
            this.resetDataApiFailures();
            return activities;
        } catch (error) {
            this.recordDataApiFailure();
            console.warn(`[GammaClient] 获取用户活动失败 ${address}:`, error);
            return [];
        } finally {
            this.releaseDataApiSlot();
        }
    }
}
