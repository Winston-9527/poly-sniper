import { fetch, ProxyAgent } from 'undici';
import { GammaClient, MarketTokenInfo } from './GammaClient.js';
import { ChainAnalyzer } from './ChainAnalyzer.js';
import { Scorer } from './Scorer.js';
import { TradeScanner } from './TradeScanner.js';
import {
    AnomalyContext,
    AnomalyDirection,
    ProfileReportResult,
    ProfileStats,
    ScoreResult,
} from './types.js';

export interface AnalyzeOptions {
    direction?: AnomalyDirection;
    previousPrice?: number;
    currentPrice?: number;
    /** 异动检测时刻（秒）；缺省用当前时间 */
    anomalyTs?: number;
    /** 关闭阈值过滤，返回所有候选（调试 / CLI 用） */
    includeLowScores?: boolean;
}

/**
 * 画像器（v2）：候选池来自 /trades（全市场成交流、双边），本地粗筛出 top-K 再做链上深挖。
 *
 * 漏斗：全量成交流（0 额外成本）→ 本地粗筛 top-K → 链上深挖（3~4 次调用/钱包）→ 打分 ≥ 阈值。
 * 对比 v1（/holders 前 20 名）：大市场的参与者覆盖率从 ≤2~3% 提到接近 100%，
 * 单次警报的链上请求数从 3000+ 降到百量级。
 */
export class Profiler {
    private readonly concurrency: number;
    private readonly scoreThreshold: number;
    private holdersCache: Map<string, { map: Map<string, number>, ts: number }> = new Map();
    private dispatcher: any;

    constructor(
        private gamma: GammaClient = new GammaClient(),
        private analyzer: ChainAnalyzer = new ChainAnalyzer(),
        private scorer: Scorer = new Scorer(),
        private scanner: TradeScanner = new TradeScanner()
    ) {
        this.concurrency = Math.max(1, parseInt(process.env.PROFILE_CONCURRENCY || '4', 10));
        this.scoreThreshold = parseInt(process.env.SCORE_THRESHOLD || '60', 10);
        const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
        if (proxyUrl) this.dispatcher = new ProxyAgent(proxyUrl);
    }

