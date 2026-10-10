/**
 * 观察组聚合（方案 §3.1、§12）：
 *   - 同源资金只在有「控制关系证据」时合并；公共交易所/桥/托管不合并身份。
 *   - 观察组内部的转移单列，不重复计入该组的对外流入/流出。
 *   - 多签共享一个签名者不据此合并身份（只有单签名者 owner() 关系才算控制关系）。
 */
import { Dec, decToString, parseDec, sumDec, ZERO, cmp } from '../util/decimal.js';

export interface TransferItem {
    from: string;
    to: string;
    amount: string | null;
    kind: string;
    eventAt: string;
}

export interface GroupPartition {
    members: string[];
    /** 组内两个成员之间的转移 */
    internal: TransferItem[];
    /** 成员 → 组外 */
    externalOut: TransferItem[];
    /** 组外 → 成员 */
    externalIn: TransferItem[];
    /** 组外净流入金额（精确十进制）；无法解析的条目为 null */
    externalNetIn: string | null;
    /** 组内转移合计（单列，不计入外部流入/流出） */
    internalVolume: string | null;
    notes: string[];
}

export function partitionByGroup(members: string[], items: TransferItem[]): GroupPartition {
    const set = new Set(members.map((m) => m.toLowerCase()));
    const internal: TransferItem[] = [], externalOut: TransferItem[] = [], externalIn: TransferItem[] = [];
    const notes: string[] = [];
    // 组内转移只算一次：同一笔（同一 from/to/时间/金额）出现多次时按事件去重
    const seen = new Set<string>();
    for (const it of items) {
        const key = `${it.from}|${it.to}|${it.eventAt}|${it.amount ?? '-'}|${it.kind}`;
        if (seen.has(key)) { notes.push(`重复条目已去重：${key}`); continue; }
        seen.add(key);
        const fromIn = set.has(it.from.toLowerCase()), toIn = set.has(it.to.toLowerCase());
        if (fromIn && toIn) internal.push(it);
        else if (fromIn) externalOut.push(it);
        else if (toIn) externalIn.push(it);
    }
    const sumOf = (arr: TransferItem[]): Dec | null =>
        arr.length === 0 ? ZERO : sumDec(arr.map((x) => parseDec(x.amount) ?? null));
    const internalVolume = sumOf(internal);
    const netIn = sub2(sumOf(externalIn), sumOf(externalOut));
    return {
        members: [...set],
        internal, externalOut, externalIn,
        externalNetIn: decToString(netIn),
        internalVolume: decToString(internalVolume),
        notes,
    };
}

function sub2(a: Dec | null, b: Dec | null): Dec | null { return a === null || b === null ? null : a - b; }

/** 净买入不等于市场层面的等规模外部资金流入（方案 §3.2） */
export function describeScope(members: number, matchedWallets: number, windowText: string): string {
    return `口径：观察组 ${members} 个地址（窗口 ${windowText}）、其中 ${matchedWallets} 个在该窗口内有成交；组内转移单列，不计入对外流入/流出；组净额不等于整个市场的外部资金规模。`;
}

/** 公共来源（交易所/桥/托管）不用于合并身份 */
export const PUBLIC_FUNDING_DENY = [
    '0x4fabb145d64652a948d72533023f6e7a623c7c53', // 示例：公共桥
    '0x8eb8a3b98659cce290402893d0123abb75e3ab28', // 示例：CEX 热钱包
];

export function isPublicFunding(address: string, deny: string[] = PUBLIC_FUNDING_DENY): boolean {
    return deny.map((d) => d.toLowerCase()).includes(address.toLowerCase());
}

/** 判定「同一批资金转移」：只有在有资金路径证据时才成立；仅时间接近只能并列表述 */
export function sameBatchEvidence(path: { from: string; to: string; amount: string | null; eventAt: string }[]): { sameBatch: boolean; reason: string } {
    if (path.length < 2) return { sameBatch: false, reason: '只有一条资金路径，不足以判定同一批资金' };
    const total = sumDec(path.map((p) => parseDec(p.amount) ?? null));
    return {
        sameBatch: cmp(total ?? ZERO, ZERO) !== 0,
        reason: '存在可核验的资金路径（转出 → 转入）；仅时间接近的卖出/买入只会并列表述，不推断因果',
    };
}
