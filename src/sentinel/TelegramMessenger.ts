import TelegramBot from 'node-telegram-bot-api';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Anomaly, MarketMetadata, ScoreResult } from './types.js';
import { Profiler } from './Profiler.js';
import { GammaClient } from './GammaClient.js';
import { shouldUseRemoteProfiler, withHighPriority } from "../workflow/analysisRunner.js";

export class TelegramMessenger {
    private bot: TelegramBot | null = null;
    private chatId: string | null = null;
    private profiler: Profiler | null = null;
    private gamma: GammaClient;
    private pollingRestarting = false;
    private pollingRetryCount = 0;
    private pollingOptions?: TelegramBot.PollingOptions;
    private pollingPaused = false;
    private sendQueue: Promise<void> = Promise.resolve();
    private botToken?: string;
    private proxyUrl?: string;

    constructor(profiler?: Profiler, botOverride?: TelegramBot) {
        this.profiler = profiler || null;
        this.gamma = new GammaClient(); // Used for slug resolution
        const token = process.env.TELEGRAM_BOT_TOKEN;
        this.botToken = token || undefined;
        this.chatId = process.env.TELEGRAM_CHAT_ID || null;
        const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
        this.proxyUrl = proxyUrl || undefined;

        if (botOverride) {
            this.bot = botOverride;
            // 如果提供了 botOverride，我们假设它是用于测试，或者已经初始化好的
            // 但我们需要确保 chatId 存在以便进行权限检查（如果是测试，可以模拟一个）
            if (!this.chatId) this.chatId = "TEST_CHAT_ID";

            if (this.profiler) {
                this.setupCommands();
            }
        } else if (token && this.chatId) {
            const polling: TelegramBot.PollingOptions | boolean = profiler
                ? { interval: Number(process.env.TELEGRAM_POLLING_INTERVAL_MS || 2000) }
                : false;
            const options: TelegramBot.ConstructorOptions = { polling };
            this.pollingOptions = typeof polling === "boolean" ? undefined : polling;

            if (proxyUrl) {
                console.log(`[Messenger] Telegram 机器人正在使用代理: ${proxyUrl}`);
                // @ts-ignore - node-telegram-bot-api 的类型定义可能不包含 request 选项
                options.request = {
                    agent: new HttpsProxyAgent(proxyUrl)
                };
            }

            this.bot = new TelegramBot(token, options);
            console.log(`[Messenger] Telegram 机器人已初始化。目标 Chat ID: ${this.chatId}。Polling模式: ${options.polling}`);

            // 添加 polling 错误监听
            this.bot.on('polling_error', (error: any) => {
                console.error(`[Messenger] polling_error: ${error.code || 'UNKNOWN'} - ${error.message}`);
                this.restartPolling();
            });

            if (this.profiler) {
                this.setupCommands();
            }
        } else {
            console.warn("[Messenger] 未配置 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID，Telegram 推送已禁用。");
        }
    }

    private async restartPolling() {
        if (!this.bot || !this.botToken) return;
        if (this.pollingRestarting) return;

        this.pollingRestarting = true;
        const maxRetries = Number(process.env.TELEGRAM_POLLING_RETRY_TIMES || 3);
        const baseDelay = Number(process.env.TELEGRAM_POLLING_RETRY_DELAY_MS || 3000);

        if (this.pollingRetryCount >= maxRetries) {
            console.error("[Messenger] polling 重试次数已用尽，切换为临时暂停模式");
            this.pollingPaused = true;
            this.pollingRestarting = false;
            return;
        }

        this.pollingRetryCount += 1;
        const delayMs = baseDelay * this.pollingRetryCount;
        console.warn(`[Messenger] polling 重启中，等待 ${delayMs}ms (第 ${this.pollingRetryCount}/${maxRetries} 次)`);
        await new Promise(resolve => setTimeout(resolve, delayMs));

        try {
            await this.bot.stopPolling();
        } catch (error) {
            console.warn("[Messenger] 停止 polling 失败:", error);
        }

        try {
            this.bot = new TelegramBot(this.botToken, {
                polling: this.pollingOptions ?? true,
                // @ts-ignore - request agent type mismatch
                request: this.proxyUrl
                    ? { agent: new HttpsProxyAgent(this.proxyUrl) }
                    : undefined
            });
            this.bot.on('polling_error', (error: any) => {
                console.error(`[Messenger] polling_error: ${error.code || 'UNKNOWN'} - ${error.message}`);
                this.restartPolling();
            });
            if (this.profiler) {
                this.setupCommands();
            }
            console.log("[Messenger] polling 已恢复");
            this.pollingRetryCount = 0;
            this.pollingPaused = false;
        } catch (error) {
            console.error("[Messenger] polling 重启失败:", error);
        } finally {
            this.pollingRestarting = false;
        }
    }

