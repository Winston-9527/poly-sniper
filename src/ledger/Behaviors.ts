/**
 * 行为识别与优先级（方案 §7.2、§7.3）。纯函数，便于确定性测试。
 *
 * 原则：
 *   - 「事实」与「推断」分开：magnitude 只放可核验数字，推断写在 reason/表述里。
 *   - 优先级与数据质量分开展示；数据缺失不等于低风险，也绝不反向加分。
 *   - 不使用钱包年龄作为加分项（方案 §10：修复「未知年龄仍加分」）。
 *   - 买卖两侧只是输入事实，不直接推断做市/对冲；减仓不自动解释为止盈止损。
 */
import { Dec, ZERO, cmp, decToString, div, mul, sub, pctString, decToNumber } from '../util/decimal.js';

export type BehaviorType =
    | 'position_opened' | 'position_increased' | 'position_reduced' | 'position_exited'
    | 'reactivated' | 'capital_in' | 'capital_out' | 'unexplained_change';
export type DataQuality = 'verified' | 'partial' | 'incomplete';
export type Priority = 'high' | 'medium' | 'low';

export interface ChangeForBehavior {
    wallet: string;
    conditionId: string;
    tokenId: string;
    outcome: string | null;
    episodeId: number;
    episodeOpenedAt: string;
    kind: string;
    quantified: boolean;
    deltaSize: Dec | null;
    sizeBefore: Dec | null;
    sizeAfter: Dec | null;
    cashDelta: Dec | null;
    price: Dec | null;
    reachedZero: boolean;
    oversold: boolean;
    eventAt: string;
    ledgerEntryIds: number[];
    /** 来源类型未支持精确归因时置 true */
    unsupportedSource: boolean;
}

export interface PriorityRules {
    absoluteNotionalFloor: number;
    reducePctThreshold: number;
    relativeSizeMultiplier: number;
    reactivationHours: number;
    alertCooldownMinutes: number;
    /** 新出现持仓达到「绝对下限 × 该倍数」即判高优先级（不依赖账户年龄或同源关系） */
    openHighMultiplier: number;
}

export interface BehaviorOut {
    eventType: BehaviorType;
    magnitude: string;
    evidence: string;
    dataQuality: DataQuality;
    priority: Priority;
    priorityReason: string;
    dedupeKey: string;
    eventAt: string;
    observedAt: string;
    ruleVersion: string;
    wallet: string;
    conditionId: string;
    tokenId: string;
}

const notionalOf = (delta: Dec | null, price: Dec | null): Dec | null => (delta === null || price === null ? null : mul(delta < 0n ? -delta : delta, price));

/**
 * 订单拆单聚合（方案 §7.1）：同一钱包、同一 token、同一方向、且在聚合窗口内的多笔成交
 * 视为一次行为决策，保留原始顺序与笔数。窗口是配置假设，报文里必须写明。
 */
export function aggregateFills<T extends { wallet: string; tokenId: string; kind: string; eventAt: string }>(items: T[], windowMinutes: number): (T & { groupIndex: number; groupSize: number; aggregated: boolean })[] {
    const sorted = [...items].sort((a, b) => Date.parse(a.eventAt) - Date.parse(b.eventAt));
    const out: (T & { groupIndex: number; groupSize: number; aggregated: boolean })[] = [];
    let g = -1, lastKey = '', lastAt = 0;
    for (const it of sorted) {
        const key = `${it.wallet}|${it.tokenId}|${it.kind}`;
        const at = Date.parse(it.eventAt);
        if (key !== lastKey || at - lastAt > windowMinutes * 60_000) { g++; }
        lastKey = key; lastAt = at;
        out.push({ ...it, groupIndex: g, groupSize: 0, aggregated: false });
    }
    const sizes = new Map<number, number>();
    for (const o of out) sizes.set(o.groupIndex, (sizes.get(o.groupIndex) ?? 0) + 1);
    return out.map((o) => ({ ...o, groupSize: sizes.get(o.groupIndex) ?? 1, aggregated: (sizes.get(o.groupIndex) ?? 1) > 1 }));
}

/** 把「份数变化」翻译成行为类型 */
export function classifyChange(c: ChangeForBehavior): BehaviorType | null {
    if (c.unsupportedSource || (!c.quantified && c.kind === 'unexplained')) return 'unexplained_change';
    if (c.oversold) return 'unexplained_change';
    if (!c.quantified || c.deltaSize === null) return null;
    const delta = c.deltaSize;
    if (cmp(delta, ZERO) > 0) return c.sizeBefore !== null && cmp(c.sizeBefore, ZERO) === 0 ? 'position_opened' : 'position_increased';
    if (cmp(delta, ZERO) < 0) {
        // 「退出」只在推导份数归零时成立；部分卖出永远是减仓（方案 §12）
        if (c.reachedZero) return 'position_exited';
        return 'position_reduced';
    }
    return null;
}

