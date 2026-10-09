/**
 * HTTP 层：所有对外请求都返回 Result，不抛异常、不在失败时返回空数组冒充「没有数据」
 * （方案 §4、§11 P0：失败必须与空、零分开）。
 */
import { fetch, ProxyAgent } from 'undici';

export type ErrKind = 'timeout' | 'http' | 'network' | 'parse' | 'contract' | 'budget';

export interface Ok<T> { ok: true; data: T; status: number; ms: number; url: string; }
export interface Err { ok: false; kind: ErrKind; error: string; status?: number; url: string; ms: number; bodySnippet?: string; }
export type Result<T> = Ok<T> | Err;

export function ok<T>(data: T, meta: Partial<Ok<T>> & { url: string }): Ok<T> {
    return { ok: true, data, status: meta.status ?? 200, ms: meta.ms ?? 0, url: meta.url };
}
export function err(kind: ErrKind, error: string, url: string, extra: Partial<Err> = {}): Err {
    return { ok: false, kind, error, url, ms: extra.ms ?? 0, ...extra };
}

/** 全局请求预算：一轮采集里所有来源共享；耗尽后不再发请求，而是记录缺口（方案 §5.1） */
export class RequestBudget {
    private used = 0;
    readonly limit: number;
    readonly exhaustedSources = new Set<string>();
    constructor(limit: number) { this.limit = limit; }
    trySpend(source: string): boolean {
        if (this.used >= this.limit) { this.exhaustedSources.add(source); return false; }
        this.used++;
        return true;
    }
    get spent(): number { return this.used; }
    get remaining(): number { return Math.max(0, this.limit - this.used); }
}

export interface HttpOptions {
    proxyUrl?: string;
    timeoutMs?: number;
    retries?: number;
    /** 请求间隔（礼貌抓取） */
    spacingMs?: number;
    budget?: RequestBudget;
    logger?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
    private dispatcher: ProxyAgent | undefined;
    private budget?: RequestBudget;
    private spacingMs: number;
    private timeoutMs: number;
    private retries: number;
    private lastAt = 0;
    private log: (msg: string) => void;

    constructor(opts: HttpOptions = {}) {
        if (opts.proxyUrl) this.dispatcher = new ProxyAgent(opts.proxyUrl);
        this.budget = opts.budget;
        this.spacingMs = opts.spacingMs ?? 0;
        this.timeoutMs = opts.timeoutMs ?? 25000;
        this.retries = opts.retries ?? 2;
        this.log = opts.logger ?? (() => { });
    }

    /** 供 JSON-RPC（POST）等非 GET 调用复用同一代理 */
    get proxyDispatcher(): ProxyAgent | undefined { return this.dispatcher; }

    /** 统一记账：非 GET 调用也应走预算（由调用方在发请求前调用） */
    trySpend(source: string): boolean { return this.budget ? this.budget.trySpend(source) : true; }

    /** GET JSON。失败返回 Err(kind)，绝不返回空数组。 */
    async getJson<T = unknown>(url: string, source: string): Promise<Result<T>> {
        const t0 = Date.now();
        if (this.budget && !this.budget.trySpend(source)) {
            return err('budget', `本轮请求预算用尽（${this.budget.limit}）`, url, { ms: 0 });
        }
        let lastErr: Err | undefined;
        for (let attempt = 0; attempt <= this.retries; attempt++) {
            if (attempt > 0) await sleep(Math.min(8000, 500 * 2 ** attempt));
            const wait = this.spacingMs - (Date.now() - this.lastAt);
            if (wait > 0) await sleep(wait);
            this.lastAt = Date.now();
            try {
                const res = await fetch(url, {
                    dispatcher: this.dispatcher,
                    signal: AbortSignal.timeout(this.timeoutMs),
                    // 本机代理链路下，端点返回压缩体时 undici 不一定能解码（实测 publicnode 的 zstd/br）。
                    // 明确要求未压缩响应，避免把压缩流当 JSON 解析。
                    headers: { accept: 'application/json', 'accept-encoding': 'identity' },
                } as never);
                const text = await res.text();
                const ms = Date.now() - t0;
                if (!res.ok) {
                    lastErr = err('http', `HTTP ${res.status} ${res.statusText}`, url, { status: res.status, ms, bodySnippet: text.slice(0, 300) });
                    // 4xx（除 429）不重试
                    if (res.status < 500 && res.status !== 429) return lastErr;
                    continue;
                }
                if (text.trim() === '') return err('parse', '响应体为空（不是「没有数据」，是空响应）', url, { status: res.status, ms });
                try {
                    return ok(JSON.parse(text) as T, { url, status: res.status, ms });
                } catch {
                    return err('parse', '响应不是合法 JSON', url, { status: res.status, ms, bodySnippet: text.slice(0, 300) });
                }
            } catch (e) {
                const msg = String((e as Error)?.message ?? e);
                const kind: ErrKind = /timeout|abort/i.test(msg) ? 'timeout' : 'network';
                lastErr = err(kind, msg, url, { ms: Date.now() - t0 });
                if (/abort|timeout/i.test(msg)) continue;
                // 代理/连接类错误也重试一次
                continue;
            }
        }
        return lastErr ?? err('network', '未知失败', url);
    }

    /** 逐页抓取直到满足条件；返回 { rows, pages, stoppedBecause }，停止原因必须显式记录 */
    async paged<T>(
        buildUrl: (limit: number, offset: number) => string,
        source: string,
        opts: { pageSize?: number; maxPages: number; unwrap: (data: unknown) => T[]; stopEarly?: (rows: T[], all: T[]) => boolean },
    ): Promise<{ ok: true; rows: T[]; pages: number; stoppedBecause: 'end' | 'max_pages' | 'stop_early' | 'budget' } | Err> {
        const pageSize = opts.pageSize ?? 500;
        const all: T[] = [];
        let pages = 0;
        for (let p = 0; p < opts.maxPages; p++) {
            const r = await this.getJson(buildUrl(pageSize, p * pageSize), source);
            if (!r.ok) return r;
            const rows = opts.unwrap(r.data);
            all.push(...rows);
            pages++;
            if (rows.length < pageSize) return { ok: true, rows: all, pages, stoppedBecause: 'end' };
            if (opts.stopEarly?.(rows, all)) return { ok: true, rows: all, pages, stoppedBecause: 'stop_early' };
        }
        return { ok: true, rows: all, pages, stoppedBecause: 'max_pages' };
    }
}

export const POLYMARKET = {
    gamma: 'https://gamma-api.polymarket.com',
    dataApi: 'https://data-api.polymarket.com',
    clob: 'https://clob.polymarket.com',
};