    private setupCommands() {
        if (!this.bot) return;

        console.log("[Messenger] 正在启用交互式指令 (/check)...");

        // Command: /check <url_or_slug>
        this.bot.onText(/\/check (.+)/, async (msg, match) => {
            const chatId = msg.chat.id;
            console.log(`[Messenger] 收到 /check 指令，来自 Chat ID: ${chatId}`);

            if (this.chatId && chatId.toString() !== this.chatId) {
                console.warn(`[Messenger] 忽略指令: Chat ID 不匹配 (预期: ${this.chatId})`);
                return; // Auth Check
            }

            const input = match ? match[1] : null;
            if (!input) {
                await this.sendMessageWithRetry(chatId.toString(), "请提供 Polymarket 链接或 Slug。例如: /check https://polymarket.com/event/...", {});
                return;
            }

            await withHighPriority(`手动分析:${input}`, async () => {
                await this.handleManualAnalysis(chatId, input);
            });
        });
    }

    private async handleManualAnalysis(chatId: number, url: string) {
        if (!this.bot || !this.profiler) return;

        try {
            await this.sendMessageWithRetry(chatId.toString(), "正在解析链接...", {});
            if (this.pollingPaused) {
                console.warn("[Messenger] polling 已暂停，手动分析仍继续执行");
            }

            // Extract slug
            let slug = "";
            try {
                const urlObj = new URL(url);
                if (urlObj.hostname.includes('polymarket.com')) {
                    const parts = urlObj.pathname.split('/').filter(p => !!p);
                    if (parts.length >= 2 && (parts[0] === 'event' || parts[0] === 'market')) {
                        slug = parts[1];
                    }
                }
            } catch (e) {
                // Ignore URL parsing errors
            }

            if (!slug) {
                slug = url.trim(); // Assume user might have sent raw slug
            }

            if (!slug) {
                await this.sendMessageWithRetry(chatId.toString(), "无法识别有效的市场 Slug 或链接。", {});
                return;
            }

            await this.sendMessageWithRetry(chatId.toString(), `正在分析市场: ${slug} ... (可能需要几十秒)`, {});

            // Resolve Metadata
            const metadata = await this.gamma.getMarketMetadataBySlug(slug);
            if (!metadata) {
                await this.sendMessageWithRetry(chatId.toString(), "无法找到该市场的元数据 (Gamma API 返回空)。", {});
                return;
            }

            const reportMetadata: MarketMetadata = {
                title: metadata.title,
                marketId: metadata.id,
                category: "Manual",
                slug: slug,
                outcome: "N/A",
                conditionId: metadata.conditionId,
                liquidity: metadata.liquidity,
                tvl: metadata.tvl,
                volume: metadata.volume
            };

            const { fetchWalletProfilesFromRemote, fetchWalletProfilesFromProfiler } = await import("../workflow/analysisRunner.js");
            const { buildErrorWorkflowResult, runWorkflowFromInputs } = await import("../workflow/langgraphFlow.js");
            const payload = {
                eventType: "market.anomaly" as const,
                detectedAt: Date.now(),
                anomaly: {
                    marketId: metadata.tokenIds[0] || metadata.id,
                    previousPrice: 0.5,
                    currentPrice: 0.5,
                    changePercentage: "0%"
                },
                market: reportMetadata,
                source: "sentinel" as const
            };

            let walletResult = shouldUseRemoteProfiler()
                ? await fetchWalletProfilesFromRemote(payload)
                : await fetchWalletProfilesFromProfiler(this.profiler, payload);

            if (walletResult.status === "error" && shouldUseRemoteProfiler()) {
                console.warn(`[Messenger] 远程画像失败，回退本地 Profiler: ${walletResult.errorMessage || "未知错误"}`);
                walletResult = await fetchWalletProfilesFromProfiler(this.profiler, payload);
            }

            if (walletResult.status === "error") {
                await this.sendLlmReport(reportMetadata, walletResult.errorMessage || "钱包画像获取失败，请稍后再试。", process.env.PROFILER_API_URL ? "远程失败已回退本地" : "本地");
                return;
            }

            await this.sendMessageWithRetry(chatId.toString(), `分析完成。已获取 ${walletResult.wallets.length} 个钱包画像，正在生成 LLM 分析...`, {});

            const llmResult = await runWorkflowFromInputs(payload, walletResult.wallets);

            if (llmResult.llmReport) {
                const sourceLabel = process.env.PROFILER_API_URL
                    ? "远程" + (walletResult.attempts > 1 ? ` (第 ${walletResult.attempts} 次)` : "")
                    : "本地";
                await this.sendLlmReport(reportMetadata, llmResult.llmReport, sourceLabel);
                await this.sendMessageWithRetry(chatId.toString(), "LLM 分析完成，已推送结论。", {
                    disable_web_page_preview: true
                });
            }

        } catch (error: any) {
            if (error?.code === "EFATAL" || error?.cause?.code === "ECONNRESET") {
                console.error(`[Messenger] Telegram 发送失败：网络连接被重置，请检查代理或网络。`);
            } else {
                console.error(`[Messenger] 发送画像报告失败: ${error.message}`);
            }
        }

    }

