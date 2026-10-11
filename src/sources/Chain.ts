/**
 * 链上来源：代理合约控制关系、现金余额、转账日志。
 *
 * P0 实测（2026-10-09）：
 *   - Polygon 公共 RPC：polygon-bor-rpc.publicnode.com 可用，但 eth_getLogs 只支持近端区块
 *     （更老的区间报 "Archive requests require a personal token"）；polygon.drpc.org 近端与 10 万区块前都可查。
 *     polygon-rpc.com 已停用（403 tenant disabled）；polygon.llamarpc.com / 1rpc.io 直连不可达。
 *   - 代理合约形态不统一：45 字节极简代理两种 getter 都不支持；124/146 字节支持 getOwners()+getThreshold()；
 *     只有 146 字节那批还额外支持 owner()。
 *   - 因此：读不出控制关系是「未知」，必须记录缺口，不能当作「无关联」或低风险（方案 §3.1、§12）。
 */
import { HttpClient, Result, err, ok } from './http.js';

export const RPC_ENDPOINTS = [
    { url: 'https://polygon-bor-rpc.publicnode.com', kind: 'primary', getLogsDepth: 'recent' as const },
    { url: 'https://polygon.drpc.org', kind: 'fallback', getLogsDepth: 'archive' as const },
];

export const SELECTORS = {
    owner: '0x8da5cb5b',
    getOwners: '0xa0e67e2b',
    getThreshold: '0xe75235b8',
    erc20BalanceOf: '0x70a08231',
};
/** Polymarket 抵押资产：桥接 USDC（USDC.e） */
export const USDC_E = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface ControlEvidence {
    address: string;
    bytecodeSize: number;
    /** owner() 读到的单签名者（仅部分代理支持） */
    owner: string | null;
    /** getOwners() 读到的完整签名者集合（多签） */
    owners: string[] | null;
    threshold: number | null;
    /** verified：至少一种 getter 成功；unknown：都不支持（不是「无控制关系」） */
    status: 'verified' | 'unknown';
    reason?: string;
    blockNumber: string | null;
    checkedAt: string;
}

function wordToAddress(word: string): string | null {
    const a = '0x' + word.slice(-40).toLowerCase();
    return /^0x[0-9a-f]{40}$/.test(a) ? a : null;
}

export class ChainSource {
    constructor(private http: HttpClient, private endpoints = RPC_ENDPOINTS) { }

    private async rpc<T = unknown>(method: string, params: unknown[]): Promise<Result<T>> {
        let lastErr: Result<T> | undefined;
        for (const ep of this.endpoints) {
            const post = await this.post(ep.url, method, params);
            if (post.ok) {
                const data = post.data as { result?: T; error?: { message: string } };
                if (data.error) { lastErr = err('http', `${ep.url}: ${data.error.message}`, ep.url, { ms: post.ms }); continue; }
                return ok(data.result as T, { url: ep.url, status: 200, ms: post.ms });
            }
            lastErr = post;
        }
        return lastErr ?? err('network', '所有 RPC 端点都失败', this.endpoints[0].url);
    }