    async analyzeMarket(
        tokenId: string,
        conditionId?: string,
        currentPrice: number = 0.5,
        options: AnalyzeOptions = {},
    ): Promise<ProfileReportResult> {
        const info = await this.gamma.getTokenPair(conditionId || tokenId);
        const targetConditionId = conditionId || info?.conditionId;

        const ctx: AnomalyContext = {
            anomalyTokenId: tokenId,
            conditionId: targetConditionId,
            tokenIds: info?.tokenIds,
            direction: options.direction,
            previousPrice: options.previousPrice,
            currentPrice: options.currentPrice ?? currentPrice,
            anomalyTs: options.anomalyTs ?? Math.floor(Date.now() / 1000),
            detectedAt: Date.now(),
        };

        const emptyStats: ProfileStats = {
            windowHours: 0, poolWallets: 0, poolTrades: 0, candidates: 0,
            deepProfiled: 0, correlatedWallets: 0, scoreThreshold: this.scoreThreshold,
            resolvableCluster: 0,
        };

        if (!targetConditionId) {
            console.warn(`[Profiler] 未找到市场 Condition ID: ${tokenId}`);
            return { results: [], stats: emptyStats, context: ctx };
        }

        // 1. 候选池：全市场成交流（Yes / No 双边）
        const pool = await this.scanner.scan(targetConditionId, ctx);
        console.log(`[Profiler] 成交流池：${pool.poolTrades} 笔成交 / ${pool.poolWallets} 个钱包 → 粗筛 top-${pool.candidates.length}`);

        if (pool.candidates.length === 0) {
            return {
                results: [],
                stats: { ...emptyStats, poolTrades: pool.poolTrades, poolWallets: pool.poolWallets },
                context: ctx,
            };
        }

        // 2. 持仓快照（1 次请求）用于计算持仓价值；失败则回退到窗口内成交额
        const holdings = await this.getHoldingsMap(targetConditionId);

        // 3. top-K 深挖（限并发）
        const profiles = await mapLimit(pool.candidates, this.concurrency, async (candidate) => {
            try {
                const activity = await this.gamma.getActivityProfile(candidate.address);
                const profile = await this.analyzer.getProfile(candidate.address, {
                    firstActivityTs: activity.firstActivityTs,
                    oldestActivityTxHash: activity.firstActivityTxHash,
                    activityCount: activity.count,
                    firstActivityTruncated: activity.truncated,
                });
                profile.eventCount = activity.distinctEvents;
                profile.marketCount = activity.distinctMarkets;
                return { candidate, profile };
            } catch (err) {
                console.error(`[Profiler] 深挖失败 ${candidate.address}:`, (err as Error).message);
                return null;
            }
        });
        const deep = profiles.filter((x): x is NonNullable<typeof x> => x !== null);

        // 4. 同源资金聚类（跨候选 + 跨历史缓存）：同一 owner EOA / 同一注资地址
        const clusterCount = new Map<string, number>();
        for (const { profile } of deep) {
            if (!profile.clusterKey) continue;
            if (this.analyzer.isCommonClusterKey(profile.clusterKey, profile.clusterKeySource)) continue;
            clusterCount.set(profile.clusterKey, (clusterCount.get(profile.clusterKey) || 0) + 1);
        }
        // 把「本机历史上也关联过其他钱包」的键算进来（clusterSize 含历史）
        for (const { profile } of deep) {
            if (!profile.clusterKey) continue;
            if (this.analyzer.isCommonClusterKey(profile.clusterKey, profile.clusterKeySource)) continue;
            const historical = this.analyzer.getClusterSize(profile.clusterKey);
            clusterCount.set(profile.clusterKey, Math.max(clusterCount.get(profile.clusterKey) || 1, historical));
        }
        const correlatedWallets = [...clusterCount.values()].filter(n => n > 1).reduce((a, b) => a + b, 0);

        // 5. 打分
        const results: ScoreResult[] = [];
        for (const { candidate, profile } of deep) {
            const holdingValue = (holdings.get(candidate.address.toLowerCase()) || 0) * (ctx.currentPrice ?? currentPrice);
            const positionValue = holdingValue > 0 ? holdingValue : candidate.features.alignedNotionalUsd;
            const isCorrelated = !!profile.clusterKey
                && !this.analyzer.isCommonClusterKey(profile.clusterKey, profile.clusterKeySource)
                && (clusterCount.get(profile.clusterKey) || 0) > 1;

            const scored = this.scorer.score(profile, positionValue, {
                isCorrelated,
                features: candidate.features,
                fundingClusterSize: profile.fundingClusterSize,
            });
            if (options.includeLowScores || scored.totalScore >= this.scoreThreshold) {
                results.push(scored);
            }
        }
        results.sort((a, b) => b.totalScore - a.totalScore);

        const stats: ProfileStats = {
            windowHours: this.scannerWindowHours(),
            poolWallets: pool.poolWallets,
            poolTrades: pool.poolTrades,
            candidates: pool.candidates.length,
            deepProfiled: deep.length,
            correlatedWallets,
            scoreThreshold: this.scoreThreshold,
            resolvableCluster: deep.filter(d => !!d.profile.clusterKey).length,
        };
        console.log(`[Profiler] 深挖 ${stats.deepProfiled}/${stats.candidates} 个钱包（同源键可解析 ${stats.resolvableCluster}），`
            + `${stats.correlatedWallets} 个命中共用注资源，≥${this.scoreThreshold} 分 ${results.length} 个。`);

        return { results, stats, context: ctx };
    }

    /** 该市场各钱包的当前持仓（tokenId 无关，按 proxyWallet 汇总份额） */
    private async getHoldingsMap(conditionId: string): Promise<Map<string, number>> {
        const cached = this.holdersCache.get(conditionId);
        if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.map;
        const map = new Map<string, number>();
        try {
            const url = `https://data-api.polymarket.com/holders?market=${encodeURIComponent(conditionId)}&limit=1000`;
            const res = await fetch(url, {
                dispatcher: this.dispatcher,
                // @ts-ignore
                signal: AbortSignal.timeout(20000),
            });
            if (res.ok) {
                const data = await res.json() as any[];
                for (const token of data || []) {
                    for (const h of token.holders || []) {
                        const addr = (h.proxyWallet || h.userAddress || '').toLowerCase();
                        if (!addr) continue;
                        map.set(addr, (map.get(addr) || 0) + (parseFloat(h.amount) || 0));
                    }
                }
            }
        } catch {
            // 拿不到持仓就回退到成交额
        }
        this.holdersCache.set(conditionId, { map, ts: Date.now() });
        return map;
    }

    private scannerWindowHours(): number {
        const n = parseFloat(process.env.TRADE_WINDOW_HOURS || '72');
        return Number.isFinite(n) ? n : 72;
    }
}

/** 简易并发池 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let cursor = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
        while (true) {
            const idx = cursor++;
            if (idx >= items.length) return;
            out[idx] = await fn(items[idx]);
        }
    });
    await Promise.all(workers);
    return out;
}