    /**
     * 发送异动警报
     */
    async sendAlert(anomaly: Anomaly, metadata: MarketMetadata) {
        if (!this.bot || !this.chatId) return;

        const time = new Date().toLocaleTimeString();

        // 构造多种可能的链接以确保用户能打开
        const eventUrl = metadata.slug ? `https://polymarket.com/event/${metadata.slug}` : "";
        const marketUrl = metadata.slug ? `https://polymarket.com/market/${metadata.slug}` : "";
        const searchUrl = `https://polymarket.com/search?q=${encodeURIComponent(metadata.title)}`;

        let linkSection = "";
        if (eventUrl) {
            linkSection = `[官网直达](${eventUrl}) | [备用链接](${marketUrl}) | [搜索](${searchUrl})`;
        } else {
            linkSection = `[搜索跳转](${searchUrl})`;
        }

        const message = `
*\[!!! 异动警报 !!!\]* ${time}
*市场:* ${this.escapeMarkdown(metadata.title)}
*幅度:* \`${anomaly.changePercentage}\`
*价格:* \`${anomaly.previousPrice.toFixed(2)} \-> ${anomaly.currentPrice.toFixed(2)}\`
*链接:* ${linkSection}
        `.trim();

        await this.sendMessageWithRetry(this.chatId, message, { parse_mode: 'Markdown' });
    }

    /**
     * 发送画像分析报告（已弃用）
     */
    async sendProfilerReport(_metadata: MarketMetadata, _results: ScoreResult[]) {
        return;
    }

    /**
     * 发送 LLM 分析结论
     */
    async sendLlmReport(metadata: MarketMetadata, llmReport: string, sourceLabel: string = "本地") {
        if (!this.bot || !this.chatId) return;

        const report = `*\[🧠 LLM 原始画像分析\]*\n*市场:* ${this.escapeMarkdown(metadata.title)}\n*画像来源:* ${this.escapeMarkdown(sourceLabel)}\n\n${this.escapeMarkdown(llmReport)}`;

        await this.sendMessageWithRetry(this.chatId, report, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });

    }

    /**
     * 发送画像分析状态提示
     */
    async sendAnalysisStatus(metadata: MarketMetadata, walletCount: number) {
        if (!this.bot || !this.chatId) return;

        const report = `*\[🔎 画像采集完成\]*\n*市场:* ${this.escapeMarkdown(metadata.title)}\n钱包数量: ${walletCount}\n正在调用 LLM 进行分析...`;

        await this.sendMessageWithRetry(this.chatId, report, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
    }

    /**
     * 发送安全（无异常）报告
     */
    async sendSafeReport(metadata: MarketMetadata) {
        if (!this.bot || !this.chatId) return;

        const report = `*\[✅ 画像分析完成\]* \n*市场:* ${this.escapeMarkdown(metadata.title)}\n未发现显著的高疑内幕钱包交易。`;

        await this.sendMessageWithRetry(this.chatId, report, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });

    }

    private async sendMessageWithRetry(chatId: string, message: string, options: TelegramBot.SendMessageOptions) {
        if (!this.bot) return;
        const maxAttempts = Number(process.env.TELEGRAM_SEND_RETRY_TIMES || 3);
        const baseDelay = Number(process.env.TELEGRAM_SEND_RETRY_DELAY_MS || 1500);

        this.sendQueue = this.sendQueue.then(async () => {
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                try {
                    await this.bot?.sendMessage(chatId, message, options);
                    return;
                } catch (error: any) {
                    const code = error?.code || error?.cause?.code || "UNKNOWN";
                    const errMsg = error?.message || String(error);
                    console.error(`[Messenger] 发送失败 (第 ${attempt}/${maxAttempts} 次): ${code} - ${errMsg}`);
                    if (attempt < maxAttempts) {
                        const backoff = baseDelay * attempt + Math.floor(Math.random() * 500);
                        await new Promise(resolve => setTimeout(resolve, backoff));
                    }
                }
            }
        });

        await this.sendQueue;
    }

    /**
     * 转义 Markdown 特殊字符
     */
    private escapeMarkdown(text: string): string {
        return text.replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
    }
}
