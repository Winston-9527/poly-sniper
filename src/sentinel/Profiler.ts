import { GammaClient } from './GammaClient.js';
import { ChainAnalyzer } from './ChainAnalyzer.js';
import { Scorer } from './Scorer.js';
import { ScoreResult } from './types.js';

// 画像入选阈值（分数越高越严格）
const PROFILER_MIN_SCORE = 0;

export class Profiler {
    constructor(
        private gamma: GammaClient = new GammaClient(),
        private analyzer: ChainAnalyzer = new ChainAnalyzer(),
        private scorer: Scorer = new Scorer()
    ) { }

    async warmup() {
        await this.analyzer.checkRpcHealth();
    }

    /**
     * 分析特定市场的持仓者
     * @param tokenId Polymarket Token ID
     * @param conditionId Optional Condition ID (if known) to bypass Gamma lookup
     * @param currentPrice 当前代币价格 (用于计算持仓价值)
     * @returns 满足阈值的钱包列表
     */
    async analyzeMarket(tokenId: string, conditionId?: string, currentPrice: number = 0.5): Promise<ScoreResult[]> {
        console.log(`[Profiler] 正在分析市场持仓者: ${tokenId} (价格: ${currentPrice})`);
        const minScore = PROFILER_MIN_SCORE;

        let targetConditionId = conditionId;

        // 1. 如果未提供 conditionId，尝试获取市场元数据
        if (!targetConditionId) {
            const metadata = await this.gamma.getMarketMetadataByTokenId(tokenId);
            if (metadata && metadata.conditionId) {
                targetConditionId = metadata.conditionId;
            }
        }

        if (!targetConditionId) {
            console.warn(`[Profiler] 未找到对应的市场元数据 (Condition ID): ${tokenId}`);
            return [];
        }

        // 2. 获取 Top 持仓者
        const holders = await this.gamma.getTopHolders(targetConditionId, tokenId, 20);
        if (holders.length === 0) {
            console.log(`[Profiler] 未找到持仓者数据: ${tokenId}`);
            return [];
        }

        console.log(`[Profiler] 找到 ${holders.length} 个持仓者，开始分析画像...`);

        // 3. 收集所有钱包画像
        const profilesWithHoldings: { profile: any, balance: number }[] = [];

        // 限制并发以防 RPC 报错
        for (const holder of holders) {
            try {
                // 1. 获取基础画像 (On-chain)
                const profile = await this.analyzer.getProfile(holder.address);

                // 2. 增强画像 (Off-chain Data API)
                // 原始 RPC Nonce 不准，使用 Polymarket Activity 修正活跃度和市场数
                const activityLimit = 50;
                const activities = await this.gamma.getUserActivity(holder.address, activityLimit);

                // 修正交易次数: 取 RPC Nonce 和 Activity Log Length 的较大值
                // 如果 Activity 拿满了50条，说明非常活跃，直接覆盖
                if (activities.length > 0) {
                    profile.transactionCount = Math.max(profile.transactionCount, activities.length);
                    profile.activitySampledCount = activities.length;
                    profile.activitySampledLimit = activityLimit;
                    profile.activityCountCapped = activities.length >= activityLimit;
                    // 估算首次活跃时间
                    // Activity API 返回通常是倒序 (最新的在前)，所以取最后一个作为"最早观察到的时间"
                    const oldestActivity = activities[activities.length - 1];
                    if (oldestActivity && oldestActivity.timestamp) {
                        profile.firstSeenTimestamp = oldestActivity.timestamp;
                    }
                    // 修正市场数
                    // 根据 slug 或 conditionId 统计唯一市场
                    const uniqueMarkets = new Set(activities.map(a => a.slug).filter(slug => !!slug));
                    const uniqueEvents = new Set(activities.map(a => a.eventSlug).filter(slug => !!slug));

                    if (uniqueMarkets.size > 0) {
                        profile.marketCount = Math.max(profile.marketCount, uniqueMarkets.size);
                        // Store eventCount in profile (if property exists, need to ensure types.ts update propagates)
                        profile.eventCount = uniqueEvents.size;
                        console.log(`[Profiler] ${holder.address} 市场修正: MarketCount -> ${profile.marketCount} (Events: ${uniqueEvents.size})`);
                    }
                }

                profilesWithHoldings.push({ profile, balance: holder.balance });
            } catch (err) {
                console.error(`[Profiler] 分析钱包失败 ${holder.address}:`, err);
            }
        }

        // 4. 分析关联性 (同源资金检测)
        const fundingSources = new Map<string, number>();
        profilesWithHoldings.forEach(item => {
            if (item.profile.fundingAddress) {
                const count = fundingSources.get(item.profile.fundingAddress) || 0;
                fundingSources.set(item.profile.fundingAddress, count + 1);
            }
        });

        const results: ScoreResult[] = [];

        // 5. 打分
        for (const item of profilesWithHoldings) {
            const positionValue = item.balance * currentPrice;

            // 检查是否与其他钱包共享资金源 (Count > 1)
            let isCorrelated = false;
            if (item.profile.fundingAddress) {
                const sourceCount = fundingSources.get(item.profile.fundingAddress) || 0;
                if (sourceCount > 1) {
                    isCorrelated = true;
                }
            }

            const scoreResult = this.scorer.score(item.profile, positionValue, isCorrelated);

            if (scoreResult.totalScore >= minScore) {
                results.push({
                    ...scoreResult,
                    profile: item.profile
                });
            }
        }

        if (profilesWithHoldings.length > 0) {
            console.log(`[Profiler] 画像筛选阈值: ${minScore}，持仓数: ${profilesWithHoldings.length}，入选数: ${results.length}`);
        }

        // 按分数降序排列
        return results.sort((a, b) => b.totalScore - a.totalScore);
    }
}
