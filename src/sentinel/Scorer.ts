import { CandidateFeatures, ScoreResult, WalletProfile } from './types.js';
import { coarseScore } from './TradeScanner.js';

export interface ScoreOptions {
    /** 是否与其他候选钱包共用同一个注资源 */
    isCorrelated?: boolean;
    /** 该钱包在本次异动市场里的成交行为（粗筛特征） */
    features?: CandidateFeatures;
    /** 该注资源累计关联的钱包数（用于在报告里说明「团伙」规模） */
    fundingClusterSize?: number;
}

/**
 * 钱包打分器（v2，满分 100）。
 *
 * 与 v1 的差别：
 *  - v1 的 5 个维度里，真正能生效的只有「新号 + 单市场」两维：
 *    correlation 因为 fundingAddress 常量 undefined 恒为 0；
 *    freshness 的兜底分支（Tx<5、Tx<20）对合约 proxyWallet 恒成立（合约 nonce 恒为 0），
 *    于是「最近 50 条 activity 里最老的一条」这个近似把活跃老号也算成了新号。
 *  - v2 新增**成交行为维度（30 分，权重最高）**：谁顺着异动方向下注、进场时点是否在异动之前、
 *    同向金额有多大。异动本身是「成交」造成的，所以这一维才应该是最强的信号。
 *
 * 权重：成交行为 30 / 新鲜度 20 / 专注度 15 / 同源资金 15 / 仓位 10 / 资金 10。
 */
export class Scorer {
    score(profile: WalletProfile, positionValue: number, opts: ScoreOptions = {}): ScoreResult {
        const { isCorrelated = false, features } = opts;
        const details: string[] = [];

        // 1. 成交行为（30）：直接复用粗筛打分，保证「排序依据」与「报告分数」同源
        let tradeSignal = 0;
        if (features) {
            tradeSignal = Math.round(coarseScore(features).score * 0.30);
            details.push(...features.reasons);
        } else {
            details.push('无成交流数据（回退到持仓快照）');
        }

        // 2. 新鲜度（20）：只认真实首次活动时间，宁可为 0 也不送分
        let freshness = 0;
        const firstTs = profile.firstActivityTs ?? profile.localFirstSeenTs;
        if (firstTs) {
            const ageHours = (Date.now() / 1000 - firstTs) / 3600;
            if (ageHours < 24) { freshness = 20; details.push('Brand New (<24h)'); }
            else if (ageHours < 48) { freshness = 15; details.push('Very New (<48h)'); }
            else if (ageHours < 168) { freshness = 10; details.push('New (<1w)'); }
            else if (ageHours < 720) { freshness = 5; details.push('Recent (<1mo)'); }
            else { details.push(`Established (${Math.round(ageHours / 24)}d)`); }
        } else {
            details.push('首次活动时间未知（不送新鲜度分）');
        }

        // 3. 专注度（15）：单事件/单市场账户；未知一律 0
        let focus = 0;
        const focusCount = profile.eventCount && profile.eventCount > 0
            ? profile.eventCount
            : (profile.marketCount > 0 ? profile.marketCount : undefined);
        if (focusCount !== undefined) {
            if (focusCount === 1) { focus = 15; details.push('Single Event/Market Focus'); }
            else if (focusCount <= 3) { focus = 8; details.push(`High Focus (${focusCount} events)`); }
            else { details.push(`${focusCount} 个事件（低专注度）`); }
        }

        // 4. 同源资金（15）：真正生效的团伙维度（同一 owner EOA / 同一注资地址）
        let correlation = 0;
        const clusterKey = profile.clusterKey;
        if (isCorrelated && clusterKey) {
            correlation = 15;
            const n = opts.fundingClusterSize ?? profile.fundingClusterSize ?? 1;
            const label = profile.clusterKeySource === 'owner' ? '同一 owner EOA' : '同一注资地址';
            details.push(`${label} ${short(clusterKey)}（关联 ${n + 1} 个钱包）`);
        }

        // 5. 本市场仓位（10）
        let position = 0;
        if (positionValue >= 50000) { position = 10; details.push('Heavy Position (>$50k)'); }
        else if (positionValue >= 10000) { position = 7; details.push('Large Position (>$10k)'); }
        else if (positionValue >= 1000) { position = 3; details.push('Medium Position (>$1k)'); }

        // 6. 资金储备（10）
        let capital = 0;
        if (profile.usdcBalance >= 50000) { capital = 10; details.push('High Capital (>$50k)'); }
        else if (profile.usdcBalance >= 10000) { capital = 5; details.push('Good Capital (>$10k)'); }

        const totalScore = tradeSignal + freshness + focus + correlation + position + capital;

        return {
            address: profile.address,
            totalScore,
            profile,
            positionValue,
            features,
            breakdown: { tradeSignal, freshness, focus, correlation, position, capital },
            details,
        };
    }
}

function short(addr: string): string {
    return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '';
}
