import { fetch, ProxyAgent } from 'undici';
import {
    AnomalyContext,
    AnomalyDirection,
    CandidateFeatures,
    TradeCandidate,
    TradeRecord,
} from './types.js';

/**
 * 候选池扫描器：把「谁在这个市场真的动过手」从 /holders 快照换成 /trades 成交流。
 *
 * 为什么换：
 *  - 异动是「成交」造成的，而 /holders 只看「此刻持仓前 N 名」。提前埋伏、
 *    异动中平仓跑掉、刚扫货但仓位还没进前列的钱包，在快照里全是隐身的。
 *    实测大市场（≥1000 持仓者 / 700+ 成交钱包）快照口径覆盖率 ≤2~3%。
 *  - /trades 一次 500 笔就带回 side / size / price / timestamp / wallet / token，
 *    3~4 个请求拿到全市场所有动手的钱包，且天然包含 Yes / No 双边。
 *
 * 粗筛全部在本地完成（零额外请求），只把 top-K 送去做链上深挖。
 */

export interface TradeScannerOptions {
    /** 成交回看窗口（小时），默认 72h */
    windowHours: number;
    /** 最多翻多少页 /trades（每页 500 笔），默认 4 页 = 2000 笔 */
    pages: number;
    /** 进入深挖的钱包数上限，默认 25 */
    topK: number;
}

export interface RankedPool {
    candidates: TradeCandidate[];
    poolWallets: number;
    poolTrades: number;
    medianAlignedNotional: number;
}

export function resolveScannerOptions(env: NodeJS.ProcessEnv = process.env): TradeScannerOptions {
    const int = (raw: string | undefined, dflt: number, min = 1) => {
        const n = parseInt(raw ?? '', 10);
        return Number.isFinite(n) && n >= min ? n : dflt;
    };
    const num = (raw: string | undefined, dflt: number) => {
        const n = parseFloat(raw ?? '');
        return Number.isFinite(n) && n > 0 ? n : dflt;
    };
    return {
        windowHours: num(env.TRADE_WINDOW_HOURS, 72),
        pages: int(env.TRADE_SCAN_PAGES, 4),
        topK: int(env.CANDIDATE_TOP_K, 25),
    };
}

/**
 * 判定一笔成交相对异动方向是「同向」还是「反向」。
 *
 * 只需要异常 token + 方向 + 该市场 token 列表：
 *  - 异动 UP：买 anomaly token 同向；卖 anomaly token 反向
 *  - 异动 DOWN：卖 anomaly token 同向；买 anomaly token 反向
 *  - 另一边（非 anomaly token）的成交取镜像
 * 方向未知（手动 /check）时按「买入=同向，卖出=反向」处理。
 */
export function classifyTrade(trade: TradeRecord, ctx: AnomalyContext): 'aligned' | 'opposed' {
    const onAnomalyToken = trade.asset === ctx.anomalyTokenId;
    const buy = String(trade.side).toUpperCase() === 'BUY';
    if (!ctx.direction) return buy ? 'aligned' : 'opposed';
    const up = ctx.direction === 'UP';
    if (onAnomalyToken) return buy === up ? 'aligned' : 'opposed';
    return buy === up ? 'opposed' : 'aligned';
}

function clamp01(x: number): number {
    if (!Number.isFinite(x) || x <= 0) return 0;
    return x >= 1 ? 1 : x;
}

/**
 * 粗筛打分（0~100，纯函数，便于单测）。
 * 权重意图：**顺着异动方向的成交 = 最重要**，其次是进场时点，再是金额/专注度。
 *  - 方向一致度 40：20 × 同向成交额占比 + 20 × 相对规模（对数刻度，池内 100× 中位才拿满）
 *  - 进场时点   25：贴着异动之前越近越高（≤2min 25 分 / ≤1h 17 分 / ≤6h 8 分），异动后追单 2 分
 *  - 出手形态   10：单笔/少笔重仓同向（狙击手形态）或 ≥3 笔持续加仓
 * 两面下注（反向额 ≥ 同向额）视为做市/对冲，乘以 0.4 折扣。
 *
 * 两个刻意的取舍：
 *  1. 「相对规模」用池内中位数归一化，而不是绝对美元数——否则同一套阈值在小市场里
 *     （中位成交 $35）会把 $2k 的普通买单也算成极高信心，所有人都顶格。
 *  2. 「窗口内只出现在该市场」**不参与打分**：成交流是按单个市场拉的，
 *     这个条件对所有钱包恒成立（是死信号）。真实的单市场专注度要走深挖阶段的
 *     activity 历史（事件数），也就是评分器里的 focus 维度。
 */
