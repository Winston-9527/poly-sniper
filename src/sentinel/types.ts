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
}

export interface MarketMetadata {
    marketId: string;
    category: string;
    title: string;
    slug?: string;
    outcome?: string;
    conditionId?: string;
    liquidity?: number; // 新增：流动性
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

