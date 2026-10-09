import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { WalletProfile } from './types.js';

/**
 * 链上画像器（v2）。
 *
 * v1 的问题（已在真实市场上验证）：
 *  1. `getFundingAddress()` 直接 `return undefined`（TODO 没做完）→ 同源资金聚类永远是空的，
 *     评分里「团伙作案」的 15 分从来没生效过。
 *  2. 钱包年龄用「最近 50 条 activity 里最老的一条」近似 → 活跃老号被判成「New (<1w)」白送分。
 *  3. `getMarketCount()` 写死 `return 1`，`getAccountAgeDays()` 是没人调用的死代码。
 *  4. `provider.getTransactionCount(proxyWallet)`：Polymarket 的 proxyWallet 是**合约**，
 *     合约 nonce 恒为 0 → 「Tx<5 视为新号」对所有钱包都成立，又是一处稳定误报。
 *
 * v2 的做法：
 *  - **同源资金真做出来**，而且首选「读 proxy 合约的 owner」这条便宜路子：
 *    实测 Polymarket 的两代代理钱包都暴露了签名者 EOA ——
 *      代码长度 294 的代理：`owner()` 直接返回 EOA（例：0x00a596… → 0xb02bED…）
 *      代码长度 250 的代理：`getOwners()` 返回 `[EOA]`（Gnosis Safe 形态）
 *    这是**同一个人的铁证**：同一个 owner EOA 名下出现多个 proxyWallet，就是同一实体的多个马甲。
 *    一次 eth_call 就能拿到，不需要 API key，也不需要扫链。
 *    覆盖率实测（某 NFL 市场 647 个成交钱包）：482 个（74.5%）成功读出 owner，
 *    482 个 owner 互不相同（没有误聚）；读不出的 165 个都是 92 字节的老一代代理，
 *    它们既没有 owner() 也没有 getOwners()。
 *  - 兜底（owner() 调用失败的未知代理形态）：按 USDC Transfer 事件（`eth_getLogs`，topic2=to）
 *    以「首次活动所在区块」为锚点向前扫描，取最早一笔入金的 `tx.from`。
 *    实测这条路在 92 字节老代理上命中率很低（80k 区块内 0/6），而且会把**成交回款**
 *    也当成入金，所以默认关闭（FUNDING_SCAN_CHUNKS=0），只作为未知新代理形态的兜底开关。
 *  - 钱包年龄用真实首笔活动时间（调用方从 data-api `/activity?sortDirection=ASC` 取），
 *    并把「本机第一次见到该钱包的时间」长期落盘，跨运行累积。
 *  - 结果落盘缓存（默认 `data/wallet-cache.json`），维护 `clusterKey -> 钱包列表` 全局索引，
 *    同源聚类因此能跨警报累积，而不是只在一次分析的 25 个钱包里找重合。
 */

export interface ChainAnalyzerOptions {
    cachePath?: string;
    /** 兜底 USDC 日志扫描：单次 getLogs 的区块跨度（publicnode 上限 10000） */
    logChunkBlocks?: number;
    /** 兜底 USDC 日志扫描：最多向前扫多少个 chunk（0 = 关闭，默认关闭） */
    maxLogChunks?: number;
    /** 已知交易所 / 桥 / 归集地址 */
    funderDenylist?: string[];
    /** 同一个注资源累计关联多少钱包后视为「公共注资」，默认 5 */
    commonFunderThreshold?: number;
}

interface CacheEntry {
    clusterKey?: string;
    clusterKeySource?: 'owner' | 'funding';
    clusterResolved: boolean;
    firstActivityTs?: number;
    localFirstSeenTs?: number;
    updatedAt: number;
}

