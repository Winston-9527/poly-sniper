/**
 * 来源契约（P0 核验结果，2026-10-09 实测；详见 docs/contract-report.md）。
 *
 * 实测要点：
 *   /holders   → [{ token, holders: [{ proxyWallet, amount, outcomeIndex, asset, name, ... }] }]，limit 上限 ≥500
 *   /trades    → 扁平数组 [{ proxyWallet, side, asset, conditionId, size, price, timestamp, transactionHash, outcome, outcomeIndex, slug, eventSlug, title, ... }]
 *                没有稳定成交 ID；默认只返回 taker 行，takerOnly=false 会额外带上 maker 行
 *   /activity  → 扁平数组，含 type: TRADE|SPLIT|MERGE|REDEEM|CONVERSION|YIELD|MAKER_REBATE|TAKER_REBATE|…（实测见到 TRADE/SPLIT/REDEEM/YIELD/MAKER_REBATE/TAKER_REBATE）
 *   /positions → [{ proxyWallet, asset, conditionId, size, currentValue, avgPrice, curPrice, redeemable, negativeRisk, oppositeAsset, ... }]
 *   /value     → [{ user, value }]
 *
 * 契约版本随来源字段/口径变动递增，落库到 source_records.contract_version。
 */
import { decToString, parseDec } from '../util/decimal.js';

export const CONTRACT_VERSION = 'data-api-2026-10-09';

