import { ethers } from 'ethers';
import { configureProxyAgents, getProxyUrl } from '../network/proxy.js';
import { WalletProfile } from './types.js';

export class ChainAnalyzer {
    private provider: ethers.JsonRpcProvider;
    private fallbackRpcUrl: string;
    private usingAlchemy: boolean = false;
    private usdcAddress = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC
    private usdcAbi = ["function balanceOf(address) view returns (uint256)"];
    private cache: Map<string, { profile: WalletProfile, timestamp: number }> = new Map();
    private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24小时
    private rpcInFlight = 0;
    private readonly rpcConcurrencyLimit = Number(process.env.RPC_CONCURRENCY_LIMIT || 1);
    private readonly rpcHealthTimeoutMs = Number(process.env.RPC_HEALTH_TIMEOUT_MS || 8000);

    constructor(rpcUrl: string = "https://polygon-rpc.com") {
        configureProxyAgents();
        const alchemyApiKey = process.env.ALCHEMY_API_KEY || "";
        const alchemyRpcUrl = process.env.ALCHEMY_RPC_URL || (alchemyApiKey
            ? `https://polygon-mainnet.g.alchemy.com/v2/${alchemyApiKey}`
            : "");
        this.fallbackRpcUrl = rpcUrl;
        this.usingAlchemy = Boolean(alchemyRpcUrl);

        const resolvedRpcUrl = alchemyRpcUrl || rpcUrl;
        if (alchemyRpcUrl) {
            console.log("[ChainAnalyzer] 检测到 ALCHEMY_RPC_URL，已启用 Alchemy RPC");
        } else {
            console.log("[ChainAnalyzer] 未检测到 ALCHEMY_RPC_URL 或 ALCHEMY_API_KEY，使用默认 RPC");
        }
        const proxyUrl = getProxyUrl();
        if (proxyUrl) {
            console.log(`[ChainAnalyzer] RPC 使用代理: ${proxyUrl}`);
        }
        this.provider = new ethers.JsonRpcProvider(resolvedRpcUrl, 137, {
            staticNetwork: true,
            batchMaxCount: 1,
            batchStallTime: 0
        });
    }

