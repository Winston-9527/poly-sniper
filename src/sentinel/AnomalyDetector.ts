import { MarketUpdate, Anomaly } from "./types.js";

export class AnomalyDetector {
    // 存储每个市场的价格历史：marketId -> [{price, timestamp}]
    private priceHistory: Map<string, { price: number, timestamp: number }[]> = new Map();
    // 存储每个市场的报警次数：marketId -> count
    private alertCounts: Map<string, number> = new Map();
    private threshold: number = 0.05; // 5%
    private windowMs: number = 5 * 60 * 1000; // 5分钟窗口

    constructor(threshold: number = 0.05, windowMinutes: number = 5) {
        this.threshold = threshold;
        this.windowMs = windowMinutes * 60 * 1000;
    }

    /**
     * 处理市场更新并检测异动
     * @param update 市场更新数据
     * @returns 如果检测到异动则返回 Anomaly 对象，否则返回 null
     */
    processUpdate(update: MarketUpdate): Anomaly | null {
        let history = this.priceHistory.get(update.marketId) || [];

        // 添加新记录
        history.push({ price: update.price, timestamp: update.timestamp });

        // 清理过期记录
        const now = update.timestamp;
        history = history.filter(item => now - item.timestamp <= this.windowMs);
        this.priceHistory.set(update.marketId, history);

        if (history.length < 2) {
            return null;
        }

        // 获取窗口内的初始价格（最老的一条记录）
        const firstPrice = history[0].price;
        const currentPrice = update.price;

        // 计算绝对概率变化（百分点）
        const diff = currentPrice - firstPrice;

        if (Math.abs(diff) >= this.threshold) {
            // 检查报警次数限制
            const currentAlertCount = this.alertCounts.get(update.marketId) || 0;
            if (currentAlertCount >= 1) {
                return null;
            }

            // 更新报警次数
            this.alertCounts.set(update.marketId, currentAlertCount + 1);

            const sign = diff >= 0 ? "+" : "";
            return {
                marketId: update.marketId,
                previousPrice: firstPrice,
                currentPrice: currentPrice,
                changePercentage: `${sign}${(diff * 100).toFixed(2)}%`,
                windowMinutes: Math.round(this.windowMs / 60000)
            };
        }

        return null;
    }

    /**
     * 获取市场的当前价格历史长度（用于调试）
     */
    getHistoryCount(marketId: string): number {
        return this.priceHistory.get(marketId)?.length || 0;
    }
}
