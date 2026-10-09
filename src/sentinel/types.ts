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
    liquidity?: number; // 流动性
    volume24hr?: number; // 24 小时成交量（过滤门槛用）
}

export interface UserActivity {
    timestamp: number;
    type: string; // "TRADE", etc.
    slug?: string;
    eventSlug?: string; // 用于归类相似市场
    marketId?: string;
    asset?: string;
    side?: string;
    size?: number;
    usdcSize?: number;
    transactionHash?: string;
}

export interface Holder {
    address: string;
    balance: number; // 持仓量
}

/**
 * data-api `/trades` 的原始记录（只保留会用到的字段）。
 * 这是「谁在这个市场真的动过手」的唯一权威来源：一笔成交 = 一次真实的建仓动作，
 * 而 /holders 只是「此刻还拿着仓位的人」的快照。
 */
export interface TradeRecord {
    proxyWallet: string;
    side: string; // BUY / SELL
    asset: string; // 成交的 tokenId
    conditionId: string;
    size: number; // 份额
    price: number;
    timestamp: number; // 秒
    outcome?: string;
    outcomeIndex?: number;
    transactionHash?: string;
    title?: string;
    slug?: string;
    eventSlug?: string;
}

export type AnomalyDirection = "UP" | "DOWN";

/** 一次异动的上下文：画像器据此判断「谁顺着异动方向下了注」 */
export interface AnomalyContext {
    anomalyTokenId: string;
    conditionId?: string;
    /** 该市场全部 tokenId（双边），用于把「另一边」的成交也识别出来 */
    tokenIds?: string[];
    direction?: AnomalyDirection;
    previousPrice?: number;
    currentPrice?: number;
    /** 异动检测时刻（秒，与 /trades 的 timestamp 同单位） */
    anomalyTs: number;
    detectedAt: number; // ms
}

/** 粗筛特征：全部由 /trades 本地计算，零额外请求 */
export interface CandidateFeatures {
    trades: number;
    notionalUsd: number;
    alignedNotionalUsd: number;
    alignedTrades: number;
    alignedRatio: number;
    opposingNotionalUsd: number;
    /** 同向成交额 / 该市场成交流中位数（池内相对规模，跨市场可比） */
    relativeAlignedSize: number;
    firstTradeTs: number;
    lastTradeTs: number;
    /** 首笔顺着异动方向的成交比异动早多少秒（<=0 表示异动之后才追） */
    leadSeconds: number;
    side: "YES" | "NO" | "BOTH" | "UNKNOWN";
    /** 窗口内该钱包只出现在这一个市场 */
    isSingleMarketWallet: boolean;
    coarseScore: number;
    reasons: string[];
}

export interface TradeCandidate {
    address: string;
    features: CandidateFeatures;
}

export interface WalletProfile {
    address: string;
    transactionCount: number;
    usdcBalance: number;
    marketCount: number;
    eventCount?: number; // 唯一事件数
    isNew: boolean;
    /** 链上首笔交易时间 (seconds)，拿不到就是 undefined —— 不要再造模拟值 */
    onchainFirstTxTs?: number;
    /** Polymarket 首次活动时间 (seconds)，来自 /activity?sortDirection=ASC */
    firstActivityTs?: number;
    /** 本机第一次见到该钱包的时间 (seconds)，长期缓存兜底 */
    localFirstSeenTs?: number;
    /** 首次观察到的最早活动是否会话被截断（>=limit 条时无法确定真实首笔） */
    firstActivityTruncated?: boolean;
    /** 首次注资来源（兜底 USDC 日志扫描得到的入金 tx.from） */
    fundingAddress?: string;
    /** 代理钱包的 owner EOA（Polymarket proxy 的签名者，同源聚类的主键） */
    ownerAddress?: string;
    /** owner 读取方式：proxy-owner / proxy-getOwners */
    ownerKind?: string;
    /** 实际用于同源聚类的键（ownerAddress 优先，否则 fundingAddress） */
    clusterKey?: string;
    clusterKeySource?: 'owner' | 'funding';
    /** 与该钱包共用同一个 clusterKey 的其他钱包数（不含自己） */
    fundingClusterSize?: number;
}

export interface ScoreResult {
    address: string;
    totalScore: number;
    profile: WalletProfile;
    positionValue: number;
    features?: CandidateFeatures;
    breakdown: {
        tradeSignal: number; // 30% - 成交行为（顺着异动方向、进场时点、金额）
        freshness: number;   // 20%
        focus: number;       // 15%
        correlation: number; // 15%
        position: number;    // 10%
        capital: number;     // 10%
    };
    details: string[];
}

/** 一次画像的漏斗统计，用于日志 / 报告里说明覆盖率 */
export interface ProfileStats {
    windowHours: number;
    poolWallets: number;   // /trades 里的唯一钱包（双边）
    poolTrades: number;    // /trades 取到的成交笔数
    candidates: number;    // 粗筛后进入深挖的钱包数
    deepProfiled: number;  // 深挖成功的钱包数
    correlatedWallets: number; // 命中共用注资源的钱包数
    scoreThreshold: number;
    resolvableCluster: number; // 成功解析出同源键（owner/注资）的钱包数
}

export interface ProfileReportResult {
    results: ScoreResult[];
    stats: ProfileStats;
    context: AnomalyContext;
}