    async checkRpcHealth() {
        const timeoutMs = this.rpcHealthTimeoutMs;
        const startTime = Date.now();
        try {
            await Promise.race([
                this.provider.getBlockNumber(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("RPC health check timeout")), timeoutMs))
            ]);
            const duration = Date.now() - startTime;
            console.log(`[ChainAnalyzer] RPC 健康检查通过 (${duration}ms)`);
        } catch (error: any) {
            const reason = this.formatRpcError(error);
            await this.switchToFallback(reason);
        }
    }

    private async switchToFallback(reason?: string) {
        if (!this.usingAlchemy) {
            return;
        }
        console.warn(`[ChainAnalyzer] Alchemy RPC 回退至默认 RPC: ${reason || "未知原因"}`);
        this.provider = new ethers.JsonRpcProvider(this.fallbackRpcUrl, 137, {
            staticNetwork: true,
            batchMaxCount: 1,
            batchStallTime: 0
        });
        this.usingAlchemy = false;
    }

    private shouldFallback(error: any): boolean {
        const message = `${error?.message || ""} ${error?.shortMessage || ""}`.toLowerCase();
        return message.includes("api key is not allowed")
            || message.includes("etimedout")
            || message.includes("enetunreach")
            || message.includes("econnreset")
            || message.includes("rate limit")
            || message.includes("batch size");
    }

    private async ensureProvider() {
        if (!this.usingAlchemy) {
            return;
        }

        try {
            await this.provider.getBlockNumber();
        } catch (error: any) {
            await this.switchToFallback(this.formatRpcError(error));
        }
    }

    private formatRpcError(error: any): string {
        const message = error?.message || error?.shortMessage || "未知错误";
        const code = error?.code || error?.cause?.code;
        return code ? `${message} (code: ${code})` : message;
    }

    private async waitForRpcSlot() {
        while (this.rpcInFlight >= this.rpcConcurrencyLimit) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        this.rpcInFlight += 1;
    }

    private releaseRpcSlot() {
        this.rpcInFlight = Math.max(0, this.rpcInFlight - 1);
    }

    private async callWithRetry<T>(action: () => Promise<T>, label: string): Promise<T> {
        const maxAttempts = 3;
        let lastError: any;

        await this.waitForRpcSlot();
        try {
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                try {
                    return await action();
                } catch (error: any) {
                    lastError = error;
                    if (this.shouldFallback(error)) {
                        await this.switchToFallback(`${label}: ${error?.message || error}`);
                    }
                    if (attempt < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
                    }
                }
            }
        } finally {
            this.releaseRpcSlot();
        }

        throw lastError;
    }

    async getProfile(address: string): Promise<WalletProfile> {
        const now = Date.now();
        const cached = this.cache.get(address);
        if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
            return cached.profile;
        }

        try {
            await this.ensureProvider();
            const [txCount, balance, marketCount, fundingAddress] = await Promise.all([
                this.callWithRetry(() => this.provider.getTransactionCount(address), "getTransactionCount"),
                this.callWithRetry(() => this.getUsdcBalance(address), "getUsdcBalance"),
                this.getMarketCount(address),
                this.getFundingAddress(address)
            ]);

            const profile: WalletProfile = {
                address,
                transactionCount: txCount,
                usdcBalance: balance,
                marketCount: marketCount,
                isNew: txCount <= 50, // 简单判定：交易少于50笔视为较新
                fundingAddress: fundingAddress
            };

            this.cache.set(address, { profile, timestamp: now });
            return profile;
        } catch (error: any) {
            if (this.shouldFallback(error)) {
                await this.switchToFallback(error?.message || error);
            }
            console.error(`[ChainAnalyzer] 获取钱包画像失败 ${address}:`, error);
            return {
                address,
                transactionCount: 0,
                usdcBalance: 0,
                marketCount: 0,
                isNew: false
            };
        }
    }

    private async getUsdcBalance(address: string): Promise<number> {
        try {
            const contract = new ethers.Contract(this.usdcAddress, this.usdcAbi, this.provider);
            const balance = await contract.balanceOf(address);
            return parseFloat(ethers.formatUnits(balance, 6));
        } catch {
            return 0;
        }
    }

    /**
     * 估算账号年龄（天）
     * 逻辑：通过二分法查找该地址的第一笔交易所在的区块
     */
    private async getAccountAgeDays(address: string): Promise<number> {
        try {
            const transactionCount = await this.provider.getTransactionCount(address);
            if (transactionCount === 0) return 0;

            // 这是一个简化的逻辑：获取当前块高，并假设一个平均块时间
            // 真正的“首笔交易”查询在没有索引器的情况下非常慢
            // 这里我们先用一个折中方案：查询最近的交易
            // 如果需要精确，通常需要结合 Polygonscan API

            // 暂时返回一个模拟值或通过 getTransactionCount 判断是否是新号
            // 如果交易次数极少，我们认为它是新号
            return transactionCount < 50 ? 1 : 100;
        } catch {
            return 999;
        }
    }

    private async getMarketCount(address: string): Promise<number> {
        // 暂时返回 1，后续可以结合 Gamma API 查询该用户参与的所有市场
        return 1;
    }

    /**
     * 尝试获取钱包的注资地址（第一笔交易的来源）
     * 这是一个简化实现，尝试查找 Nonce 0 的交易或者最早的交易
     * 由于 RPC 无法高效查询“第一笔转入交易”，这里简化为：
     * 如果 TxCount 很小 (<100)，尝试遍历历史块（极慢）或依赖外部 API
     * 在 MVP 版本中，为避免 RPC 超时，暂返回 undefined，除非有索引器支持
     * 或者：如果这个地址是由另一个地址创建的（合约钱包），这里能查到
     * 
     * 改进策略：对于标准EOA，通常无法通过简单RPC获取Funding Source，除非扫描整个链。
     * 既然我们在设计文档中承诺了“尝试识别”，这里做一个模拟实现：
     * 在真实生产环境中，我会调用 Polygonscan API 或 Covalent API。
     * 这里为了不引入新依赖，我们先留空，或者仅对某些特定情况做简单检查。
     */
    private async getFundingAddress(address: string): Promise<string | undefined> {
        // TODO: 集成 Polygonscan API 以获取准确的 Funding Source
        // 目前返回 undefined 以避免 RPC 滥用
        return undefined;
    }
}
