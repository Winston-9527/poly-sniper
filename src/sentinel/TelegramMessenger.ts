import TelegramBot from 'node-telegram-bot-api';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Anomaly, MarketMetadata, ScoreResult } from './types.js';
import { Profiler } from './Profiler.js';
import { GammaClient } from './GammaClient.js';

export class TelegramMessenger {
    private bot: TelegramBot | null = null;
    private chatId: string | null = null;
    private profiler: Profiler | null = null;
    private gamma: GammaClient;

    constructor(profiler?: Profiler, botOverride?: TelegramBot) {
        this.profiler = profiler || null;
        this.gamma = new GammaClient(); // Used for slug resolution
        const token = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID || null;
        const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;

        if (botOverride) {
            this.bot = botOverride;
            // 如果提供了 botOverride，我们假设它是用于测试，或者已经初始化好的
            // 但我们需要确保 chatId 存在以便进行权限检查（如果是测试，可以模拟一个）
            if (!this.chatId) this.chatId = "TEST_CHAT_ID";

            if (this.profiler) {
                this.setupCommands();
            }
        } else if (token && this.chatId) {
            const options: TelegramBot.ConstructorOptions = {
                polling: !!profiler // Only enable polling if profiler is provided (interactive mode)
            };

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
            });

            if (this.profiler) {
                this.setupCommands();
            }
        } else {
            console.warn("[Messenger] 未配置 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID，Telegram 推送已禁用。");
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
                await this.bot?.sendMessage(chatId, "请提供 Polymarket 链接或 Slug。例如: /check https://polymarket.com/event/...");
                return;
            }

            await this.handleManualAnalysis(chatId, input);
        });
    }

    private async handleManualAnalysis(chatId: number, url: string) {
        if (!this.bot || !this.profiler) return;

        try {
            await this.bot.sendMessage(chatId, "正在解析链接...");

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
                await this.bot.sendMessage(chatId, "无法识别有效的市场 Slug 或链接。");
                return;
            }

            await this.bot.sendMessage(chatId, `正在分析市场: ${slug} ... (可能需要几十秒)`);

            // Resolve Metadata
            const metadata = await this.gamma.getMarketMetadataBySlug(slug);
            if (!metadata) {
                await this.bot.sendMessage(chatId, "无法找到该市场的元数据 (Gamma API 返回空)。");
                return;
            }

            // Run Profiler
            // We use default price 0.5 for manual analysis as we might not have real-time price handy
            // unless we fetch it. For insider detection, price matters for 'value' metric but logic works without exact price.
            const suspiciousWallets = await this.profiler.analyzeMarket(metadata.tokenIds[0] || metadata.id, metadata.conditionId, 0.5);

            if (suspiciousWallets.length > 0) {
                await this.sendProfilerReport({
                    title: metadata.title,
                    marketId: metadata.id,
                    category: "Manual",
                    slug: slug,
                    outcome: "N/A"
                }, suspiciousWallets);
                await this.bot.sendMessage(chatId, `分析完成。发现 ${suspiciousWallets.length} 个高疑钱包。`);
            } else {
                await this.bot.sendMessage(chatId, `分析完成。未发现显著异常 (Top 持仓者看起来比较正常)。`);
            }

        } catch (error: any) {
            console.error("Manual analysis failed:", error);
            await this.bot.sendMessage(chatId, `分析通过，详情请看终端日志: ${error.message}`);
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

        try {
            await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
        } catch (error: any) {
            console.error(`[Messenger] 发送 Telegram 消息失败: ${error.message}`);
        }
    }

    /**
     * 发送画像分析报告
     */
    async sendProfilerReport(metadata: MarketMetadata, results: ScoreResult[]) {
        if (!this.bot || !this.chatId) return;

        let report = `*\[🔍 内幕画像分析\]* \n`;
        report += `*市场:* ${this.escapeMarkdown(metadata.title)}\n\n`;

        results.forEach((res, index) => {
            const profileUrl = `https://polymarket.com/profile/${res.address}`;
            report += `${index + 1}\. *钱包:* [${res.address}](${profileUrl})\n`;
            report += `   *得分:* \`${res.totalScore}\`\n`;
            report += `   *特征:* ${res.details.join(", ")}\n\n`;
        });

        try {
            await this.bot.sendMessage(this.chatId, report, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
        } catch (error: any) {
            console.error(`[Messenger] 发送画像报告失败: ${error.message}`);
        }
    }

    /**
     * 发送安全（无异常）报告
     */
    async sendSafeReport(metadata: MarketMetadata) {
        if (!this.bot || !this.chatId) return;

        const report = `*\[✅ 画像分析完成\]* \n*市场:* ${this.escapeMarkdown(metadata.title)}\n未发现显著的高疑内幕钱包交易。`;

        try {
            await this.bot.sendMessage(this.chatId, report, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
        } catch (error: any) {
            console.error(`[Messenger] 发送安全报告失败: ${error.message}`);
        }
    }

    /**
     * 转义 Markdown 特殊字符
     */
    private escapeMarkdown(text: string): string {
        return text.replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
    }
}
