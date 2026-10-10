/**
 * 时间口径（方案 §3.3）：内部统一 UTC ISO；展示用 Asia/Shanghai 并注明时区。
 * 三类时间严格区分：event_at（源事件时间）、observed_at（系统获取时间）、computed_at（计算时间）。
 */

/** 当前时刻（UTC ISO 8601，毫秒精度） */
export function nowIso(now: number = Date.now()): string {
    return new Date(now).toISOString();
}

/** 源事件时间：Unix 秒 → UTC ISO；缺失返回 null（未知，不用 0 代替） */
export function unixToIso(sec: number | string | null | undefined): string | null {
    if (sec === null || sec === undefined || sec === '') return null;
    const n = typeof sec === 'string' ? Number(sec) : sec;
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n * 1000).toISOString();
}

export function isoToUnix(iso: string): number { return Math.floor(Date.parse(iso) / 1000); }

const SHANGHAI = 'Asia/Shanghai';
const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: SHANGHAI, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
});

/** 展示用：2026-10-09 16:30（东八区） */
export function toDisplay(iso: string | null | undefined): string {
    if (!iso) return '未知';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '未知';
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}（东八区）`;
}

/** 相对时长描述：如「47 天」；负值/未知返回 null */
export function durationText(fromIso: string | null, toIso: string): string | null {
    if (!fromIso) return null;
    const from = Date.parse(fromIso), to = Date.parse(toIso);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
    const mins = Math.floor((to - from) / 60000);
    if (mins < 60) return `${mins} 分钟`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${hours} 小时`;
    const days = Math.floor(hours / 24);
    if (days < 60) return `${days} 天`;
    return `${Math.floor(days / 30)} 个月`;
}

/** 采集/查询窗口（毫秒） */
export function hoursAgo(hours: number, now: number = Date.now()): string {
    return new Date(now - hours * 3600_000).toISOString();
}
export function isoPlusMinutes(iso: string, minutes: number): string {
    return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}
