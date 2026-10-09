/**
 * 展示层格式化：只用于报告渲染，不参与任何计算。
 *   - 金额四舍五入到「人类可读」：≥$1 保留最多 2 位小数，<$1 保留最多 4 位；带千分位。
 *   - 份数最多 4 位小数并去掉尾零（避免 123.00000000000001 这种尾巴）。
 *   - 缺失一律显示「未知」，不猜成 0（方案 §3.2：未知与 0 必须分开）。
 */

/** 把十进制字符串渲染成金额（不含 $） */
export function fmtMoney(v: string | null | undefined): string {
    if (v === null || v === undefined || v === '') return '未知';
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    const abs = Math.abs(n);
    const maxFrac = abs >= 1 ? 2 : 4;
    const s = n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: maxFrac });
    return s === '-0' ? '0' : s;
}

/** 带 $ 前缀的金额 */
export function fmtUsd(v: string | null | undefined): string {
    const s = fmtMoney(v);
    return s === '未知' ? '未知' : `$${s}`;
}

/** 份数：最多 4 位小数，去尾零 */
export function fmtQty(v: string | null | undefined): string {
    if (v === null || v === undefined || v === '') return '未知';
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return String(Number(n.toFixed(4)));
}

/** 百分比（已经是百分数形式的字符串，如 "-70.00%"）：统一到 2 位小数 */
export function fmtPct(v: string | null | undefined): string {
    if (v === null || v === undefined || v === '') return '未知';
    const m = /^(-?\d+(?:\.\d+)?)%$/.exec(String(v).trim());
    if (!m) return String(v);
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return String(v);
    return `${n.toFixed(2)}%`;
}

/** 大额紧凑展示（用于市场背景：成交量 / 流动性） */
export function fmtCompactUsd(v: string | null | undefined): string {
    if (v === null || v === undefined || v === '') return '未知';
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return `$${Number((n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1))}M`;
    if (abs >= 1_000) return `$${Number((n / 1_000).toFixed(abs >= 10_000 ? 0 : 1))}k`;
    return `$${fmtMoney(v)}`;
}
