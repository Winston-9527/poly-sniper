/**
 * 钱包画像分（透明、可核验）。
 *
 * 明确不参与打分的东西：
 *   - 账户「新旧」/本机首次见到的早晚 —— 那会把「我们刚观察到」误读成「这个人可疑」，
 *     方案 §7 明确禁止把钱包年龄当加分项；
 *   - 胜率/收益率 —— 观察起点之前的建仓成本不完整，算不出来就不编。
 *
 * 只用本机可核验的量：单笔规模分位、覆盖到的市场数、覆盖到的持仓价值、可观察到的活跃时长、
 * 以及「数据覆盖是否完整」（不完整只降分并标注，不假装完整）。
 */
export interface ScoreInput {
    tradeNotional?: { p90?: string | null; samples?: number } | null;
    distinctMarketsInCoverage?: number | null;
    positionValueCovered?: string | null;
    coverage?: { earliestObservedActivity?: string | null; reachedSourceStart?: boolean; truncated?: boolean } | null;
}

export interface ScorePart { label: string; detail: string; points: number }
export interface WalletScore { total: number; parts: ScorePart[]; summary: string; notes: string[] }

function num(v: string | null | undefined): number | null {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

export function scoreWalletProfile(input: ScoreInput, opts: { now?: Date } = {}): WalletScore {
    const parts: ScorePart[] = [];
    const notes: string[] = [];
    const now = opts.now ?? new Date();

    // 1) 单笔规模（0-35）：该钱包 90 天窗口内单笔成交的 p90
    const p90 = num(input.tradeNotional?.p90 ?? null);
    let scale = 0;
    if (p90 !== null) {
        if (p90 >= 50000) scale = 35;
        else if (p90 >= 10000) scale = 25;
        else if (p90 >= 2000) scale = 15;
        else if (p90 >= 500) scale = 8;
    }
    parts.push({ label: '单笔规模', detail: p90 === null ? '未知' : `p90 ${fmtUsdCompact(p90)}`, points: scale });

    // 2) 专注度（0-15）：覆盖到的市场数越少越集中
    const mk = input.distinctMarketsInCoverage ?? null;
    let focus = 0;
    if (mk !== null) {
        if (mk <= 3) focus = 15;
        else if (mk <= 10) focus = 10;
        else if (mk <= 50) focus = 5;
    }
    parts.push({ label: '专注度', detail: mk === null ? '未知' : `${mk} 个市场`, points: focus });

    // 3) 持仓规模（0-25）：只覆盖已取到的快照，不等于全部财富
    const pos = num(input.positionValueCovered ?? null);
    let holding = 0;
    if (pos !== null) {
        if (pos >= 500000) holding = 25;
        else if (pos >= 50000) holding = 18;
        else if (pos >= 10000) holding = 10;
        else if (pos >= 1000) holding = 5;
    } else {
        notes.push('没有完整的持仓快照，持仓分按 0 计（是缺口，不是空仓）');
    }
    parts.push({ label: '持仓', detail: pos === null ? '未取到完整快照' : fmtUsdCompact(pos), points: holding });

    // 4) 可观察到的活跃时长（0-15）
    const earliest = input.coverage?.earliestObservedActivity ?? null;
    let days: number | null = null;
    if (earliest) {
        const t = Date.parse(earliest);
        if (Number.isFinite(t)) days = Math.max(0, (now.getTime() - t) / 86400_000);
    }
    let span = 0;
    if (days !== null) {
        if (days >= 365) span = 15;
        else if (days >= 90) span = 12;
        else if (days >= 30) span = 8;
        else if (days >= 7) span = 4;
    }
    parts.push({ label: '活跃时长', detail: days === null ? '未知' : `${Math.round(days)} 天`, points: span });

    // 5) 数据覆盖（0-10）：取到来源起点且未截断才给满分
    const cov = input.coverage;
    let coverage = 0;
    if (cov?.reachedSourceStart && !cov?.truncated) coverage = 10;
    else if (cov?.earliestObservedActivity) coverage = 3;
    if (cov?.truncated) notes.push('活动历史被截断：分数只代表已获取区间，不代表其全部历史');
    parts.push({ label: '数据覆盖', detail: cov?.truncated ? '被截断' : cov?.reachedSourceStart ? '已到来源起点' : '未到来源起点', points: coverage });

    const total = parts.reduce((a, p) => a + p.points, 0);
    const summary = parts.map((p) => `${p.label} ${p.detail}`).join('｜');
    return { total, parts, summary, notes };
}

/** 紧凑美元（画像分只用于展示，不参与金额口径） */
export function fmtUsdCompact(v: number): string {
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
    if (abs >= 1_000) return `$${(v / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
    return `$${v.toFixed(0)}`;
}
