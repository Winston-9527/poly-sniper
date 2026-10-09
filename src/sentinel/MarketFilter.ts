import { MarketMetadata } from "./types";

/**
 * 市场过滤器：决定一个市场是否值得进入异动监控 / 推送。
 *
 * 实测依据（对喂价接口 18,355 个市场的统计 + 1,783 条噪音警报回放）：
 *  - 流动性中位 $811、24h 成交量中位 $0，长尾极重
 *  - 流动性 < $25k 的市场贡献了 100% 的已观测噪音
 *  - 24h 成交量门槛（默认 $1k）在本机实测把监控面从 1,472 收到 405 个市场
 *  - 分钟/小时级重复市场（BTC 5 分钟、Up or Down - 系列）、天气/气象市场单独排除
 * 所有门槛可用环境变量覆盖：MIN_LIQUIDITY / MIN_VOLUME_24H
 */
export class MarketFilter {
    // 硬门槛
    private minLiquidity: number;
    private minVolume24h: number;

    // 强制排除的类别
    private excludedCategories: string[] = ["Sports"];

    // 分钟/小时级重复市场：标题里带同日时间区间，如 "Bitcoin Up or Down - Dec 19, 11:35AM-11:40AM ET"
    private intradayPattern = /\d{1,2}(:\d{2})?\s*[AP]M\s*[-–~]\s*\d{1,2}(:\d{2})?\s*[AP]M/i;
    // "X Up or Down - ..." 短线系列（加密、金属、天然气、外汇等）
    private upOrDownPattern = /\bup or down\s*[-–]/i;
    // 短周期价格类市场（5 分钟 / 1 小时 / 4 小时 / 日内）
    private shortTermPattern = /(\b5\s*m(in)?\b|\b5m\b|15\s*m(in)?\b|\b1\s*h(our)?\b|\b4\s*h(our)?\b|hourly|Daily)/i;
    private cryptoPattern = /(Bitcoin|BTC|Ethereum|ETH|Solana|SOL|XRP|Dogecoin|DOGE|BNB|Hyperliquid|Natural Gas|Crude Oil)/i;
    // 天气 / 气象市场（温度、降水、降雪、降雨；用词边界避免误伤 "Braintree"、"Kendal Tornado FC"）
    private weatherPattern = /(?:highest|lowest|average)\s+temperature|temperature\s+(?:in|at)\s|\d+\s*°\s*[FC]|inches of snow|\bsnow\b|\brain\b|rainfall|precipitation|\bwill it\s+(?:rain|snow)\b/i;
    // 强制保留：Pre-market
    private preMarketPattern = /Pre-market|Premarket/i;

    constructor() {
        this.minLiquidity = parseFloat(process.env.MIN_LIQUIDITY || "25000");
        this.minVolume24h = parseFloat(process.env.MIN_VOLUME_24H || "1000");
    }

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

        // 3. 高频 / 重复市场排除
        if (this.intradayPattern.test(title)) return false;        // 分钟/小时级重复盘口
        if (this.upOrDownPattern.test(title)) return false;        // Up or Down - 短线系列
        if (this.weatherPattern.test(title)) return false;         // 天气 / 气象
        if (this.cryptoPattern.test(title) && this.shortTermPattern.test(title)) return false; // 加密短周期

        // 4. 流动性 / 24h 成交量门槛（缺数据一律不推送，等元数据补齐）
        const liquidity = metadata.liquidity;
        if (typeof liquidity !== "number" || !isFinite(liquidity) || liquidity < this.minLiquidity) {
            return false;
        }
        const volume24hr = metadata.volume24hr;
        if (typeof volume24hr !== "number" || !isFinite(volume24hr) || volume24hr < this.minVolume24h) {
            return false;
        }

        return true;
    }
}