export function coarseScore(f: CandidateFeatures): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;

    // 1. 方向一致度（40）
    const ratioPoints = 20 * clamp01(f.alignedRatio);
    const convictionPoints = 20 * clamp01(Math.log10(1 + Math.max(0, f.relativeAlignedSize)) / 3);
    score += ratioPoints + convictionPoints;
    if (f.alignedRatio >= 0.8 && f.alignedTrades > 0) {
        reasons.push(`同向成交占比 ${(f.alignedRatio * 100).toFixed(0)}%`);
    }

    // 2. 进场时点（25）
    const lead = f.leadSeconds;
    if (f.alignedTrades === 0) {
        // 没有同向成交，时点分只按首次成交是否早于异动给一点点
        score += lead > 0 ? 3 : 0;
    } else if (lead > 0) {
        if (lead <= 120) score += 25;
        else if (lead <= 600) score += 23;
        else if (lead <= 1800) score += 20;
        else if (lead <= 3600) score += 17;
        else if (lead <= 3 * 3600) score += 12;
        else if (lead <= 6 * 3600) score += 8;
        else if (lead <= 24 * 3600) score += 5;
        else if (lead <= 72 * 3600) score += 2;
        reasons.push(`异动前 ${formatLead(lead)} 已同向进场`);
    } else {
        score += 2;
        reasons.push('异动后才同向跟进');
    }

    // 3. 相对规模（并入方向一致度，这里只补一条人类可读的原因）
    if (f.relativeAlignedSize >= 5 && f.alignedNotionalUsd >= 1000) {
        reasons.push(`同向金额 $${Math.round(f.alignedNotionalUsd).toLocaleString()}（池内中位的 ${f.relativeAlignedSize.toFixed(0)}×）`);
    }

    // 4. 出手形态（10）：狙击手（少笔重仓）与持续加仓（≥3 笔）互斥
    if (f.alignedTrades >= 3) {
        score += 10;
        reasons.push(`同向成交 ${f.alignedTrades} 笔`);
    } else if (f.alignedTrades >= 1 && f.relativeAlignedSize >= 10) {
        score += 10;
        reasons.push('少笔重仓同向');
    } else if (f.alignedTrades === 2) {
        score += 5;
    }

    // 对冲 / 做市折扣
    if (f.opposingNotionalUsd >= f.alignedNotionalUsd && f.opposingNotionalUsd > 0) {
        score *= 0.4;
        reasons.push('双边下注（疑似做市/对冲）');
    } else if (f.opposingNotionalUsd > 0) {
        score -= 5;
    }

    return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

/** 同向成交额的「绝对规模」基准：$2k 起步，避免小市场里 $50 也算 conviction */
const CONVICTION_FLOOR_USD = 2000;

function formatLead(sec: number): string {
    if (sec < 3600) return `${Math.round(sec / 60)}min`;
    if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
    return `${(sec / 86400).toFixed(1)}d`;
}

/**
 * 纯函数：把 /trades 记录聚合成按粗筛分排序的候选列表。
 */
export function rankTrades(
    trades: TradeRecord[],
    ctx: AnomalyContext,
    topK: number,
): RankedPool {
    interface Agg {
        trades: number;
        notional: number;
        alignedNotional: number;
        alignedTrades: number;
        opposingNotional: number;
        firstTs: number;
        lastTs: number;
        firstAlignedTs: number;
        assets: Set<string>;
        markets: Set<string>;
    }
    const byWallet = new Map<string, Agg>();
    let minTs = Number.POSITIVE_INFINITY;
    let maxTs = 0;

    for (const t of trades) {
        const addr = t.proxyWallet;
        if (!addr) continue;
        const notional = (Number(t.size) || 0) * (Number(t.price) || 0);
        const ts = Number(t.timestamp) || 0;
        let agg = byWallet.get(addr);
        if (!agg) {
            agg = {
                trades: 0, notional: 0, alignedNotional: 0, alignedTrades: 0,
                opposingNotional: 0, firstTs: ts, lastTs: ts,
                firstAlignedTs: Number.POSITIVE_INFINITY,
                assets: new Set(), markets: new Set(),
            };
            byWallet.set(addr, agg);
        }
        agg.trades++;
        agg.notional += notional;
        agg.firstTs = Math.min(agg.firstTs, ts);
        agg.lastTs = Math.max(agg.lastTs, ts);
        const marketKey = t.conditionId || t.slug || '';
        if (marketKey) agg.markets.add(marketKey);
        if (t.asset) agg.assets.add(t.asset);

        if (classifyTrade(t, ctx) === 'aligned') {
            agg.alignedNotional += notional;
            agg.alignedTrades++;
            agg.firstAlignedTs = Math.min(agg.firstAlignedTs, ts);
        } else {
            agg.opposingNotional += notional;
        }
        minTs = Math.min(minTs, ts);
        maxTs = Math.max(maxTs, ts);
    }

    const candidates: TradeCandidate[] = [];
    const alignedNotionals: number[] = [];
    for (const agg of byWallet.values()) {
        if (agg.alignedNotional > 0) alignedNotionals.push(agg.alignedNotional);
    }
    alignedNotionals.sort((a, b) => a - b);
    const median = alignedNotionals.length > 0
        ? alignedNotionals[Math.floor(alignedNotionals.length / 2)]
        : 0;
    const sizeBenchmark = Math.max(1, median);

    for (const [address, agg] of byWallet) {
        const firstAlignedTs = Number.isFinite(agg.firstAlignedTs) ? agg.firstAlignedTs : agg.firstTs;
        const features: CandidateFeatures = {
            trades: agg.trades,
            notionalUsd: round2(agg.notional),
            alignedNotionalUsd: round2(agg.alignedNotional),
            alignedTrades: agg.alignedTrades,
            alignedRatio: agg.notional > 0 ? round4(agg.alignedNotional / agg.notional) : 0,
            opposingNotionalUsd: round2(agg.opposingNotional),
            relativeAlignedSize: round2(agg.alignedNotional / sizeBenchmark),
            firstTradeTs: agg.firstTs,
            lastTradeTs: agg.lastTs,
            leadSeconds: Math.round(ctx.anomalyTs - firstAlignedTs),
            side: sideOf(agg.assets, ctx),
            isSingleMarketWallet: agg.markets.size <= 1,
            coarseScore: 0,
            reasons: [],
        };
        const scored = coarseScore(features);
        features.coarseScore = scored.score;
        features.reasons = scored.reasons;
        candidates.push({ address, features });
    }

    candidates.sort((a, b) => b.features.coarseScore - a.features.coarseScore
        || b.features.alignedNotionalUsd - a.features.alignedNotionalUsd);

    return {
        candidates: candidates.slice(0, Math.max(1, topK)),
        poolWallets: byWallet.size,
        poolTrades: trades.length,
        medianAlignedNotional: round2(median),
    };
}