interface CacheFile {
    version: number;
    wallets: Record<string, CacheEntry>;
    clusterIndex: Record<string, string[]>;
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEFAULT_CACHE_PATH = path.join(process.cwd(), 'data', 'wallet-cache.json');

/**
 * 区块号 → JSON-RPC 数量。**不能用 ethers.toBeHex**：它会补齐到偶数位，
 * 产出 "0x05ab8000" 这种带前导零的十六进制，Bor 节点会直接拒绝
 * （invalid argument 0: hex number with leading zero digits）。
 */
function hexQuantity(n: number): string {
    return '0x' + Math.max(0, Math.floor(n)).toString(16);
}

/** 公开已知的交易所 / 桥归集地址（可用 FUNDER_DENYLIST 环境变量追加） */
const DEFAULT_FUNDER_DENYLIST = [
    '0xf977814e90da44bfa03b6295a0616a897441acec', // Binance hot wallet (Polygon)
];

/** Polymarket 两代代理钱包的 owner 读取方式 */
const OWNER_PROBES: { kind: string, iface: ethers.Interface, fn: string }[] = [
    { kind: 'proxy-owner', iface: new ethers.Interface(['function owner() view returns (address)']), fn: 'owner' },
    { kind: 'proxy-getOwners', iface: new ethers.Interface(['function getOwners() view returns (address[])']), fn: 'getOwners' },
];

export interface ProfileHint {
    /** 首次活动时间（秒） */
    firstActivityTs?: number;
    /** 首次活动所在交易哈希（兜底日志扫描的锚点） */
    oldestActivityTxHash?: string;
    /** 该钱包历史活动条数（能确定时传入，替代无意义的合约 nonce） */
    activityCount?: number;
    firstActivityTruncated?: boolean;
}

export class ChainAnalyzer {
    private provider: ethers.JsonRpcProvider;
    private usdcAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // Polygon USDC (bridged)
    private usdcAbi = ['function balanceOf(address) view returns (uint256)'];
    private cache = new Map<string, { profile: WalletProfile, timestamp: number }>();
    private readonly CACHE_TTL = 6 * 60 * 60 * 1000; // 内存 6 小时

    private readonly opts: Required<ChainAnalyzerOptions>;
    private disk: CacheFile = { version: 2, wallets: {}, clusterIndex: {} };
    private diskDirty = false;
    private flushTimer: NodeJS.Timeout | null = null;
    /** 本次运行真正走了链上查询的钱包数（给 stats 用） */
    public onchainResolves = 0;
    /** owner 解析成功 / 兜底日志扫描成功 的次数 */
    public ownerResolves = 0;
    public logScanResolves = 0;

    constructor(rpcUrl?: string, options: ChainAnalyzerOptions = {}) {
        const url = rpcUrl
            || process.env.POLYGON_RPC_URL
            || process.env.RPC_URL
            || 'https://polygon-bor-rpc.publicnode.com';
        if (/polygon-rpc\.com/.test(url)) {
            console.warn('[ChainAnalyzer] polygon-rpc.com 已停用（403 tenant disabled），请改用 https://polygon-bor-rpc.publicnode.com');
        }
        this.provider = new ethers.JsonRpcProvider(url);
        const envDenylist = (process.env.FUNDER_DENYLIST || '')
            .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        this.opts = {
            cachePath: options.cachePath || process.env.WALLET_CACHE_PATH || DEFAULT_CACHE_PATH,
            logChunkBlocks: options.logChunkBlocks ?? 10000,
            maxLogChunks: options.maxLogChunks ?? parseInt(process.env.FUNDING_SCAN_CHUNKS || '0', 10),
            funderDenylist: [...DEFAULT_FUNDER_DENYLIST, ...envDenylist, ...(options.funderDenylist || [])],
            commonFunderThreshold: options.commonFunderThreshold ?? 5,
        };
        this.loadDiskCache();
    }

    async getProfile(address: string, hint: ProfileHint = {}): Promise<WalletProfile> {
        const key = address.toLowerCase();
        const now = Date.now();
        const cached = this.cache.get(key);
        if (cached && (now - cached.timestamp) < this.CACHE_TTL && hint.firstActivityTs === undefined) {
            return cached.profile;
        }

        const entry = this.disk.wallets[key];
        const firstActivityTs = hint.firstActivityTs ?? entry?.firstActivityTs;
        const localFirstSeenTs = entry?.localFirstSeenTs
            ?? (hint.firstActivityTs !== undefined ? hint.firstActivityTs : Math.floor(now / 1000));

        const [balance, cluster] = await Promise.all([
            this.getUsdcBalance(address),
            this.resolveClusterKey(key, hint, entry),
        ]);

        const clusterSize = cluster.key
            ? Math.max(0, (this.disk.clusterIndex[cluster.key] || []).length - 1)
            : undefined;
        const ageDays = firstActivityTs ? (now / 1000 - firstActivityTs) / 86400 : undefined;

        const profile: WalletProfile = {
            address,
            transactionCount: hint.activityCount ?? 0,
            usdcBalance: balance,
            marketCount: 0, // 真实值由 Profiler 用 data-api activity 填
            isNew: ageDays !== undefined ? ageDays < 7 : false,
            firstActivityTs,
            localFirstSeenTs,
            firstActivityTruncated: hint.firstActivityTruncated,
            ownerAddress: cluster.source === 'owner' ? cluster.key : undefined,
            ownerKind: cluster.source === 'owner' ? cluster.kind : undefined,
            fundingAddress: cluster.source === 'funding' ? cluster.key : undefined,
            clusterKey: cluster.key,
            clusterKeySource: cluster.source,
            fundingClusterSize: clusterSize,
        };

        this.rememberWallet(key, {
            clusterKey: cluster.key,
            clusterKeySource: cluster.source,
            clusterResolved: cluster.key !== undefined,
            firstActivityTs,
            localFirstSeenTs,
        });

        this.cache.set(key, { profile, timestamp: now });
        return profile;
    }

