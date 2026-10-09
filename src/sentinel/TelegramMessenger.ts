import TelegramBot from 'node-telegram-bot-api';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Anomaly, MarketMetadata, ProfileStats, ScoreResult } from './types.js';
import { Profiler } from './Profiler.js';
import { GammaClient } from './GammaClient.js';

/**
 * Telegram 推送。
 *
 * 消息统一用 **HTML** 解析模式：动态内容（标题、地址、特征串）只需转义 & < >，
 * 不需要像 legacy Markdown 那样给 []()_*` 逐个补反斜杠——之前正是这层转义最容易写错，
 * 而且标题里带 `-` 或 `.` 时会糊成一片反斜杠。
 */
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

            // 手动分析没有异动方向：画像器按「买入=同向」处理，时点分只作参考
            const report = await this.profiler.analyzeMarket(
                metadata.tokenIds[0] || metadata.id,
                metadata.conditionId,
                0.5,
            );

            if (report.results.length > 0) {
                await this.sendProfilerReport({
                    title: metadata.title,
                    marketId: metadata.id,
                    category: "Manual",
                    slug: slug,
                    outcome: "N/A"
                }, report.results, report.stats);
                await this.bot.sendMessage(chatId, `分析完成。发现 ${report.results.length} 个高疑钱包。`);
            } else {
                await this.sendSafeReport({
                    title: metadata.title,
                    marketId: metadata.id,
                    category: "Manual",
                    slug: slug,
                    outcome: "N/A"
                }, report.stats);
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

        const time = new Date().toLocaleString('zh-CN', { hour12: false });

        // 构造多种可能的链接以确保用户能打开
        const eventUrl = metadata.slug ? `https://polymarket.com/event/${metadata.slug}` : "";
        const marketUrl = metadata.slug ? `https://polymarket.com/market/${metadata.slug}` : "";
        const searchUrl = `https://polymarket.com/search?q=${encodeURIComponent(metadata.title)}`;

        const linkSection = eventUrl
            ? `<a href="${eventUrl}">官网直达</a> | <a href="${marketUrl}">备用链接</a> | <a href="${searchUrl}">搜索</a>`
            : `<a href="${searchUrl}">搜索跳转</a>`;

        const message = [
            `<b>!!! 异动警报 !!!</b>  ${escapeHtml(time)}`,
            `<b>市场:</b> ${escapeHtml(metadata.title)}`,
            `<b>幅度:</b> <code>${escapeHtml(anomaly.changePercentage)}</code>`,
            `<b>价格:</b> <code>${anomaly.previousPrice.toFixed(2)} -> ${anomaly.currentPrice.toFixed(2)}</code>`,
            `<b>链接:</b> ${linkSection}`,
        ].join('\n');

        try {
            await this.bot.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
        } catch (error: any) {
            console.error(`[Messenger] 发送 Telegram 消息失败: ${error.message}`);
        }
    }

    /**
     * 发送画像分析报告
     * @param stats 漏斗统计（成交流池 / 深挖数 / 命中数）—— 让报告自带覆盖率口径
     */
    async sendProfilerReport(metadata: MarketMetadata, results: ScoreResult[], stats?: ProfileStats) {
        if (!this.bot || !this.chatId) return;

        const lines: string[] = [];
        lines.push(`<b>[内幕画像分析]</b>`);
        lines.push(`<b>市场:</b> ${escapeHtml(metadata.title)}`);
        if (stats) {
            lines.push(`<b>口径:</b> 近 ${stats.windowHours}h 成交流 ${stats.poolWallets} 个钱包 / 深挖 ${stats.deepProfiled}`
                + ` / 共用注资 ${stats.correlatedWallets} / 阈值 ${stats.scoreThreshold}`);
        }
        lines.push('');

        results.forEach((res, index) => {
            const profileUrl = `https://polymarket.com/profile/${res.address}`;
            const b = res.breakdown;
            lines.push(`${index + 1}. <b>钱包:</b> <a href="${profileUrl}">${escapeHtml(res.address)}</a>`);
            lines.push(`   得分 <code>${res.totalScore}</code>`
                + ` (成交 ${b.tradeSignal} / 新鲜 ${b.freshness} / 专注 ${b.focus} / 同源 ${b.correlation} / 仓位 ${b.position} / 资金 ${b.capital})`);
            lines.push(`   特征: ${escapeHtml(res.details.join(", "))}`);
            lines.push('');
        });

        try {
            await this.bot.sendMessage(this.chatId, lines.join('\n'), {
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
        } catch (error: any) {
            console.error(`[Messenger] 发送画像报告失败: ${error.message}`);
        }
    }

    /**
     * 发送安全（无异常）报告
     */
    async sendSafeReport(metadata: MarketMetadata, stats?: ProfileStats) {
        if (!this.bot || !this.chatId) return;

        const coverage = stats
            ? `\n<b>口径:</b> 近 ${stats.windowHours}h 成交流 ${stats.poolWallets} 个钱包 / 深挖 ${stats.deepProfiled} 个`
            : '';
        const report = `<b>[画像分析完成]</b>\n<b>市场:</b> ${escapeHtml(metadata.title)}${coverage}`
            + `\n未发现显著的高疑内幕钱包交易。`;

        try {
            await this.bot.sendMessage(this.chatId, report, {
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
        } catch (error: any) {
            console.error(`[Messenger] 发送安全报告失败: ${error.message}`);
        }
    }
}

/** HTML 解析模式只需转义 & < > */
export function escapeHtml(text: string): string {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
