export interface MarketUpdate {
    marketId: string;
    price: number;
    timestamp: number;
}

export interface Anomaly {
    marketId: string;
    previousPrice: number;
    currentPrice: number;
    changePercentage: string;
    windowMinutes?: number;
}

export interface MarketMetadata {
    marketId: string;
    category: string;
    title: string;
    slug?: string;
    outcome?: string;
    conditionId?: string;
    liquidity?: number; // 流动性（Gamma/Polymarket market liquidity）
    tvl?: number; // 事件级 TVL/Volume（来自 Polymarket event API）
    volume?: number; // 市场累计成交额
}

export interface UserActivity {
    timestamp: number;
    type: string; // "TRADE", etc.
    slug?: string;
    eventSlug?: string; // 新增: 用于归类相似市场
    marketId?: string;
    asset?: string;
    side?: string;
    size?: number;
    usdcSize?: number;
}

export interface Holder {
    address: string;
    balance: number; // 持仓量
}

export interface WalletProfile {
    address: string;
    transactionCount: number;
    usdcBalance: number;
    marketCount: number;
    eventCount?: number; // 新增: 唯一事件数
    isNew: boolean;
    fundingAddress?: string; // 第一笔入金来源地址
    firstSeenTimestamp?: number; // 首次活动时间 (seconds)
    activitySampledCount?: number; // Activity API 返回条数
    activitySampledLimit?: number; // Activity API 请求上限
    activityCountCapped?: boolean; // 是否达到采样上限
}

export interface ScoreResult {
    address: string;
    totalScore: number;
    profile: WalletProfile;
    positionValue: number;
    breakdown: {
        freshness: number;  // 30%
        focus: number;      // 30%
        position: number;   // 20%
        correlation: number;// 10%
        capital: number;    // 10%
    };
    details: string[];
}

export interface AnomalyWebhookPayload {
    eventType: "market.anomaly";
    detectedAt: number;
    anomaly: Anomaly;
    market: MarketMetadata;
    source: "sentinel";
}
