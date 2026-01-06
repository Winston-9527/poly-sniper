import { ethers } from 'ethers';
import { WalletProfile } from './types.js';

export class ChainAnalyzer {
    private provider: ethers.JsonRpcProvider;
    private usdcAddress = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC
    private usdcAbi = ["function balanceOf(address) view returns (uint256)"];
    private cache: Map<string, { profile: WalletProfile, timestamp: number }> = new Map();
    private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24小时

    constructor(rpcUrl: string = "https://polygon-rpc.com") {
        this.provider = new ethers.JsonRpcProvider(rpcUrl);
    }

    async getProfile(address: string): Promise<WalletProfile> {
        const now = Date.now();
        const cached = this.cache.get(address);
        if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
            return cached.profile;
        }

        try {
            const [txCount, balance, marketCount, fundingAddress] = await Promise.all([
                this.provider.getTransactionCount(address),
                this.getUsdcBalance(address),
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
        } catch (error) {
            console.error(`[ChainAnalyzer] 获取钱包画像失败 ${address}:`, error);
            return {
                address,
                transactionCount: 999,
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
