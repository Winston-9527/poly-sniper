import { ClobClient } from '@polymarket/clob-client';
import { fetch, setGlobalDispatcher, ProxyAgent } from 'undici';
import fs from 'fs';
import path from 'path';
import { AnomalyDetector } from './AnomalyDetector.js';
import { MarketFilter } from './MarketFilter.js';
import { TelegramMessenger } from './TelegramMessenger.js';
import { Profiler } from './Profiler.js';
import { GammaClient } from './GammaClient.js';
import { ChainAnalyzer } from './ChainAnalyzer.js';
import { Scorer } from './Scorer.js';
import { AnomalyContext, MarketUpdate } from './types.js';

// 检查代理设置
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;

let globalProxyAgent: ProxyAgent | undefined;

if (proxyUrl) {
    console.log(`检测到代理设置: ${proxyUrl}，正在配置代理...`);
    globalProxyAgent = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(globalProxyAgent);
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
    // 全局限速：每分钟最多推送多少条异动（安全网，防止一次全量扫描把 Telegram 刷爆）
    private readonly maxAlertsPerMin = parseInt(process.env.MAX_ALERTS_PER_MIN || "6", 10);
    private alertTimes: number[] = [];
    private suppressedAlerts: number = 0;
    private passedTokens: number = 0;
    // 补元数据请求的节流状态：token -> 上次补拉时间戳
    private lazyFetchAt: Map<string, number> = new Map();
    private lazyFetchInFlight: Set<string> = new Set();
    private readonly csvPath = path.join(process.cwd(), 'data', 'markets.csv');

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

            // 2. 启动定时刷新任务（每小时一次）
            this.startMetadataRefresh();

            // 3. 如果本地没数据，立即执行一次全量加载
            if (this.marketMetadataMap.size === 0) {
                console.log("本地无市场数据，正在执行首次全量加载...");
                await this.loadMarkets();
            }

            // 定向补齐「正在被轮询的那 1.8 万个市场」的元数据：
            // 过滤器依赖流动性 / 24h 成交量，缺数据的市场会被挡掉，不能让它们漏监控。
            await this.syncFeedMetadata();

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
                // 只认 v2 缓存（带表头，含流动性 / 24h 成交量）。
                // 旧格式缺了过滤所需字段，加载进来会让所有市场因"缺数据"被过滤掉，
                // 所以直接忽略并触发一次全量重载。
                if (!lines[0] || !lines[0].startsWith("#v2,")) {
                    console.log("本地缓存为旧格式（缺流动性/24h 成交量字段），忽略缓存，执行全量加载。");
                    return;
                }
                let count = 0;
                for (const line of lines) {
                    if (!line.trim() || line.startsWith("#")) continue;
                    const parts = line.split(',');
                    if (parts.length < 7) continue;

                    const tokenId = parts[0];
                    const category = parts[1];
                    const slug = parts[2];
                    const outcome = parts[3];
                    const liquidity = parseFloat(parts[4]);
                    const volume24hr = parseFloat(parts[5]);
                    const title = parts.slice(6).join(',');

                    if (tokenId && title) {
                        this.marketMetadataMap.set(tokenId, {
                            title,
                            marketId: tokenId,
                            category: category || "Unknown",
                            slug: slug || "",
                            outcome: outcome || "",
                            liquidity: isFinite(liquidity) ? liquidity : undefined,
                            volume24hr: isFinite(volume24hr) ? volume24hr : undefined
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
            let csvContent = "#v2,tokenId,category,slug,outcome,liquidity,volume24hr,title\n";
            this.marketMetadataMap.forEach((meta, id) => {
                // 简单处理 CSV 转义：去掉换行，title 放最后一列，读取时把剩余逗号拼回 title
                const safeTitle = (meta.title || "").replace(/[\n\r]/g, " ");
                const category = meta.category || "Unknown";
                const slug = meta.slug || "";
                const outcome = meta.outcome || "";
                const liquidity = typeof meta.liquidity === "number" && isFinite(meta.liquidity) ? meta.liquidity : "";
                const volume24hr = typeof meta.volume24hr === "number" && isFinite(meta.volume24hr) ? meta.volume24hr : "";
                csvContent += `${id},${category},${slug},${outcome},${liquidity},${volume24hr},${safeTitle}\n`;
            });
            fs.writeFileSync(this.csvPath, csvContent, 'utf-8');
            console.log(`市场元数据已保存至 ${this.csvPath}`);
        } catch (e) {
            console.error("保存 CSV 失败:", e);
        }
    }

    /** 把 gamma 的市场对象写入元数据表（含流动性、24h 成交量） */
    private storeMarketMetadata(market: any): number {
        try {
            const tokenIds: string[] = JSON.parse(market.clobTokenIds || "[]");
            const outcomes: string[] = JSON.parse(market.outcomes || "[]");
            const liquidity = market.liquidity !== undefined && market.liquidity !== null && market.liquidity !== ""
                ? parseFloat(market.liquidity) : undefined;
            const volume24hr = market.volume24hr !== undefined && market.volume24hr !== null && market.volume24hr !== ""
                ? parseFloat(market.volume24hr) : undefined;

            tokenIds.forEach((tokenId: string, index: number) => {
                this.marketMetadataMap.set(tokenId, {
                    title: market.question,
                    marketId: tokenId,
                    category: market.category || "Unknown",
                    slug: market.slug || "",
                    outcome: outcomes[index] || "",
                    conditionId: market.conditionId,
                    liquidity: liquidity,
                    volume24hr: volume24hr
                });
            });
            return tokenIds.length;
        } catch (e) {
            return 0;
        }
    }

    /**
     * 按「喂价接口正在轮询的市场」定向补齐元数据。
     * 轮询只覆盖这 1.8 万个市场，而 keyset 全量扫描（默认 700 页）只能覆盖其中约 8 成，
     * 没元数据的市场会因为「缺流动性/24h 成交量」被过滤器挡掉，所以这里按 condition_id 定向补。
     */
    private async syncFeedMetadata() {
        try {
            const conds: string[] = [];
            let cursor: string | null = null;
            for (let page = 0; page < 60; page++) {
                const url = "https://clob.polymarket.com/sampling-simplified-markets"
                    + (cursor ? `?next_cursor=${encodeURIComponent(cursor)}` : "");
                const res = await fetch(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'application/json'
                    },
                    dispatcher: globalProxyAgent
                });
                if (!res.ok) break;
                const data: any = await res.json();
                for (const m of data?.data || []) {
                    if (m.condition_id) conds.push(m.condition_id);
                }
                const next = data?.next_cursor;
                if (!next || next === "LTE=") break;
                cursor = next;
                await new Promise(resolve => setTimeout(resolve, 120));
            }

            let tokens = 0;
            for (let i = 0; i < conds.length; i += 100) {
                const batch = conds.slice(i, i + 100);
                const query = batch.map(c => `condition_ids=${encodeURIComponent(c)}`).join("&");
                const res = await fetch(`https://gamma-api.polymarket.com/markets/keyset?limit=100&${query}`, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'application/json'
                    },
                    dispatcher: globalProxyAgent
                });
                if (!res.ok) continue;
                const data: any = await res.json();
                for (const market of data?.markets || []) {
                    tokens += this.storeMarketMetadata(market);
                }
                await new Promise(resolve => setTimeout(resolve, 120));
            }
            console.log(`[元数据] 喂价市场定向补齐完成：${conds.length} 个市场 / ${tokens} 个 token。`);
            this.saveToCsv();
        } catch (e) {
            console.warn("[元数据] 喂价市场定向补齐失败:", e);
        }
    }

    private startMetadataRefresh() {
        if (this.refreshInterval) return;
        // 每小时刷新一次 (3600000 ms)
        this.refreshInterval = setInterval(async () => {
            console.log("\n[系统] 正在执行每小时市场元数据刷新...");
            await this.loadMarkets();
            await this.syncFeedMetadata();
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
            // 注意：offset 分页在 offset>2100 时会被 API 拒绝（422 offset too large），
            // 因此改用 keyset 分页，游标参数名必须是 after_cursor（不是 cursor）。
            const limit = 100;
            const maxPages = parseInt(process.env.MAX_MARKET_PAGES || "700", 10);
            let cursor: string | null = null;
            let page = 0;
            let hasMore = true;
            let retryCount = 0;
            const maxRetries = 3;

            // 全量加载所有活跃市场
            while (hasMore && page < maxPages) {
                console.log(`正在获取市场数据 (第 ${page + 1} 页${cursor ? "，游标续页" : ""})...`);
                try {
                    const url = `https://gamma-api.polymarket.com/markets/keyset?limit=${limit}&active=true&closed=false`
                        + (cursor ? `&after_cursor=${encodeURIComponent(cursor)}` : "");
                    const response = await fetch(url, {
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

                    const payload: any = await response.json();
                    const markets: any = payload?.markets;

                    if (!Array.isArray(markets)) {
                        console.error("Gamma keyset 返回的 markets 不是数组:", payload);
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
                        // 流动性与 24h 成交量：解析失败或缺失记为 undefined，由过滤器按"缺数据不推送"处理
                        const liquidity = market.liquidity !== undefined && market.liquidity !== null && market.liquidity !== ""
                            ? parseFloat(market.liquidity) : undefined;
                        const volume24hr = market.volume24hr !== undefined && market.volume24hr !== null && market.volume24hr !== ""
                            ? parseFloat(market.volume24hr) : undefined;

                        tokenIds.forEach((tokenId: string, index: number) => {
                            this.marketMetadataMap.set(tokenId, {
                                title: market.question,
                                marketId: tokenId,
                                category: category,
                                slug: slug,
                                outcome: outcomes[index] || "",
                                conditionId: market.conditionId,
                                liquidity: liquidity,
                                volume24hr: volume24hr
                            });
                        });
                    }

                    page++;
                    retryCount = 0;

                    // 游标推进：没有 next_cursor 说明全集已走完
                    cursor = payload.next_cursor || null;
                    if (!cursor) {
                        hasMore = false;
                    } else {
                        // 页间限速，避免被 Cloudflare 1015 限流
                        await new Promise(resolve => setTimeout(resolve, 200));
                    }
                } catch (fetchErr: any) {
                    const errorMsg = fetchErr.message || fetchErr;

                    // 分页越界 / 游标失效属于终止条件，不做无意义重试
                    if (/422|offset too large|after_cursor/i.test(String(errorMsg))) {
                        console.warn(`[元数据] 分页终止（已加载 ${this.marketMetadataMap.size} 个 Token）: ${errorMsg}`);
                        hasMore = false;
                        continue;
                    }

                    if (retryCount < maxRetries) {
                        retryCount++;
                        console.warn(`获取市场数据失败 (第 ${page + 1} 页): ${errorMsg}`);
                        console.warn(`正在进行第 ${retryCount} 次重试 (等待 3 秒)...`);
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        continue;
                    }
                    console.error(`获取市场数据最终失败 (第 ${page + 1} 页):`, fetchErr);
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
                                    this.marketMetadataMap.set(id, {
                                        title: market.question,
                                        marketId: id,
                                        category: market.category || "Unknown",
                                        slug: market.slug || "",
                                        outcome: outcomes[index] || "",
                                        conditionId: market.conditionId,
                                        liquidity: market.liquidity !== undefined && market.liquidity !== null && market.liquidity !== "" ? parseFloat(market.liquidity) : undefined,
                                        volume24hr: market.volume24hr !== undefined && market.volume24hr !== null && market.volume24hr !== "" ? parseFloat(market.volume24hr) : undefined
                                    });
                                }
                            }
                        }
                    } catch (e) {
                        // 忽略错误
                    }
                }
            }

            console.log(`已加载 ${this.marketMetadataMap.size} 个符合条件的 Token（keyset 分页共 ${page} 页）。`);
            this.saveToCsv();
        } catch (error: any) {
            console.error("加载市场过程中发生严重错误:", error);
        }
    }

    private async lazyFetchMetadata(tokenId: string) {
        // 补元数据会额外请求 Gamma。分片轮询后每轮会经手数万个 token，
        // 因此同一 token 在请求中、或 10 分钟内刚补过就跳过，避免请求风暴。
        const last = this.lazyFetchAt.get(tokenId) || 0;
        if (this.lazyFetchInFlight.has(tokenId) || Date.now() - last < 600000) return;
        this.lazyFetchInFlight.add(tokenId);
        this.lazyFetchAt.set(tokenId, Date.now());
        try {
            const response = await fetch(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`, {
                dispatcher: globalProxyAgent
            });
            if (response.ok) {
                const markets: any = await response.json();
                if (Array.isArray(markets) && markets.length > 0) {
                    const market = markets[0];
                    const tokenIds = JSON.parse(market.clobTokenIds || "[]");
                    const outcomes = JSON.parse(market.outcomes || "[]");
                    const index = tokenIds.indexOf(tokenId);
                    this.marketMetadataMap.set(tokenId, {
                        title: market.question,
                        marketId: tokenId,
                        category: market.category || "Unknown",
                        slug: market.slug || "",
                        outcome: outcomes[index] || "",
                        conditionId: market.conditionId,
                        liquidity: market.liquidity !== undefined && market.liquidity !== null && market.liquidity !== "" ? parseFloat(market.liquidity) : undefined,
                        volume24hr: market.volume24hr !== undefined && market.volume24hr !== null && market.volume24hr !== "" ? parseFloat(market.volume24hr) : undefined
                    });
                }
            }
        } catch (e) {
            // 静默失败
        } finally {
            this.lazyFetchInFlight.delete(tokenId);
        }
    }

    private startPolling() {
        if (this.pollingInterval) return;

        // 分片轮询：喂价接口共有 19 页 / 约 1.8 万个市场，只读第 1 页时实时覆盖率约 5%。
        // 每轮沿 next_cursor 向后翻 pagesPerCycle 页，翻到链尾自动回到第 1 页，
        // 这样在单轮负载可控的前提下实现「全市场循环覆盖」。
        const pagesPerCycle = Math.max(1, parseInt(process.env.POLL_PAGES_PER_CYCLE || "5", 10));
        let nextCursor: string | null = null; // null = 从第 1 页开始（一轮扫描）
        let cycle = 0;

        console.log(`启动价格轮询 (每 10 秒一次, 每轮最多 ${pagesPerCycle} 页, 循环覆盖全部市场)...`);
        this.pollingInterval = setInterval(async () => {
            let cursor = nextCursor;
            let pages = 0;
            try {
                while (pages < pagesPerCycle) {
                    const url = "https://clob.polymarket.com/sampling-simplified-markets"
                        + (cursor ? `?next_cursor=${encodeURIComponent(cursor)}` : "");
                    const response = await fetch(url, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Accept': 'application/json'
                        },
                        dispatcher: globalProxyAgent
                    });

                    if (!response.ok) {
                        console.warn(`轮询请求失败: ${response.status} ${response.statusText}`);
                        break;
                    }

                    const result: any = await response.json();
                    // API 返回结构是 { data: [...], next_cursor }
                    const batch: any[] = result && Array.isArray(result.data) ? result.data : [];
                    let pageTokens = 0;
                    batch.forEach((market: any) => {
                        if (market.tokens && Array.isArray(market.tokens)) {
                            market.tokens.forEach((token: any) => {
                                this.handleUpdate(token.token_id, token.price);
                                pageTokens++;
                            });
                        }
                    });
                    pages++;

                    // 每页输出一条抽样信息，方便观察脚本是否在正常工作
                    const sample = batch.find((m: any) => m.tokens && m.tokens[0]);
                    if (sample) {
                        const meta = this.marketMetadataMap.get(sample.tokens[0].token_id);
                        console.log(`[监控抽样] 第 ${cycle + 1} 轮 / 第 ${pages} 页: ${batch.length} 个市场 / ${pageTokens} 个 token | 样本: ${meta?.title || '加载中...'} - 价格: ${sample.tokens[0].price}`);
                    }

                    const next = result && result.next_cursor;
                    if (!next || next === "LTE=") { cursor = null; break; } // 一圈扫描结束
                    cursor = next;
                    await new Promise(resolve => setTimeout(resolve, 150)); // 页间限速
                }

                nextCursor = cursor;
                cycle++;
                if (this.suppressedAlerts > 0) {
                    console.log(`[限速] 本轮另有 ${this.suppressedAlerts} 条异动超过每分钟 ${this.maxAlertsPerMin} 条上限，已抑制未推送。`);
                    this.suppressedAlerts = 0;
                }
                if (!nextCursor) {
                    console.log(`[监控] 第 ${cycle} 轮已扫到链尾：全市场覆盖一圈完成，本轮 ${this.passedTokens} 个 token 通过过滤器进入异动检测，下一轮从第 1 页重新开始。`);
                    this.passedTokens = 0;
                }
            } catch (err: any) {
                // 轮询错误不打印堆栈，避免刷屏
                console.error("轮询请求失败:", err.message || err);
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
        }, 10000);
    }

    private handleUpdate(marketId: string, price: number) {
        // 如果没有元数据，先创建一个占位符，这样就不会漏掉异动
        if (!this.marketMetadataMap.has(marketId)) {
            this.marketMetadataMap.set(marketId, { title: `未知资产 (${marketId.substring(0, 8)})` });
            // 异步去查一下这个 ID 的真实标题
            this.lazyFetchMetadata(marketId);
        }

        const metadata = this.marketMetadataMap.get(marketId);

        // 如果有元数据但没有 slug 或 outcome（可能是旧 CSV 导入的），尝试异步更新
        if (metadata && (!metadata.slug || !metadata.outcome)) {
            this.lazyFetchMetadata(marketId);
        }

        // 没有元数据（占位符）就不参与推送：这类市场会绕过流动性/24h 成交量门槛，
        // 实测是噪音的主要来源（占已观测噪音的 50%）。等 lazy fetch 补到真实元数据后自然恢复。
        if (!metadata || typeof metadata.liquidity !== "number") {
            return;
        }

        // 过滤掉不需要的市场（体育、加密短线、天气、流动性/成交量不足）
        if (!this.filter.shouldInclude(metadata)) {
            return;
        }

        // 只推送单边市场（Yes）
        if (metadata.outcome && metadata.outcome !== "Yes") {
            return;
        }

        this.passedTokens++;

        if (this.manualTokenIds.includes(marketId)) {
            console.log(`[价格更新] ${new Date().toLocaleTimeString()} - 市场: ${metadata?.title} - 价格: ${price}`);
        }

        this.messageCount++;
        if (this.messageCount % 500 === 0) {
            console.log(`[系统存活] ${new Date().toLocaleTimeString()} - 已处理 ${this.messageCount} 条价格更新...`);
        }

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

            // 全局限速：超过每分钟上限的异动只计数、不推送，避免再次刷屏
            if (!this.allowAlert()) {
                this.suppressedAlerts++;
                return;
            }

            // 异步执行画像分析并推送
            if (metadata) {
                this.handleAnomaly(anomaly, metadata);
            }
        }
    }

    /** 全局限速：每分钟最多 maxAlertsPerMin 条推送 */
    private allowAlert(): boolean {
        const now = Date.now();
        this.alertTimes = this.alertTimes.filter(t => now - t < 60000);
        if (this.alertTimes.length >= this.maxAlertsPerMin) return false;
        this.alertTimes.push(now);
        return true;
    }

    private async handleAnomaly(anomaly: any, metadata: any) {
        try {
            console.log(`[Sentinel] 正在处理异动: ${metadata.title}`);
            // 1. 先发送基础警报（确保实时性）
            await this.messenger.sendAlert(anomaly, metadata);

            // 2. 异步进行画像分析
            // 异动方向 + 锚点 tokenId 一起传下去：画像器据此在成交流里找「顺着异动方向下注的人」
            const direction = anomaly.currentPrice >= anomaly.previousPrice ? 'UP' : 'DOWN';
            const context: AnomalyContext = {
                anomalyTokenId: anomaly.marketId,
                conditionId: metadata.conditionId,
                direction,
                previousPrice: anomaly.previousPrice,
                currentPrice: anomaly.currentPrice,
                anomalyTs: Math.floor(Date.now() / 1000),
                detectedAt: Date.now(),
            };
            const report = await this.profiler.analyzeMarket(
                anomaly.marketId, metadata.conditionId, anomaly.currentPrice, {
                direction,
                previousPrice: anomaly.previousPrice,
                currentPrice: anomaly.currentPrice,
                anomalyTs: context.anomalyTs,
            });
            console.log(`[Sentinel] 画像分析完成：成交流池 ${report.stats.poolWallets} 个钱包 / `
                + `深挖 ${report.stats.deepProfiled} 个 / 高疑 ${report.results.length} 个`);

            // 3. 发送画像分析结果（无论有无发现，都给一个反馈，形成闭环）
            if (report.results.length > 0) {
                await this.messenger.sendProfilerReport(metadata, report.results, report.stats);
                console.log(`[Sentinel] 画像报告已发送`);
            } else {
                await this.messenger.sendSafeReport(metadata, report.stats);
            }
        } catch (error) {
            console.error(`[Sentinel] 处理异动失败:`, error);
        }
    }
}
