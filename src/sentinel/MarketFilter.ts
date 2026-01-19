import { MarketMetadata } from "./types";

export class MarketFilter {
    // 强制排除的类别
    private excludedCategories: string[] = ["Sports"];
    // 需要根据标题判断的类别
    private cryptoPattern = /(Bitcoin|Ethereum|ETH|BTC|Solana|SOL|XRP).*(Price|Up|Down|Above|Below)/i;
    private shortTermPattern = /(15m|15 min|1h|1 hour|4h|4 hour|Daily)/i;
    private preMarketPattern = /Pre-market|Premarket/i;

    constructor() { }

    /**
     * 判断市场是否应该被包含在监控中
     * @param metadata 市场元数据
     * @returns 如果应该包含则返回 true
     */
    shouldInclude(metadata: MarketMetadata): boolean {
        const title = metadata.title || "";
        const category = (metadata.category || "").toLowerCase();

        // 1. 优先保留规则：如果是 Pre-market，无视任何排除规则，直接通过
        if (this.preMarketPattern.test(title)) {
            return true;
        }

        // 2. 类别排除：体育博彩
        for (const excluded of this.excludedCategories) {
            if (category.includes(excluded.toLowerCase())) {
                return false;
            }
        }

        // 3. Crypto 短期/噪音市场过滤
        // 如果是 Crypto 或者标题看起来像 Crypto 价格预测
        if (category.includes("crypto") || this.cryptoPattern.test(title)) {
            // 如果包含短时关键词 (15m, 1h, 4h, Daily)，则排除
            if (this.shortTermPattern.test(title)) {
                return false;
            }
        }

        // 4. 流动性过滤
        // 如果流动性数据存在 (>=0) 且小于 $10,000，则排除
        // 注意：有些市场可能暂时没有流动性数据（-1），我们选择暂时保留，观察价格变动是否有意义
        const liquidity = metadata.liquidity ?? metadata.tvl;
        if (liquidity !== undefined && liquidity >= 0 && liquidity < 10000) {
            return false;
        }

        return true;
    }
}