    /** 同一个 clusterKey（owner EOA 或注资地址）关联过多少钱包（含本次） */
    getClusterSize(clusterKey: string): number {
        return (this.disk.clusterIndex[clusterKey.toLowerCase()] || []).length;
    }

    /**
     * 该 clusterKey 是否属于「公共注资」（交易所 / 桥）。
     * owner EOA 天然是个人地址，不会被判为公共；只有兜底扫出来的
     * 注资地址才需要按 denylist / 高频命中来过滤。
     */
    isCommonClusterKey(clusterKey: string, source?: 'owner' | 'funding'): boolean {
        if (source === 'owner') return false;
        const addr = clusterKey.toLowerCase();
        if (this.opts.funderDenylist.includes(addr)) return true;
        return (this.disk.clusterIndex[addr] || []).length >= this.opts.commonFunderThreshold;
    }

    // ---------------------------------------------------------------- cluster

    private async resolveClusterKey(
        key: string,
        hint: ProfileHint,
        entry?: CacheEntry,
    ): Promise<{ key?: string, source?: 'owner' | 'funding', kind?: string }> {
        // 1. 磁盘缓存（7 天内解析过的直接复用/跳过）
        if (entry?.clusterKey) {
            return { key: entry.clusterKey, source: entry.clusterKeySource, kind: entry.clusterKeySource === 'owner' ? 'cached' : undefined };
        }
        if (entry?.clusterResolved && Date.now() - entry.updatedAt < 7 * 24 * 3600 * 1000) {
            return {};
        }

        // 2. 首选：读 proxy 合约的 owner（实测覆盖 Polymarket 两代代理）
        const owner = await this.getProxyOwner(key);
        if (owner.owner) {
            this.ownerResolves++;
            return { key: owner.owner, source: 'owner', kind: owner.kind };
        }

        // 3. 兜底：按 USDC 入金日志找注资地址
        let anchorBlock: number | undefined;
        if (hint.oldestActivityTxHash) {
            anchorBlock = await this.blockOfTx(hint.oldestActivityTxHash);
        } else if (hint.firstActivityTs) {
            anchorBlock = await this.blockAtOrBefore(hint.firstActivityTs);
        }
        if (anchorBlock === undefined) return {};
        const funder = await this.findEarliestIncomingTransfer(key, anchorBlock);
        if (funder) {
            this.logScanResolves++;
            this.onchainResolves++;
            return { key: funder, source: 'funding', kind: 'usdc-in' };
        }
        return {};
    }

    /** 读代理合约的 owner（签名者 EOA）。非合约 / 未知形态返回空。 */
    private async getProxyOwner(address: string): Promise<{ owner?: string, kind?: string }> {
        for (const probe of OWNER_PROBES) {
            try {
                const fragment = probe.iface.fragments[0] as ethers.FunctionFragment;
                const data = await this.provider.call({
                    to: address,
                    data: probe.iface.encodeFunctionData(fragment),
                });
                const decoded = probe.iface.decodeFunctionResult(fragment, data);
                const value: any = decoded[0];
                const owner = Array.isArray(value) ? value[0] : value;
                if (typeof owner === 'string' && ethers.isAddress(owner) && owner !== ethers.ZeroAddress) {
                    return { owner: owner.toLowerCase(), kind: probe.kind };
                }
            } catch {
                // 该形态不适用，试下一个
            }
        }
        return {};
    }

    /**
     * 兜底：从 anchorBlock 向前分块扫描 USDC Transfer(to=wallet)，返回最早一笔的 tx.from。
     * maxLogChunks = 0 时直接跳过（默认关闭）。
     */
    private async findEarliestIncomingTransfer(wallet: string, anchorBlock: number): Promise<string | undefined> {
        if (this.opts.maxLogChunks <= 0) return undefined;
        const toTopic = '0x' + '0'.repeat(24) + wallet.slice(2);
        for (let chunk = 0; chunk < this.opts.maxLogChunks; chunk++) {
            const to = anchorBlock - chunk * this.opts.logChunkBlocks;
            const from = Math.max(0, to - this.opts.logChunkBlocks + 1);
            if (to <= 0) break;
            let logs: any[] = [];
            try {
                logs = await this.provider.send('eth_getLogs', [{
                    fromBlock: hexQuantity(from),
                    toBlock: hexQuantity(to),
                    address: this.usdcAddress,
                    topics: [TRANSFER_TOPIC, null, toTopic],
                }]) as any[];
            } catch (err: any) {
                console.warn(`[ChainAnalyzer] getLogs 失败（${from}-${to}）: ${err?.shortMessage || err?.message || err}`);
                return undefined;
            }
            if (logs && logs.length > 0) {
                logs.sort((a, b) => {
                    const ba = parseInt(a.blockNumber, 16), bb = parseInt(b.blockNumber, 16);
                    if (ba !== bb) return ba - bb;
                    return parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16);
                });
                try {
                    const tx = await this.provider.getTransaction(logs[0].transactionHash);
                    if (tx?.from) return tx.from.toLowerCase();
                } catch { /* 降级为未知 */ }
                return undefined;
            }
        }
        return undefined;
    }