    /** JSON-RPC POST（HttpClient 只提供 GET，这里自带重试与端点轮换） */
    private async post(url: string, method: string, params: unknown[]): Promise<Result<{ result?: unknown; error?: { message: string } }>> {
        const t0 = Date.now();
        if (!this.http.trySpend('rpc')) return err('budget', '本轮请求预算用尽，跳过链上调用', url, { ms: 0 });
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'accept-encoding': 'identity' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
                signal: AbortSignal.timeout(20000),
                ...(this.http.proxyDispatcher ? { dispatcher: this.http.proxyDispatcher } : {}),
            } as never);
            const text = await res.text();
            if (!res.ok) return err('http', `HTTP ${res.status}`, url, { status: res.status, ms: Date.now() - t0, bodySnippet: text.slice(0, 200) });
            try {
                return ok(JSON.parse(text), { url, status: res.status, ms: Date.now() - t0 });
            } catch {
                // 200 但响应体不是 JSON：通常是上游/代理返回的压缩流或错误页。
                // 显式记录元信息与字节，便于区分「端点坏了」与「解析错了」。
                const meta = `content-type=${res.headers.get('content-type')} content-encoding=${res.headers.get('content-encoding')} bytes=${Buffer.byteLength(text)} head=${Buffer.from(text.slice(0, 24), 'binary').toString('hex')}`;
                return err('parse', `响应不是合法 JSON（${meta}）`, url, { status: res.status, ms: Date.now() - t0, bodySnippet: text.slice(0, 80) });
            }
        } catch (e) {
            const msg = String((e as Error)?.message ?? e);
            return err(/timeout|abort/i.test(msg) ? 'timeout' : 'network', msg, url, { ms: Date.now() - t0 });
        }
    }

    async blockNumber(): Promise<Result<string>> {
        const r = await this.rpc<string>('eth_blockNumber', []);
        if (!r.ok) return r;
        const v = r.data as unknown as string;
        return typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) ? ok(v, { url: r.url, status: 200, ms: r.ms }) : err('contract', `eth_blockNumber 返回非法: ${String(v).slice(0, 40)}`, r.url);
    }

    /**
     * eth_call。注意 rpc() 已经解包了 JSON-RPC 的 result 字段，
     * 这里拿到的是「调用返回值」本身（hex 字符串），不要再当成信封解一次。
     */
    private async ethCall(to: string, data: string): Promise<Result<string>> {
        const r = await this.rpc<string>('eth_call', [{ to, data }, 'latest']);
        if (!r.ok) return r;
        const v = r.data as unknown;
        if (typeof v !== 'string') return err('contract', `eth_call 返回非字符串: ${JSON.stringify(v).slice(0, 80)}`, r.url, { ms: r.ms });
        return ok(v, { url: r.url, status: 200, ms: r.ms });
    }

    /** 读取代理合约的控制关系证据（多签记录完整签名者集合与阈值） */
    async readControl(address: string): Promise<Result<ControlEvidence>> {
        const code = await this.rpc<string>('eth_getCode', [address, 'latest']);
        if (!code.ok) return code;
        const bytecodeSize = Math.max(0, (code.data.length - 2) / 2);
        const ownersRes = await this.ethCall(address, SELECTORS.getOwners);
        const thresholdRes = await this.ethCall(address, SELECTORS.getThreshold);
        const ownerRes = await this.ethCall(address, SELECTORS.owner);
        const bn = await this.blockNumber();

        const parseWords = (hex: string): string[] => {
            if (!hex || hex === '0x') return [];
            const body = hex.slice(2);
            const out: string[] = [];
            for (let i = 0; i + 64 <= body.length; i += 64) out.push(body.slice(i + 24, i + 64));
            return out;
        };
        let owners: string[] | null = null;
        if (ownersRes.ok && ownersRes.data !== '0x') {
            const words = parseWords(ownersRes.data);
            // 动态数组：第 0 个字是偏移，第 1 个字是长度，之后是元素
            if (words.length >= 2) {
                const n = parseInt(words[1], 16);
                if (Number.isFinite(n) && n > 0 && n <= 50 && words.length >= 2 + n) {
                    const addrs = words.slice(2, 2 + n).map((w) => '0x' + w.toLowerCase());
                    owners = addrs.filter((a) => /^0x[0-9a-f]{40}$/.test(a));
                }
            } else if (words.length === 1) {
                owners = ['0x' + words[0].toLowerCase()].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
            }
        }
        let threshold: number | null = null;
        if (thresholdRes.ok && thresholdRes.data !== '0x') {
            const n = parseInt(thresholdRes.data.slice(-64), 16);
            threshold = Number.isFinite(n) ? n : null;
        }
        let owner: string | null = null;
        if (ownerRes.ok && ownerRes.data !== '0x' && ownerRes.data.length >= 66) {
            owner = wordToAddress(ownerRes.data.slice(-64));
        }
        const verified = !!(owners?.length || owner);
        return ok({
            address: address.toLowerCase(),
            bytecodeSize,
            owner,
            owners,
            threshold,
            status: verified ? 'verified' : 'unknown',
            reason: verified ? undefined : `代理形态不支持 owner()/getOwners()（codeLength=${bytecodeSize}）`,
            blockNumber: bn.ok ? bn.data : null,
            checkedAt: new Date().toISOString(),
        }, { url: code.url, status: 200, ms: code.ms });
    }

    /** USDC.e 余额（精确到 1e6） */
    async usdcBalance(address: string): Promise<Result<string>> {
        const data = SELECTORS.erc20BalanceOf + '0'.repeat(24) + address.toLowerCase().slice(2);
        const r = await this.ethCall(USDC_E, data);
        if (!r.ok) return r;
        if (!/^0x[0-9a-f]+$/i.test(r.data)) return err('contract', `余额返回不是 hex: ${r.data.slice(0, 40)}`, r.url);
        const raw = BigInt(r.data);
        // 6 位小数 → 十进制字符串
        const s = raw.toString().padStart(7, '0');
        const int = s.slice(0, -6), frac = s.slice(-6).replace(/0+$/, '');
        return ok(`${BigInt(int).toString()}${frac ? '.' + frac : ''}`, { url: r.url, status: 200, ms: r.ms });
    }

    /** USDC.e Transfer 日志（近端区块；更老的区间需要 archive 端点，失败了就报失败） */
    async getTransfers(opts: { fromBlock: number; toBlock: number; toAddress?: string }): Promise<Result<{ count: number; logs: unknown[] }>> {
        const topics: (string | null)[] = [TRANSFER_TOPIC];
        if (opts.toAddress) { topics[1] = null; topics[2] = '0x' + '0'.repeat(24) + opts.toAddress.toLowerCase().slice(2); }
        const r = await this.rpc<unknown[]>('eth_getLogs', [{
            fromBlock: '0x' + opts.fromBlock.toString(16),
            toBlock: '0x' + opts.toBlock.toString(16),
            address: USDC_E,
            topics,
        }]);
        if (!r.ok) return r;
        const logs = Array.isArray(r.data) ? r.data : [];
        return ok({ count: logs.length, logs }, { url: r.url, status: 200, ms: r.ms });
    }
}
