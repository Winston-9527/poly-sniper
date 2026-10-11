/**
 * 精确十进制：所有金额/份数对外都是字符串，内部用 BigInt 缩放整数运算。
 * 方案 §3.2 / §6.3：金额和份数使用精确十进制，避免二进制浮点累计误差与整数溢出。
 * 未知值用 null 表示，绝不用 0 代替（方案 §3.3）。
 */

const SCALE_DIGITS = 18;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

export type Dec = bigint; // 缩放 1e18 的整数

export function parseDec(input: string | number | bigint | null | undefined): Dec | null {
    if (input === null || input === undefined) return null;
    let s = typeof input === 'string' ? input.trim() : String(input);
    if (s === '' || s.toLowerCase() === 'null' || s.toLowerCase() === 'undefined' || s.toLowerCase() === 'nan') return null;
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
        throw new Error(`不是合法十进制: ${JSON.stringify(input)}`);
    }
    let exp = 0;
    const em = /[eE]([+-]?\d+)$/.exec(s);
    if (em) { exp = parseInt(em[1], 10); s = s.slice(0, em.index); }
    const neg = s.startsWith('-');
    if (neg || s.startsWith('+')) s = s.slice(1);
    const [intPart = '0', fracPart = ''] = s.split('.');
    let digits = fracPart;
    let scaledExp = exp - fracPart.length;
    // 超出精度直接截断（来源 API 最多 6 位小数），并保持确定性
    if (scaledExp + SCALE_DIGITS < 0) {
        const keep = Math.max(0, SCALE_DIGITS + scaledExp);
        digits = fracPart.slice(0, keep);
        scaledExp = exp - digits.length;
    }
    const raw = BigInt((intPart + digits).replace(/^0+(?=\d)/, '') || '0');
    let v = raw * 10n ** BigInt(SCALE_DIGITS + scaledExp);
    return neg ? -v : v;
}

/** 内部值 → 字符串（去掉多余尾零，不输出科学计数法） */
export function decToString(v: Dec | null): string | null {
    if (v === null) return null;
    const neg = v < 0n;
    let a = neg ? -v : v;
    const int = a / SCALE;
    const frac = (a % SCALE).toString().padStart(SCALE_DIGITS, '0').replace(/0+$/, '');
    return (neg ? '-' : '') + int.toString() + (frac ? '.' + frac : '');
}

export const ZERO: Dec = 0n;
export function isZero(v: Dec | null): boolean { return v !== null && v === 0n; }
export function add(a: Dec | null, b: Dec | null): Dec | null { return a === null || b === null ? null : a + b; }
export function sub(a: Dec | null, b: Dec | null): Dec | null { return a === null || b === null ? null : a - b; }
export function neg(a: Dec | null): Dec | null { return a === null ? null : -a; }
export function abs(a: Dec | null): Dec | null { return a === null ? null : (a < 0n ? -a : a); }
export function cmp(a: Dec, b: Dec): -1 | 0 | 1 { return a < b ? -1 : a > b ? 1 : 0; }
export function isNeg(a: Dec | null): boolean { return a !== null && a < 0n; }
/** 乘法：结果按缩放位数再取整（向下截断到 18 位） */
export function mul(a: Dec | null, b: Dec | null): Dec | null { return a === null || b === null ? null : (a * b) / SCALE; }
/** a / b，保留 18 位小数，b 为 0 时返回 null（未知，不返回 0 或 Infinity） */
export function div(a: Dec | null, b: Dec | null): Dec | null {
    if (a === null || b === null || b === 0n) return null;
    return (a * SCALE) / b;
}
/** b 相对 a 的变化比例（b/a - 1），未知返回 null */
export function pctChange(from: Dec | null, to: Dec | null): Dec | null {
    if (from === null || to === null || from === 0n) return null;
    return ((to - from) * SCALE) / from;
}
/** 展示用百分比字符串，如 "-70.0%"；unknown 显示为 null */
export function pctString(ratio: Dec | null, digits = 1): string | null {
    if (ratio === null) return null;
    const hundred = ratio * 100n;
    const neg = hundred < 0n;
    const a = neg ? -hundred : hundred;
    const int = a / SCALE;
    const frac = ((a % SCALE) * 10n ** BigInt(digits)) / SCALE;
    return `${neg ? '-' : ''}${int}.${frac.toString().padStart(digits, '0')}%`;
}
export function minDec(a: Dec, b: Dec): Dec { return a < b ? a : b; }
export function maxDec(a: Dec, b: Dec): Dec { return a > b ? a : b; }
export function decToNumber(v: Dec | null): number | null { return v === null ? null : Number(v) / Number(SCALE); }
/** 供 SQLite 存储：始终字符串；null 保持 null（未知） */
export function toDb(v: Dec | null): string | null { return decToString(v); }
export function fromDb(s: string | null | undefined): Dec | null { return s === null || s === undefined ? null : parseDec(s); }
export function sumDec(values: (Dec | null)[]): Dec | null {
    let acc: Dec | null = 0n;
    for (const v of values) { acc = add(acc, v); if (acc === null) return null; }
    return acc;
}