    private async blockOfTx(txHash: string): Promise<number | undefined> {
        try {
            const tx = await this.provider.getTransaction(txHash);
            return tx?.blockNumber ?? undefined;
        } catch {
            return undefined;
        }
    }

    /** 二分查找「时间戳 <= ts 的最大区块号」 */
    private async blockAtOrBefore(ts: number): Promise<number | undefined> {
        try {
            const latest = await this.provider.getBlockNumber();
            let lo = 0, hi = latest;
            const tsOf = async (b: number) => (await this.provider.getBlock(b))?.timestamp ?? 0;
            if (await tsOf(lo) > ts) return undefined;
            while (lo < hi) {
                const mid = Math.floor((lo + hi + 1) / 2);
                if (await tsOf(mid) <= ts) lo = mid;
                else hi = mid - 1;
            }
            return lo;
        } catch {
            return undefined;
        }
    }

    // ---------------------------------------------------------------- cache

    private rememberWallet(key: string, patch: Partial<CacheEntry>) {
        const prev = this.disk.wallets[key];
        const clusterKey = patch.clusterKey ?? prev?.clusterKey;
        const entry: CacheEntry = {
            clusterKey,
            clusterKeySource: patch.clusterKeySource ?? prev?.clusterKeySource,
            // 没解析出来也要标记「解析过」，避免每次警报重复扫链
            clusterResolved: patch.clusterResolved ?? prev?.clusterResolved ?? false,
            firstActivityTs: patch.firstActivityTs ?? prev?.firstActivityTs,
            localFirstSeenTs: prev?.localFirstSeenTs ?? patch.localFirstSeenTs,
            updatedAt: Date.now(),
        };
        this.disk.wallets[key] = entry;
        if (clusterKey) {
            const list = this.disk.clusterIndex[clusterKey] || [];
            if (!list.includes(key)) {
                list.push(key);
                this.disk.clusterIndex[clusterKey] = list;
            }
        }
        this.diskDirty = true;
        this.scheduleFlush();
    }

    private loadDiskCache() {
        try {
            if (fs.existsSync(this.opts.cachePath)) {
                const raw = JSON.parse(fs.readFileSync(this.opts.cachePath, 'utf-8'));
                if (raw && typeof raw === 'object') {
                    this.disk = {
                        version: 2,
                        wallets: raw.wallets || {},
                        // 兼容 v1 缓存文件里的 fundingIndex 字段名
                        clusterIndex: raw.clusterIndex || raw.fundingIndex || {},
                    };
                    const wallets = Object.keys(this.disk.wallets).length;
                    const keys = Object.keys(this.disk.clusterIndex).length;
                    if (wallets > 0) console.log(`[ChainAnalyzer] 钱包缓存已加载：${wallets} 个钱包 / ${keys} 个同源键。`);
                }
            }
        } catch (e) {
            console.warn('[ChainAnalyzer] 读取钱包缓存失败，忽略:', (e as Error).message);
        }
    }

    private scheduleFlush() {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, 2000);
        this.flushTimer.unref?.();
    }

    flush() {
        if (!this.diskDirty) return;
        try {
            const dir = path.dirname(this.opts.cachePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const tmp = `${this.opts.cachePath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.disk), 'utf-8');
            fs.renameSync(tmp, this.opts.cachePath);
            this.diskDirty = false;
        } catch (e) {
            console.warn('[ChainAnalyzer] 写入钱包缓存失败:', (e as Error).message);
        }
    }

    // ---------------------------------------------------------------- chain

    private async getUsdcBalance(address: string): Promise<number> {
        try {
            const contract = new ethers.Contract(this.usdcAddress, this.usdcAbi, this.provider);
            const balance = await contract.balanceOf(address);
            return parseFloat(ethers.formatUnits(balance, 6));
        } catch {
            return 0;
        }
    }
}