export class ContractError extends Error {
    constructor(message: string, readonly payloadSnippet: string) {
        super(message);
        this.name = 'ContractError';
    }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function normalizeAddress(addr: unknown): string | null {
    if (typeof addr !== 'string') return null;
    const a = addr.trim().toLowerCase();
    return /^0x[0-9a-f]{40}$/.test(a) ? a : null;
}

/** 数值字段：来源给 number 或 string；无法解析返回 null（未知），不返回 0 */
function num(v: unknown): string | null {
    if (v === null || v === undefined || v === '') return null;
    try { return decToString(parseDec(v as string | number)); } catch { return null; }
}

function requireFields(o: Record<string, unknown>, fields: string[], what: string, snippet: string): void {
    for (const f of fields) if (!(f in o)) throw new ContractError(`${what} 缺少字段 ${f}`, snippet);
}

const snippet = (v: unknown) => JSON.stringify(v).slice(0, 200);

// ---------------- /holders ----------------
export interface RawHolder { address: string; amount: string | null; outcomeIndex: number | null; name?: string; }
export interface HoldersPage { token: string; holderCount: number; holders: RawHolder[]; }

export function validateHolders(data: unknown): HoldersPage[] {
    if (!Array.isArray(data)) throw new ContractError('/holders 顶层不是数组', snippet(data));
    return data.map((g) => {
        if (!isObj(g)) throw new ContractError('/holders 分组不是对象', snippet(g));
        requireFields(g, ['token', 'holders'], '/holders 分组', snippet(g));
        const holders = Array.isArray(g.holders) ? g.holders : [];
        return {
            token: String(g.token),
            holderCount: holders.length,
            holders: holders.map((h) => {
                if (!isObj(h)) throw new ContractError('/holders 元素不是对象', snippet(h));
                const addr = normalizeAddress(h.proxyWallet ?? h.userAddress);
                if (!addr) throw new ContractError(`/holders 元素缺少可用地址（proxyWallet=${snippet(h.proxyWallet)}）`, snippet(h));
                return {
                    address: addr,
                    amount: num(h.amount),
                    outcomeIndex: typeof h.outcomeIndex === 'number' ? h.outcomeIndex : null,
                    name: typeof h.name === 'string' ? h.name : undefined,
                };
            }),
        };
    });
}

// ---------------- /trades ----------------
export interface RawTrade {
    wallet: string;
    side: 'BUY' | 'SELL' | null;
    tokenId: string;
    conditionId: string;
    size: string | null;
    price: string | null;
    timestamp: number;
    eventAt: string | null;
    txHash: string;
    outcome: string | null;
    outcomeIndex: number | null;
    slug?: string;
    eventSlug?: string;
    title?: string;
    /** 合成键：来源没有稳定成交 ID（实测无 id/tradeId 字段） */
    syntheticKey: string;
    keyCollision: boolean;
}

export function validateTrades(data: unknown): Omit<RawTrade, 'syntheticKey' | 'keyCollision'>[] {
    if (!Array.isArray(data)) throw new ContractError('/trades 顶层不是数组', snippet(data));
    return data.map((t) => {
        if (!isObj(t)) throw new ContractError('/trades 元素不是对象', snippet(t));
        requireFields(t, ['proxyWallet', 'asset', 'conditionId', 'size', 'price', 'timestamp', 'side', 'transactionHash'], '/trades 元素', snippet(t));
        const wallet = normalizeAddress(t.proxyWallet);
        if (!wallet) throw new ContractError(`/trades 元素地址非法: ${snippet(t.proxyWallet)}`, snippet(t));
        const ts = Number(t.timestamp);
        if (!Number.isFinite(ts) || ts <= 0) throw new ContractError(`/trades 元素时间戳非法: ${snippet(t.timestamp)}`, snippet(t));
        return {
            wallet,
            side: t.side === 'BUY' || t.side === 'SELL' ? t.side : null,
            tokenId: String(t.asset),
            conditionId: String(t.conditionId),
            size: num(t.size),
            price: num(t.price),
            timestamp: ts,
            eventAt: new Date(ts * 1000).toISOString(),
            txHash: String(t.transactionHash),
            outcome: typeof t.outcome === 'string' ? t.outcome : null,
            outcomeIndex: typeof t.outcomeIndex === 'number' ? t.outcomeIndex : null,
            slug: typeof t.slug === 'string' ? t.slug : undefined,
            eventSlug: typeof t.eventSlug === 'string' ? t.eventSlug : undefined,
            title: typeof t.title === 'string' ? t.title : undefined,
        };
    });
}

/**
 * 合成去重键。来源没有稳定成交 ID，只能按字段组合去重；
 * 同一批次内若出现完全相同的组合（拆单/同价同量多笔），追加序号后缀而不是丢弃，
 * 保证「不漏记真实事件」；局限记入 data_gaps（方案 §6.2）。
 */
export function assignSyntheticKeys<T extends { txHash: string; tokenId: string; side: string | null; size: string | null; price: string | null; timestamp: number; wallet: string }>(rows: T[]): (T & { syntheticKey: string; keyCollision: boolean })[] {
    const seen = new Map<string, number>();
    return rows.map((r) => {
        const base = `${r.txHash}|${r.tokenId}|${r.side ?? '-'}|${r.size ?? '-'}|${r.price ?? '-'}|${r.timestamp}|${r.wallet}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        return { ...r, syntheticKey: n === 1 ? base : `${base}#${n}`, keyCollision: n > 1 };
    });
}

// ---------------- /activity ----------------
export const KNOWN_ACTIVITY_TYPES = [
    'TRADE', 'SPLIT', 'MERGE', 'REDEEM', 'CONVERSION', 'REWARD', 'YIELD',
    'MAKER_REBATE', 'TAKER_REBATE', 'TRANSFER', 'REFERRAL_REWARD',
] as const;

export interface RawActivity {
    wallet: string;
    type: string;            // 原始类型；未知类型保留 UNKNOWN:<原值>
    recognized: boolean;
    conditionId: string | null;
    tokenId: string | null;
    outcomeIndex: number | null;
    outcome: string | null;
    side: 'BUY' | 'SELL' | null;
    size: string | null;
    price: string | null;
    usdcSize: string | null;
    timestamp: number;
    eventAt: string;
    txHash: string | null;
    slug?: string;
    eventSlug?: string;
}

export function validateActivity(data: unknown): RawActivity[] {
    if (!Array.isArray(data)) throw new ContractError('/activity 顶层不是数组', snippet(data));
    return data.map((a) => {
        if (!isObj(a)) throw new ContractError('/activity 元素不是对象', snippet(a));
        requireFields(a, ['proxyWallet', 'type', 'timestamp'], '/activity 元素', snippet(a));
        const wallet = normalizeAddress(a.proxyWallet);
        if (!wallet) throw new ContractError(`/activity 元素地址非法: ${snippet(a.proxyWallet)}`, snippet(a));
        const ts = Number(a.timestamp);
        if (!Number.isFinite(ts) || ts <= 0) throw new ContractError('/activity 元素时间戳非法', snippet(a));
        const rawType = String(a.type);
        const recognized = (KNOWN_ACTIVITY_TYPES as readonly string[]).includes(rawType);
        return {
            wallet,
            type: recognized ? rawType : `UNKNOWN:${rawType}`,
            recognized,
            conditionId: a.conditionId ? String(a.conditionId) : null,
            tokenId: a.asset ? String(a.asset) : null,
            outcomeIndex: typeof a.outcomeIndex === 'number' ? a.outcomeIndex : null,
            outcome: typeof a.outcome === 'string' ? a.outcome : null,
            side: a.side === 'BUY' || a.side === 'SELL' ? a.side : null,
            size: num(a.size),
            price: num(a.price),
            usdcSize: num(a.usdcSize),
            timestamp: ts,
            eventAt: new Date(ts * 1000).toISOString(),
            txHash: a.transactionHash ? String(a.transactionHash) : null,
            slug: typeof a.slug === 'string' ? a.slug : undefined,
            eventSlug: typeof a.eventSlug === 'string' ? a.eventSlug : undefined,
        };
    });
}

/** /activity 合成键（同样没有稳定 ID） */
export function activityKey(a: { txHash: string | null; type: string; tokenId: string | null; side: string | null; size: string | null; price: string | null; timestamp: number; wallet: string }, ordinal = 1): string {
    const base = `${a.txHash ?? 'no-tx'}|${a.type}|${a.tokenId ?? '-'}|${a.side ?? '-'}|${a.size ?? '-'}|${a.price ?? '-'}|${a.timestamp}|${a.wallet}`;
    return ordinal === 1 ? base : `${base}#${ordinal}`;
}

// ---------------- /positions ----------------
export interface RawPosition {
    wallet: string;
    tokenId: string;
    conditionId: string;
    outcome: string | null;
    size: string | null;
    currentValue: string | null;
    price: string | null;      // curPrice
    avgPrice: string | null;
    redeemable: boolean | null;
}

export function validatePositions(data: unknown): RawPosition[] {
    if (!Array.isArray(data)) throw new ContractError('/positions 顶层不是数组', snippet(data));
    return data.map((p) => {
        if (!isObj(p)) throw new ContractError('/positions 元素不是对象', snippet(p));
        requireFields(p, ['proxyWallet', 'asset', 'conditionId', 'size'], '/positions 元素', snippet(p));
        const wallet = normalizeAddress(p.proxyWallet);
        if (!wallet) throw new ContractError('/positions 元素地址非法', snippet(p));
        return {
            wallet,
            tokenId: String(p.asset),
            conditionId: String(p.conditionId),
            outcome: typeof p.outcome === 'string' ? p.outcome : null,
            size: num(p.size),
            currentValue: num(p.currentValue),
            price: num(p.curPrice ?? p.price),
            avgPrice: num(p.avgPrice),
            redeemable: typeof p.redeemable === 'boolean' ? p.redeemable : null,
        };
    });
}

// ---------------- /value ----------------
export interface RawPortfolioValue { wallet: string; value: string | null; }

export function validateValue(data: unknown): RawPortfolioValue[] {
    const arr = Array.isArray(data) ? data : [data];
    return arr.filter(isObj).map((v) => {
        const wallet = normalizeAddress(v.user ?? v.proxyWallet);
        if (!wallet) throw new ContractError('/value 缺少可用地址', snippet(v));
        return { wallet, value: num(v.value) };
    });
}

// ---------------- gamma /markets ----------------
export interface GammaMarket {
    conditionId: string;
    slug?: string;
    question?: string;
    eventSlug?: string;
    negRisk: boolean | null;
    closed: boolean | null;
    endDate?: string;
    tokens: { tokenId: string; outcome: string; outcomeIndex: number }[];
    volume24hr: string | null;
    liquidity: string | null;
}

export function validateGammaMarkets(data: unknown): GammaMarket[] {
    if (!Array.isArray(data)) throw new ContractError('/markets 顶层不是数组', snippet(data));
    return data.filter(isObj).map((m) => {
        const conditionId = typeof m.conditionId === 'string' ? m.conditionId : null;
        if (!conditionId) throw new ContractError('/markets 缺少 conditionId', snippet(m));
        let tokenIds: string[] = [], outcomes: string[] = [];
        try { tokenIds = JSON.parse(String(m.clobTokenIds ?? '[]')); } catch { tokenIds = []; }
        try { outcomes = JSON.parse(String(m.outcomes ?? '[]')); } catch { outcomes = []; }
        return {
            conditionId,
            slug: typeof m.slug === 'string' ? m.slug : undefined,
            question: typeof m.question === 'string' ? m.question : undefined,
            eventSlug: undefined,
            negRisk: typeof m.negRisk === 'boolean' ? m.negRisk : null,
            closed: typeof m.closed === 'boolean' ? m.closed : null,
            endDate: typeof m.endDate === 'string' ? m.endDate : undefined,
            tokens: tokenIds.map((t, i) => ({ tokenId: t, outcome: outcomes[i] ?? '', outcomeIndex: i })),
            volume24hr: num(m.volume24hr),
            liquidity: num(m.liquidity),
        };
    });
}

export function validateGammaEvents(data: unknown): { slug: string; title: string; markets: GammaMarket[] }[] {
    if (!Array.isArray(data)) throw new ContractError('/events 顶层不是数组', snippet(data));
    return data.filter(isObj).map((e) => ({
        slug: String(e.slug ?? ''),
        title: String(e.title ?? e.question ?? ''),
        markets: validateGammaMarkets(e.markets ?? []),
    }));
}