export interface PriorityInput {
    eventType: BehaviorType;
    notional: Dec | null;
    /** 本次变化相对该钱包历史典型规模的倍数（样本足够时才有值） */
    relativeMultiplier: Dec | null;
    /** 相对自身持仓的变化比例 */
    positionChangeRatio: Dec | null;
    dataQuality: DataQuality;
    /** 是否首次改变长期行为（如长期持有人首次减仓） */
    firstTimeLongTermChange: boolean;
    rules: PriorityRules;
}

/**
 * 可解释优先级规则（版本见 config.RULES_VERSION）。**先过绝对规模下限，再看相对变化**：
 *   高：名义金额 ≥ 绝对下限 且（自身持仓变化 ≥ 50% 或 ≥ 3 倍历史典型规模；
 *       新出现持仓 ≥ 3 倍下限；本地址退出且 ≥ 下限）
 *   中：名义金额 ≥ 绝对下限 且（自身持仓变化 ≥ reducePctThreshold 或 ≥ 2 倍历史典型规模 或 ≥ 2 倍下限）
 *   低：其余（记录但不推送 —— 方案 §7.3：没达到优先级的原始事件仍然存储）
 * 数据质量不参与优先级打分，只在报告中单独展示；钱包年龄不参与打分。
 */
export function computePriority(input: PriorityInput): { priority: Priority; reason: string } {
    const floor = input.rules.absoluteNotionalFloor;
    const notionalNum = input.notional === null ? null : decToNumber(input.notional)!;
    const relNum = input.relativeMultiplier === null ? null : decToNumber(input.relativeMultiplier)!;
    const pctNum = input.positionChangeRatio === null ? null : Math.abs(decToNumber(input.positionChangeRatio)!);
    const parts: string[] = [];

    if (notionalNum === null) {
        return { priority: 'low', reason: '名义金额未知（缺少价格或份数），不凭猜测升级优先级' };
    }
    const bigEnough = notionalNum >= floor;
    const bigMove = pctNum !== null && pctNum >= 0.5;
    const bigRelative = relNum !== null && relNum >= input.rules.relativeSizeMultiplier;
    const midMove = pctNum !== null && pctNum >= input.rules.reducePctThreshold;
    const midRelative = relNum !== null && relNum >= 2;
    const openBig = input.eventType === 'position_opened' && notionalNum >= floor * input.rules.openHighMultiplier;

    if (openBig) {
        return { priority: 'high', reason: `新出现持仓，名义金额 ≥ ${input.rules.openHighMultiplier} 倍绝对下限（${floor}）；按绝对规模判定，不依赖账户年龄或同源关系` };
    }
    if (input.eventType === 'position_exited' && bigEnough) {
        return { priority: 'high', reason: `本地址退出，名义金额 ≥ 绝对下限（${floor}）` };
    }
    if (bigEnough && (bigMove || bigRelative)) {
        if (bigMove) parts.push(`自身持仓变化 ${pctString(input.positionChangeRatio)}（≥50%）`);
        if (bigRelative) parts.push(`约 ${relNum!.toFixed(1)} 倍历史典型规模（≥${input.rules.relativeSizeMultiplier} 倍）`);
        parts.push(`名义金额 ≥ 绝对下限（${floor}）`);
        return { priority: 'high', reason: parts.join('；') };
    }
    if (bigEnough && (midMove || midRelative || notionalNum >= floor * 2)) {
        if (midMove) parts.push(`自身持仓变化 ${pctString(input.positionChangeRatio)}（≥${(input.rules.reducePctThreshold * 100).toFixed(0)}%）`);
        else if (midRelative) parts.push(`约 ${relNum!.toFixed(1)} 倍历史典型规模`);
        else parts.push(`名义金额 ≥ 2 倍绝对下限（${floor}）`);
        return { priority: 'medium', reason: parts.join('；') };
    }
    if (!bigEnough) parts.push(`名义金额 $${notionalNum.toFixed(0)} 低于绝对下限（${floor}）`);
    else parts.push('相对变化未达到阈值');
    if (relNum === null && pctNum === null) parts.push('缺少可比较的历史基线');
    return { priority: 'low', reason: parts.join('；') };
}

/** 序号化去重键：同一持仓过程 + 同一行为 + 同一冷却窗口 = 同一条事件（重复采集不重复报警） */
export function behaviorDedupeKey(c: { episodeId: number; eventType: BehaviorType; eventAt: string; cooldownMinutes: number }): string {
    const bucket = Math.floor(Date.parse(c.eventAt) / (Math.max(1, c.cooldownMinutes) * 60_000));
    return `ep${c.episodeId}|${c.eventType}|b${bucket}`;
}

