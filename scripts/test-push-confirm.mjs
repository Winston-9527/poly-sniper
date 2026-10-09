// 发送一条明确标注的测试消息，并打印 Telegram 返回的 message_id 作为送达证据
import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { HttpsProxyAgent } from "https-proxy-agent";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;

const bot = new TelegramBot(token, { polling: false, request: proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : undefined });

const text = [
    "*\\[✅ 部署自检 \\]* Poly-Sniper 已在你 mac mini 上跑起来",
    "",
    "*服务:* launchd `com.siyuan.poly-sniper`（崩溃自动拉起）",
    "*监控:* 每 10 秒轮询 Polymarket，约 500 条价格更新/秒",
    "*链路:* 直连不通 → 已走代理 `127.0.0.1:7897`",
    "",
    "回复我 `/check <Polymarket 链接>` 可以测手动分析指令。",
].join("\n");

const res = await bot.sendMessage(chatId, text, { parse_mode: "Markdown", disable_web_page_preview: true });
console.log(`[送达证据] message_id=${res.message_id} date=${new Date(res.date * 1000).toLocaleString()} chat=${res.chat.id}(${res.chat.type}) 文本长度=${res.text.length}`);