function sideOf(assets: Set<string>, ctx: AnomalyContext): 'YES' | 'NO' | 'BOTH' | 'UNKNOWN' {
    if (assets.size === 0) return 'UNKNOWN';
    if (assets.size > 1) return 'BOTH';
    const only = [...assets][0];
    if (!ctx.tokenIds || ctx.tokenIds.length === 0) return 'UNKNOWN';
    const idx = ctx.tokenIds.indexOf(only);
    if (idx < 0) return 'UNKNOWN';
    return idx === 0 ? 'YES' : 'NO';
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round4 = (x: number) => Math.round(x * 10000) / 10000;

/** 网络层：翻页拉取 /trades（data-api） */
export class TradeScanner {
    private dataApiUrl = 'https://data-api.polymarket.com';
    private dispatcher: any;

    constructor(private options: TradeScannerOptions = resolveScannerOptions()) {
        const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
        if (proxyUrl) this.dispatcher = new ProxyAgent(proxyUrl);
    }

    /**
     * 拉取该市场近 windowHours 的成交（按时间倒序翻页），返回原始记录。
     * 只认 conditionId：/trades?market=<conditionId> 天然覆盖 Yes/No 双边。
     */
    async fetchTrades(conditionId: string, ctx: AnomalyContext): Promise<TradeRecord[]> {
        const cutoff = ctx.anomalyTs - this.options.windowHours * 3600;
        const out: TradeRecord[] = [];
        const pageLimit = 500;
        for (let page = 0; page < this.options.pages; page++) {
            const url = `${this.dataApiUrl}/trades?market=${encodeURIComponent(conditionId)}`
                + `&limit=${pageLimit}&offset=${page * pageLimit}`;
            let batch: TradeRecord[] = [];
            try {
                const res = await fetch(url, {
                    dispatcher: this.dispatcher,
                    // @ts-ignore
                    signal: AbortSignal.timeout(20000),
                });
                if (!res.ok) {
                    console.warn(`[TradeScanner] /trades 返回 ${res.status}，停止翻页`);
                    break;
                }
                const data = await res.json() as any;
                batch = Array.isArray(data) ? data : (data?.data || []);
            } catch (err: any) {
                console.warn(`[TradeScanner] /trades 请求失败: ${err?.message || err}`);
                break;
            }
            if (batch.length === 0) break;
            out.push(...batch);
            const oldest = Math.min(...batch.map(t => Number(t.timestamp) || Number.POSITIVE_INFINITY));
            if (oldest < cutoff) break; // 已经翻出窗口
        }
        return out.filter(t => (Number(t.timestamp) || 0) >= cutoff);
    }

    /** 拉取 + 粗筛排序，一步到位 */
    async scan(conditionId: string, ctx: AnomalyContext): Promise<RankedPool> {
        const trades = await this.fetchTrades(conditionId, ctx);
        return rankTrades(trades, ctx, this.options.topK);
    }
}
