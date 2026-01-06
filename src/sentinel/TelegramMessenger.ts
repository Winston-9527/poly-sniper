import TelegramBot from 'node-telegram-bot-api';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Anomaly, MarketMetadata, ScoreResult } from './types.js';

export class TelegramMessenger {
    private bot: TelegramBot | null = null;
    private chatId: string | null = null;

    constructor() {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = process.env.TELEGRAM_CHAT_ID || null;
        const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;

        if (token && this.chatId) {
            const options: TelegramBot.ConstructorOptions = {
                polling: false
            };

            if (proxyUrl) {
                console.log(`[Messenger] Telegram 机器人正在使用代理: ${proxyUrl}`);
                // @ts-ignore - node-telegram-bot-api 的类型定义可能不包含 request 选项
                options.request = {
                    agent: new HttpsProxyAgent(proxyUrl)
                };
            }

            this.bot = new TelegramBot(token, options);
            console.log(`[Messenger] Telegram 机器人已初始化。目标 Chat ID: ${this.chatId}`);
        } else {
            console.warn("[Messenger] 未配置 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID，Telegram 推送已禁用。");
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
     * 转义 Markdown 特殊字符
     */
    private escapeMarkdown(text: string): string {
        return text.replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
    }
}
