import { ClobClient } from '@polymarket/clob-client';
import { fetch } from 'undici';
import fs from 'fs';
import path from 'path';
import { AnomalyDetector } from './AnomalyDetector.js';
import { MarketFilter } from './MarketFilter.js';
import { TelegramMessenger } from './TelegramMessenger.js';
import { Profiler } from './Profiler.js';
import { GammaClient } from './GammaClient.js';
import { ChainAnalyzer } from './ChainAnalyzer.js';
import { Scorer } from './Scorer.js';
import { AnomalyWebhookPayload, MarketUpdate } from './types.js';
import { shouldUseRemoteProfiler, withHighPriority } from "../workflow/analysisRunner.js";
import { enqueueAnalysisTask } from "../workflow/analysisQueue.js";
import { configureProxyAgents, getProxyUrl, getUndiciDispatcher } from '../network/proxy.js';
import { recordPrice } from './priceHistory.js';

configureProxyAgents();
const proxyUrl = getProxyUrl();
const globalProxyAgent = getUndiciDispatcher();
if (proxyUrl) {
    console.log(`检测到代理设置: ${proxyUrl}，正在配置代理...`);
}

export interface SentinelConfig {
    manualTokenIds?: string[];
}

export class Sentinel {
    private clobClient: ClobClient;
    private detector: AnomalyDetector;
    private filter: MarketFilter;
    private messenger: TelegramMessenger;
    private profiler: Profiler;
    private marketMetadataMap: Map<string, any> = new Map();
    private manualTokenIds: string[] = [];
    private pollingInterval: NodeJS.Timeout | null = null;
    private refreshInterval: NodeJS.Timeout | null = null;
    private messageCount: number = 0;
    private readonly csvPath = path.join(process.cwd(), 'data', 'markets.csv');
    private readonly webhookUrl = process.env.LANGGRAPH_WEBHOOK_URL || "";
    private readonly analysisCooldownMs = Number(process.env.ANALYSIS_COOLDOWN_MS || 1500);
    private readonly pollingIntervalMs = Number(process.env.POLLING_INTERVAL_MS || 15000);
    private readonly pollingConcurrencyLimit = Number(process.env.POLLING_CONCURRENCY_LIMIT || 4);
    private pollingInFlight = 0;
    private readonly highPriorityPollingIntervalMs = Number(process.env.HIGH_PRIORITY_POLLING_INTERVAL_MS || 30000);

    constructor(configOrUrl: string | SentinelConfig = "https://clob.polymarket.com", manualTokenIds: string[] = []) {
        let url = "https://clob.polymarket.com";
        if (typeof configOrUrl === 'string') {
            url = configOrUrl;
            this.manualTokenIds = manualTokenIds;
        } else {
            this.manualTokenIds = configOrUrl.manualTokenIds || [];
        }

        this.clobClient = new ClobClient(url, 137);
        // 修复 AnomalyDetector 初始化：阈值 0.05 (5%), 窗口 5 分钟
        this.detector = new AnomalyDetector(0.05, 5);
        this.filter = new MarketFilter();

        const gamma = new GammaClient();
        const analyzer = new ChainAnalyzer(process.env.POLYGON_RPC_URL);
        const scorer = new Scorer();
        this.profiler = new Profiler(gamma, analyzer, scorer);

        // Messenger 需要 Profiler 以支持手动分析指令
        this.messenger = new TelegramMessenger(this.profiler);
    }

    async start() {
        try {
            // 1. 先尝试从本地 CSV 加载
            this.loadFromCsv();

            await this.profiler.warmup();

            // 2. 启动定时刷新任务（每小时一次）
            this.startMetadataRefresh();

            // 3. 如果本地没数据，立即执行一次全量加载
            if (this.marketMetadataMap.size === 0) {
                console.log("本地无市场数据，正在执行首次全量加载...");
                await this.loadMarkets();
            }

            console.log("正在启动 REST 轮询监控...");
            this.startPolling();
        } catch (err: any) {
            console.error("Sentinel 启动失败:", err);
            throw err;
        }
    }

