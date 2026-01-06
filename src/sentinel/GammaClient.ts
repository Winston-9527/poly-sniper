import { fetch, ProxyAgent } from 'undici';
import { Holder, UserActivity } from './types.js';

export class GammaClient {
    private baseUrl = "https://gamma-api.polymarket.com";
    private dataApiUrl = "https://data-api.polymarket.com";
    private dispatcher: any;

    constructor() {
        const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
        if (proxyUrl) {
            console.log(`[GammaClient] 使用代理: ${proxyUrl}`);
            this.dispatcher = new ProxyAgent(proxyUrl);
        }
    }

    /**
     * 获取市场的 Top 持仓者
     * @param conditionId 市场的 Condition ID
     * @param tokenId 特定的 Token ID (用于过滤 Yes/No)
     * @param limit 获取前多少名
     */
    async getTopHolders(conditionId: string, tokenId: string, limit: number = 20): Promise<Holder[]> {
        try {
            // 使用新的 Data API 获取持仓
            const url = `${this.dataApiUrl}/holders?market=${conditionId}&limit=${limit}`;
            console.log(`[GammaClient] 正在请求: ${url}`);
            const response = await fetch(url, { dispatcher: this.dispatcher });
            if (!response.ok) {
                console.error(`[GammaClient] Data API 错误: ${response.status} ${response.statusText}`);
                return [];
            }

            const data = await response.json() as any[];
            console.log(`[GammaClient] 收到数据，长度: ${data.length}`);
            // 找到对应 tokenId 的持仓数据
            const tokenData = data.find(item => item.token === tokenId);
            if (!tokenData || !tokenData.holders) {
                console.log(`[GammaClient] 未找到 Token ID ${tokenId} 的持仓数据`);
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
     * 根据 Token ID 查找对应的市场元数据
     */
    async getMarketMetadataByTokenId(tokenId: string): Promise<{ id: string, conditionId: string } | null> {
        try {
            const url = `${this.baseUrl}/markets?clob_token_ids_contains=${tokenId}`;
            const response = await fetch(url, { dispatcher: this.dispatcher });
            if (!response.ok) return null;

            const data = await response.json() as any[];
            if (data.length > 0) {
                return {
                    id: data[0].id,
                    conditionId: data[0].conditionId
                };
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * 获取用户的最近活动 (用于修正交易次数和市场专注度)
     * @param address 钱包地址
     * @param limit 获取的条目数 (默认 50，足以判断活跃度)
     */
    async getUserActivity(address: string, limit: number = 50): Promise<UserActivity[]> {
        try {
            const url = `${this.dataApiUrl}/activity?user=${address}&limit=${limit}`;
            const response = await fetch(url, { dispatcher: this.dispatcher });

            if (!response.ok) {
                console.warn(`[GammaClient] Activity API Error: ${response.status}`);
                return [];
            }

            // Data API 返回的是直接的数组
            const data = await response.json() as any[];
            return data.map(item => ({
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
        } catch (error) {
            console.warn(`[GammaClient] 获取用户活动失败 ${address}:`, error);
            return [];
        }
    }
}