/** 数据质量：来源支持精确归因且无缺口 = verified；有未解释变化 = partial；缺关键字段 = incomplete */
export function dataQualityOf(c: { unsupportedSource: boolean; oversold: boolean; sizeBefore: Dec | null; priceMissing: boolean }): DataQuality {
    if (c.oversold || c.sizeBefore === null) return 'incomplete';
    if (c.unsupportedSource || c.priceMissing) return 'partial';
    return 'verified';
}

/** 沉寂后恢复：上次活动与本次之间的间隔 ≥ 阈值 */
export function isReactivation(previousEventAt: string | null, currentEventAt: string, hours: number): boolean {
    if (!previousEventAt) return false;
    const gap = Date.parse(currentEventAt) - Date.parse(previousEventAt);
    return gap >= hours * 3600_000;
}

/**
 * 现金账本残差：区间内余额变化 − 区间内已解释现金变化 = 未解释资金流。
 * 残差不等于 0 时报告「待解释差异」，不把它伪装成「外部转入/转出」（方案 §3.2、§12）。
 */
export function cashResidual(balanceStart: Dec | null, balanceEnd: Dec | null, explainedCashDelta: Dec | null): { residual: Dec | null; kind: 'balanced' | 'unexplained' | 'unknown'; direction: 'in' | 'out' | null } {
    if (balanceStart === null || balanceEnd === null || explainedCashDelta === null) return { residual: null, kind: 'unknown', direction: null };
    const residual = sub(sub(balanceEnd, balanceStart), explainedCashDelta)!;
    if (cmp(residual, ZERO) === 0) return { residual: ZERO, kind: 'balanced', direction: null };
    return { residual, kind: 'unexplained', direction: residual > 0n ? 'in' : 'out' };
}

/** 生成行为事件（把 change + 优先级 + 质量打包） */
export function buildBehavior(c: ChangeForBehavior, opts: {
    rules: PriorityRules;
    ruleVersion: string;
    relativeMultiplier: Dec | null;
    firstTimeLongTermChange: boolean;
    priceMissing: boolean;
    ledgerEntryIds: number[];
    /** 退出类事件是否被来源快照确认归零；未确认则质量降为 partial（方案 §12） */
    snapshotConfirmedZero?: boolean;
    extraEvidence?: Record<string, unknown>;
    observedAt: string;
}): BehaviorOut | null {
    const eventType = classifyChange(c);
    if (!eventType) return null;
    const notional = notionalOf(c.deltaSize, c.price);
    const ratio = c.sizeBefore !== null && c.sizeAfter !== null && cmp(c.sizeBefore, ZERO) !== 0 ? div(sub(c.sizeAfter, c.sizeBefore), c.sizeBefore) : null;
    let dataQuality = dataQualityOf({ unsupportedSource: c.unsupportedSource, oversold: c.oversold, sizeBefore: c.sizeBefore, priceMissing: opts.priceMissing });
    if (eventType === 'position_exited' && dataQuality === 'verified' && opts.snapshotConfirmedZero === false) {
        dataQuality = 'partial'; // 推导归零但快照没确认：报告写「疑似退出，待核对」
    }
    const { priority, reason } = computePriority({
        eventType, notional, relativeMultiplier: opts.relativeMultiplier,
        positionChangeRatio: ratio, dataQuality, firstTimeLongTermChange: opts.firstTimeLongTermChange, rules: opts.rules,
    });
    return {
        eventType,
        magnitude: JSON.stringify({
            before: decToString(c.sizeBefore), after: decToString(c.sizeAfter), delta: decToString(c.deltaSize),
            pct: ratio === null ? null : pctString(ratio, 2), notional: decToString(notional),
            cashDelta: decToString(c.cashDelta), outcome: c.outcome,
        }),
        evidence: JSON.stringify({
            episodeId: c.episodeId, ledgerEntryIds: opts.ledgerEntryIds,
            episodeOpenedAt: c.episodeOpenedAt, turns: opts.ruleVersion,
            aggregation: '同向成交在配置窗口内聚合为一次行为，保留原始顺序',
            ...opts.extraEvidence,
        }),
        dataQuality,
        priority,
        priorityReason: reason,
        dedupeKey: behaviorDedupeKey({ episodeId: c.episodeId, eventType, eventAt: c.eventAt, cooldownMinutes: opts.rules.alertCooldownMinutes }),
        eventAt: c.eventAt,
        observedAt: opts.observedAt,
        ruleVersion: opts.ruleVersion,
        wallet: c.wallet,
        conditionId: c.conditionId,
        tokenId: c.tokenId,
    };
}