    private loadFromCsv() {
        if (fs.existsSync(this.csvPath)) {
            try {
                const content = fs.readFileSync(this.csvPath, 'utf-8');
                const lines = content.split('\n');
                let count = 0;
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const parts = line.split(',');
                    if (parts.length < 2) continue;

                    let tokenId, category, slug, outcome, title;
                    if (parts.length === 2) {
                        // 旧格式: tokenId, title
                        [tokenId, title] = parts;
                        category = "Unknown";
                        slug = "";
                        outcome = "";
                    } else if (parts.length === 3) {
                        // 中间格式: tokenId, category, title
                        [tokenId, category, title] = parts;
                        slug = "";
                        outcome = "";
                    } else if (parts.length === 4) {
                        // 之前格式: tokenId, category, slug, title
                        [tokenId, category, slug, title] = parts;
                        outcome = "";
                    } else {
                        // 最新格式: tokenId, category, slug, outcome, title...
                        tokenId = parts[0];
                        category = parts[1];
                        slug = parts[2];
                        outcome = parts[3];
                        title = parts.slice(4).join(',');
                    }

                    if (tokenId && title) {
                        this.marketMetadataMap.set(tokenId, {
                            title,
                            marketId: tokenId,
                            category: category || "Unknown",
                            slug: slug || "",
                            outcome: outcome || ""
                        });
                        count++;
                    }
                }
                console.log(`从本地 CSV 加载了 ${count} 个市场元数据。`);
            } catch (e) {
                console.warn("读取本地 CSV 失败:", e);
            }
        }
    }

    private saveToCsv() {
        try {
            const dir = path.dirname(this.csvPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            let csvContent = "";
            this.marketMetadataMap.forEach((meta, id) => {
                // 简单处理 CSV 转义：去掉换行，逗号保留（读取时特殊处理）
                const safeTitle = meta.title.replace(/[\n\r]/g, " ");
                const category = meta.category || "Unknown";
                const slug = meta.slug || "";
                const outcome = meta.outcome || "";
                csvContent += `${id},${category},${slug},${outcome},${safeTitle}\n`;
            });
            fs.writeFileSync(this.csvPath, csvContent, 'utf-8');
            console.log(`市场元数据已保存至 ${this.csvPath}`);
        } catch (e) {
            console.error("保存 CSV 失败:", e);
        }
    }

    private startMetadataRefresh() {
        if (this.refreshInterval) return;
        // 每小时刷新一次 (3600000 ms)
        this.refreshInterval = setInterval(async () => {
            console.log("\n[系统] 正在执行每小时市场元数据刷新...");
            await this.loadMarkets();
        }, 3600000);
    }

    private async loadMarkets() {
        try {
            // 如果有手动指定的 Token，先确保它们在 Map 中
            if (this.manualTokenIds.length > 0) {
                console.log(`正在手动添加 ${this.manualTokenIds.length} 个测试 Token...`);
                for (const id of this.manualTokenIds) {
                    if (!this.marketMetadataMap.has(id)) {
                        this.marketMetadataMap.set(id, { title: `测试资产 (${id.substring(0, 8)})` });
                    }
                }
            }

            // 尝试从 Gamma 获取更多市场信息
            let offset = 0;
            let limit = 100;
            let hasMore = true;
            let retryCount = 0;
            const maxRetries = 3;

            // 全量加载所有活跃市场
            while (hasMore) {
                console.log(`正在获取市场数据 (offset: ${offset}, limit: ${limit})...`);
                try {
                    const response = await fetch(`https://gamma-api.polymarket.com/markets?limit=${limit}&offset=${offset}&active=true&closed=false`, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Accept': 'application/json'
                        },
                        dispatcher: globalProxyAgent,
                        // @ts-ignore
                        signal: AbortSignal.timeout(20000)
                    });

                    if (!response.ok) {
                        const errorText = await response.text().catch(() => "无法读取错误响应体");
                        throw new Error(`Gamma API 返回错误: ${response.status} ${response.statusText} - 内容: ${errorText.substring(0, 200)}`);
                    }

                    const markets: any = await response.json();

                    if (!Array.isArray(markets)) {
                        console.error("Gamma API 返回的不是数组:", markets);
                        hasMore = false;
                        break;
                    }

                    if (markets.length === 0) {
                        hasMore = false;
                        break;
                    }

                    for (const market of markets) {
                        const tokenIds = JSON.parse(market.clobTokenIds || "[]");
                        const outcomes = JSON.parse(market.outcomes || "[]");
                        const category = market.category || "Unknown";
                        const slug = market.slug || "";
                        // 获取流动性，如果没有或解析失败则设为 -1 (不因API缺失错误而过滤，但如果是0则会被过滤)
                        const liquidity = market.liquidity ? parseFloat(market.liquidity) : -1;

                        tokenIds.forEach((tokenId: string, index: number) => {
                        const volume = market.volumeNum ?? (market.volume ? parseFloat(market.volume) : undefined);
                        this.marketMetadataMap.set(tokenId, {
                            title: market.question,
                            marketId: tokenId,
                            category: category,
                            slug: slug,
                            outcome: outcomes[index] || "",
                            conditionId: market.conditionId,
                            liquidity: liquidity,
                            tvl: liquidity,
                            volume
                        });

                        });
                    }

                    offset += limit;
                    if (markets.length < limit) hasMore = false;
                    retryCount = 0;
                } catch (fetchErr: any) {
                    const errorMsg = fetchErr.message || fetchErr;

                    if (retryCount < maxRetries) {
                        retryCount++;
                        console.warn(`获取市场数据失败 (offset: ${offset}): ${errorMsg}`);
                        console.warn(`正在进行第 ${retryCount} 次重试 (等待 3 秒)...`);
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        continue;
                    }
                    console.error(`获取市场数据最终失败 (offset: ${offset}):`, fetchErr);
                    hasMore = false;
                }
            }

            // 针对手动指定的 Token ID，尝试单独获取其元数据以确保有正确的标题
            for (const id of this.manualTokenIds) {
                if (!this.marketMetadataMap.has(id) || this.marketMetadataMap.get(id)?.title.startsWith("测试资产")) {
                    try {
                        const response = await fetch(`https://gamma-api.polymarket.com/markets?clob_token_ids=${id}`, {
                            dispatcher: globalProxyAgent
                        });
                        if (response.ok) {
                            const markets: any = await response.json();
                            if (Array.isArray(markets) && markets.length > 0) {
                                const market = markets[0];
                                const tokenIds = JSON.parse(market.clobTokenIds || "[]");
                                const outcomes = JSON.parse(market.outcomes || "[]");
                                if (tokenIds.includes(id)) {
                                    const index = tokenIds.indexOf(id);
                                    const marketLiquidity = market.liquidity ? parseFloat(market.liquidity) : -1;
                                    const marketVolume = market.volumeNum ?? (market.volume ? parseFloat(market.volume) : undefined);
                                    this.marketMetadataMap.set(id, {
                                        title: market.question,
                                        marketId: id,
                                        category: market.category || "Unknown",
                                        slug: market.slug || "",
                                        outcome: outcomes[index] || "",
                                        conditionId: market.conditionId,
                                        liquidity: marketLiquidity,
                                        tvl: marketLiquidity > 0 ? marketLiquidity : undefined,
                                        volume: marketVolume
                                    });

                                }
                            }
                        }
                    } catch (e) {
                        // 忽略错误
                    }
                }
            }

            console.log(`已加载 ${this.marketMetadataMap.size} 个符合条件的 Token。`);
            this.saveToCsv();
        } catch (error: any) {
            console.error("加载市场过程中发生严重错误:", error);
        }
    }

    private async lazyFetchMetadata(tokenId: string) {
        try {
            const response = await fetch(`https://clob.polymarket.com/ticker?token_id=${tokenId}`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                dispatcher: globalProxyAgent
            });

            if (response.ok) {
                const data: any = await response.json();
                if (data && data.markets && data.markets.length > 0) {
                    const market = data.markets[0];
                    const tokenIds = JSON.parse(market.clobTokenIds || "[]");
                    const outcomes = JSON.parse(market.outcomes || "[]");
                    const index = tokenIds.indexOf(tokenId);
                    const marketLiquidity = market.liquidity ? parseFloat(market.liquidity) : -1;
                    const marketVolume = market.volumeNum ?? (market.volume ? parseFloat(market.volume) : undefined);
                    this.marketMetadataMap.set(tokenId, {
                        title: market.question,
                        marketId: tokenId,
                        category: market.category || "Unknown",
                        slug: market.slug || "",
                        outcome: outcomes[index] || "",
                        conditionId: market.conditionId,
                        liquidity: marketLiquidity,
                        tvl: marketLiquidity > 0 ? marketLiquidity : undefined,
                        volume: marketVolume
                    });

                    if (market.slug) {
                        this.enrichMetadataFromPolymarket(tokenId, market.slug).catch(() => {});
                    }
                }

            }
        } catch (e) {
            // 静默失败
        }
    }

    private getSampledIndices(total: number): Set<number> {
        const sampleSize = Math.min(10, total);
        const seed = 20250201;
        let state = seed;

        const next = () => {
            state = (state * 1664525 + 1013904223) >>> 0;
            return state / 2 ** 32;
        };

        const indices = new Set<number>();
        while (indices.size < sampleSize) {
            const index = Math.floor(next() * total);
            indices.add(index);
        }
        return indices;
    }

    private startPolling() {
        if (this.pollingInterval) return;

        console.log(`启动价格轮询 (每 ${this.pollingIntervalMs / 1000} 秒一次)...`);
        this.pollingInterval = setInterval(async () => {
            if (this.pollingInFlight >= this.pollingConcurrencyLimit) {
                console.warn("[Polling] 上一轮未完成，跳过本轮");
                return;
            }

            this.pollingInFlight += 1;
            try {
                const response = await fetch("https://clob.polymarket.com/sampling-simplified-markets", {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'application/json'
                    },
                    dispatcher: globalProxyAgent
                });

                if (response.ok) {
                    const result: any = await response.json();
                    // API 返回结构是 { data: [...] }
                    if (result && Array.isArray(result.data)) {
                        let tokenCount = 0;
                        result.data.forEach((market: any) => {
                            if (market.tokens && Array.isArray(market.tokens)) {
                                tokenCount += market.tokens.length;
                            }
                        });
                        console.log(`[Polling] 本轮市场数: ${result.data.length}，token 数: ${tokenCount}`);
                        const sampledIndices = this.getSampledIndices(result.data.length);
                        result.data.forEach((market: any, index: number) => {
                            if (market.tokens && Array.isArray(market.tokens)) {
                                for (const token of market.tokens) {
                                    this.handleUpdate(token.token_id, token.price);
                                }

                                if (sampledIndices.has(index)) {
                                    const firstToken = market.tokens[0];
                                    const metadata = this.marketMetadataMap.get(firstToken.token_id);
                                    console.log(`[监控抽样] 第 ${index + 1} 个市场: ${metadata?.title || '加载中...'} - 价格: ${firstToken.price}`);
                                }
                            }
                        });
                    }
                } else {
                    console.warn(`轮询请求失败: ${response.status} ${response.statusText}`);
                }

                if (this.manualTokenIds.length > 0) {
                    for (const tokenId of this.manualTokenIds) {
                        try {
                            const priceData = await this.clobClient.getLastTradePrice(tokenId);
                            if (priceData && priceData.price) {
                                this.handleUpdate(tokenId, parseFloat(priceData.price));
                            }
                        } catch (e) { }
                    }
                }
            } catch (err: any) {
                // 轮询错误不打印堆栈，避免刷屏
                console.error("轮询请求失败:", err.message || err);
            } finally {
                this.pollingInFlight = Math.max(0, this.pollingInFlight - 1);
            }
        }, this.pollingIntervalMs);

    }

    private handleUpdate(marketId: string, price: number) {
        // 如果没有元数据，先创建一个占位符，这样就不会漏掉异动
        if (!this.marketMetadataMap.has(marketId)) {
            this.marketMetadataMap.set(marketId, { title: `未知资产 (${marketId.substring(0, 8)})` });
            // 异步去查一下这个 ID 的真实标题
            this.lazyFetchMetadata(marketId);
        }

        const metadata = this.marketMetadataMap.get(marketId);

        if (metadata && metadata.slug && (metadata.tvl === undefined || metadata.volume === undefined)) {
            this.enrichMetadataFromPolymarket(marketId, metadata.slug).catch(() => {});
        }

        // 如果有元数据但没有 slug 或 outcome（可能是旧 CSV 导入的），尝试异步更新
        if (metadata && (!metadata.slug || !metadata.outcome)) {
            this.lazyFetchMetadata(marketId);
        }

        // 过滤掉不需要的市场（如 Crypto, Sports）
        if (metadata && !this.filter.shouldInclude(metadata)) {
            return;
        }

        // 只推送单边市场（Yes）
        if (metadata && metadata.outcome && metadata.outcome !== "Yes") {
            return;
        }

        if (this.manualTokenIds.includes(marketId)) {
            console.log(`[价格更新] ${new Date().toLocaleTimeString()} - 市场: ${metadata?.title} - 价格: ${price}`);
        }

        this.messageCount++;
        if (this.messageCount % 500 === 0) {
            console.log(`[系统存活] ${new Date().toLocaleTimeString()} - 已处理 ${this.messageCount} 条价格更新...`);
        }

        recordPrice(marketId, price, Date.now());

        const update: MarketUpdate = {
            marketId,
            price,
            timestamp: Date.now()
        };

        const anomaly = this.detector.processUpdate(update);
        if (anomaly) {
            console.log(`\n` + "=".repeat(50));
            console.log(`[!!! 异动警报 !!!] ${new Date().toLocaleTimeString()}`);
            console.log(`资产: ${metadata?.title}`);
            console.log(`幅度: ${anomaly.changePercentage}`);
            console.log(`价格: ${price.toFixed(4)}`);
            console.log("=".repeat(50) + `\n`);

            // 异步执行画像分析并推送
            if (metadata) {
                this.enqueueAnalysis(anomaly, metadata);
            }
        }
    }

    private async handleAnomaly(anomaly: any, metadata: any) {
        return withHighPriority(`异动分析:${metadata.title}`, async () => {
            try {
                console.log(`[Sentinel] 正在处理异动: ${metadata.title}`);
                // 1. 先发送基础警报（确保实时性）
                await this.messenger.sendAlert(anomaly, metadata);

                // 2. 推送异动事件到 LangGraph Webhook（可选）
                const webhookPayload = await this.pushWebhookEvent(anomaly, metadata);

                // 3. 异步进行画像分析（带重试）
                const { fetchWalletProfilesFromProfiler, fetchWalletProfilesFromRemote } = await import("../workflow/analysisRunner.js");
                const { buildErrorWorkflowResult, runWorkflowFromInputs } = await import("../workflow/langgraphFlow.js");
                const payload = {
                    eventType: "market.anomaly" as const,
                    detectedAt: Date.now(),
                    anomaly: {
                        marketId: anomaly.marketId,
                        previousPrice: anomaly.previousPrice,
                        currentPrice: anomaly.currentPrice,
                        changePercentage: anomaly.changePercentage
                    },
                    market: {
                        marketId: metadata.marketId,
                        category: metadata.category || "Unknown",
                        title: metadata.title,
                        slug: metadata.slug,
                        outcome: metadata.outcome,
                        conditionId: metadata.conditionId,
                        liquidity: metadata.liquidity,
                        tvl: metadata.tvl,
                        volume: metadata.volume
                    },
                    source: "sentinel" as const
                };

                let walletResult = shouldUseRemoteProfiler()
                    ? await fetchWalletProfilesFromRemote(payload)
                    : await fetchWalletProfilesFromProfiler(this.profiler, payload);

                if (shouldUseRemoteProfiler()) {
                    console.log("[Sentinel] 使用远程 Profiler");
                } else {
                    console.log("[Sentinel] 使用本地 Profiler");
                }

                if (walletResult.status === "error" && shouldUseRemoteProfiler()) {
                    console.warn(`[Sentinel] 远程画像失败，回退本地 Profiler: ${walletResult.errorMessage || "未知错误"}`);
                    walletResult = await fetchWalletProfilesFromProfiler(this.profiler, payload);

                    if (walletResult.status === "error" && !payload.market.conditionId) {
                        try {
                            const fallbackGamma = new GammaClient();
                            const metadataByToken = await fallbackGamma.getMarketMetadataByTokenId(payload.anomaly.marketId);
                            if (metadataByToken?.conditionId) {
                                payload.market.conditionId = metadataByToken.conditionId;
                                payload.market.slug = payload.market.slug || metadataByToken.slug;
                                payload.market.title = payload.market.title || metadataByToken.title || payload.market.title;
                                payload.market.liquidity = payload.market.liquidity ?? metadataByToken.liquidity;
                                payload.market.tvl = payload.market.tvl ?? metadataByToken.tvl;
                                payload.market.volume = payload.market.volume ?? metadataByToken.volume;
                                walletResult = await fetchWalletProfilesFromProfiler(this.profiler, payload);
                            }
                        } catch (error) {
                            console.warn("[Sentinel] 无法回填 conditionId", error);
                        }
                    }
                }

                console.log(`[Sentinel] 画像分析完成，状态: ${walletResult.status}，钱包数: ${walletResult.wallets.length}`);
                await this.messenger.sendAnalysisStatus(metadata, walletResult.wallets.length);

                if (walletResult.status === "error") {
                    const sourceLabel = process.env.PROFILER_API_URL
                        ? "远程失败，已回退本地"
                        : "本地";
                    await this.messenger.sendLlmReport(metadata, walletResult.errorMessage || "钱包画像获取失败，请稍后再试。", sourceLabel, walletResult.wallets);
                    return;
                }

                // 4. 调用 LLM 分析并推送结论
                if (webhookPayload) {
                    const llmResult = await runWorkflowFromInputs(webhookPayload, walletResult.wallets);
                    if (llmResult.llmReport) {
                        const sourceLabel = process.env.PROFILER_API_URL
                            ? "远程" + (walletResult.attempts > 1 ? ` (第 ${walletResult.attempts} 次)` : "")
                            : "本地";
                        await this.messenger.sendLlmReport(metadata, llmResult.llmReport, sourceLabel, walletResult.wallets);
                        console.log("[Sentinel] LLM 分析结论已发送");
                    }
                }
            } catch (error) {
                console.error(`[Sentinel] 处理异动失败:`, error);
            } finally {
                await new Promise(resolve => setTimeout(resolve, this.analysisCooldownMs));
            }
        });
    }

    private enqueueAnalysis(anomaly: any, metadata: any) {
        const enqueued = enqueueAnalysisTask(`异动分析:${metadata.title}`, () => this.handleAnomaly(anomaly, metadata));
        if (!enqueued) {
            void this.messenger.sendAlert(anomaly, metadata);
        }
    }

    private async enrichMetadataFromPolymarket(tokenId: string, slug: string) {
        try {
            const [marketResponse, eventResponse] = await Promise.all([
                fetch(`https://polymarket.com/api/market?slug=${slug}`, {
                    headers: {
                        "User-Agent": "Mozilla/5.0",
                        "Accept": "application/json"
                    },
                    dispatcher: globalProxyAgent
                }),
                fetch(`https://polymarket.com/api/event?slug=${slug}`, {
                    headers: {
                        "User-Agent": "Mozilla/5.0",
                        "Accept": "application/json"
                    },
                    dispatcher: globalProxyAgent
                })
            ]);

            const marketData = marketResponse.ok ? await marketResponse.json() as any : null;
            const eventData = eventResponse.ok ? await eventResponse.json() as any : null;

            const marketLiquidity = marketData?.liquidityNum ?? (marketData?.liquidity ? parseFloat(marketData.liquidity) : undefined);
            const marketVolume = marketData?.volumeNum ?? (marketData?.volume ? parseFloat(marketData.volume) : undefined);
            const eventLiquidity = Number.isFinite(eventData?.liquidity) ? eventData.liquidity : undefined;
            const eventVolume = Number.isFinite(eventData?.volume) ? eventData.volume : undefined;

            const resolvedLiquidity = marketLiquidity ?? eventLiquidity;
            const resolvedVolume = marketVolume ?? eventVolume;

            if (resolvedLiquidity === undefined && resolvedVolume === undefined) {
                return;
            }

            const metadata = this.marketMetadataMap.get(tokenId) || { marketId: tokenId };
            this.marketMetadataMap.set(tokenId, {
                ...metadata,
                liquidity: metadata.liquidity ?? resolvedLiquidity,
                tvl: metadata.tvl ?? resolvedLiquidity,
                volume: metadata.volume ?? resolvedVolume
            });
        } catch {
            // 忽略更新失败
        }
    }

    private async pushWebhookEvent(anomaly: any, metadata: any): Promise<AnomalyWebhookPayload | null> {
        const payload: AnomalyWebhookPayload = {
            eventType: "market.anomaly",
            detectedAt: Date.now(),
            anomaly: {
                marketId: anomaly.marketId,
                previousPrice: anomaly.previousPrice,
                currentPrice: anomaly.currentPrice,
                changePercentage: anomaly.changePercentage
            },
            market: {
                marketId: metadata.marketId,
                category: metadata.category || "Unknown",
                title: metadata.title,
                slug: metadata.slug,
                outcome: metadata.outcome,
                conditionId: metadata.conditionId,
                liquidity: metadata.liquidity,
                tvl: metadata.tvl,
                volume: metadata.volume
            },
            source: "sentinel"
        };

        if (!this.webhookUrl) {
            return payload;
        }

        try {
            const response = await fetch(this.webhookUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => "");
                console.warn(`[Sentinel] Webhook 推送失败: ${response.status} ${response.statusText} ${errorText}`);
            } else {
                console.log(`[Sentinel] Webhook 推送成功: ${this.webhookUrl}`);
            }
        } catch (error: any) {
            console.error(`[Sentinel] Webhook 推送异常: ${error.message || error}`);
        }

        return payload;
    }
}
