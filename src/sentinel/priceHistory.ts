type PricePoint = {
    price: number;
    timestamp: number;
};

// 价格历史窗口（毫秒）
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
// 价格采样间隔（毫秒）
const HISTORY_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
// 单市场最多保留点数
const HISTORY_MAX_POINTS = 400;

const priceHistory = new Map<string, PricePoint[]>();

export function recordPrice(marketId: string, price: number, timestamp: number = Date.now()) {
    const history = priceHistory.get(marketId) || [];
    const last = history[history.length - 1];
    if (last) {
        const tooSoon = timestamp - last.timestamp < HISTORY_SAMPLE_INTERVAL_MS;
        const samePrice = last.price === price;
        if (tooSoon && samePrice) {
            return;
        }
    }
    history.push({ price, timestamp });
    const cutoff = timestamp - HISTORY_WINDOW_MS;
    const filtered = history.filter(point => point.timestamp >= cutoff);
    if (filtered.length > HISTORY_MAX_POINTS) {
        priceHistory.set(marketId, filtered.slice(filtered.length - HISTORY_MAX_POINTS));
    } else {
        priceHistory.set(marketId, filtered);
    }
}

export function getPriceTrend(marketId: string) {
    const history = priceHistory.get(marketId);
    if (!history || history.length === 0) {
        return null;
    }
    const first = history[0];
    const last = history[history.length - 1];
    if (!first || !last) {
        return null;
    }
    const diff = last.price - first.price;
    const sign = diff >= 0 ? "+" : "";
    const changePercentage = `${sign}${(diff * 100).toFixed(2)}%`;
    return {
        firstPrice: first.price,
        lastPrice: last.price,
        changePercentage,
        windowMinutes: Math.round(HISTORY_WINDOW_MS / 60000),
        samples: history.length,
        firstTimestamp: first.timestamp,
        lastTimestamp: last.timestamp
    };
}
