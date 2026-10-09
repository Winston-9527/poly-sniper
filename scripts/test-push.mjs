// 通过项目自身的 TelegramMessenger 发一条测试推送（走同样的 .env + 代理配置）
import "dotenv/config";
import { TelegramMessenger } from "../dist/sentinel/TelegramMessenger.js";

const token = process.env.TELEGRAM_BOT_TOKEN || "";
const chatId = process.env.TELEGRAM_CHAT_ID || "";
console.log(`[test] token 长度=${token.length} chatId=${chatId ? chatId.slice(0, 3) + "***" + chatId.slice(-2) : "(空)"}`);

const messenger = new TelegramMessenger(); // 不传 profiler => 不开启 polling

const anomaly = {
    marketId: "hermes-deploy-selftest",
    changePercentage: "+5.00% (部署自检)",
    previousPrice: 0.1,
    currentPrice: 0.15,
};
const metadata = {
    title: "Poly-Sniper 部署自检：这条消息来自你 mac mini 上的 bot",
    slug: "will-poly-sniper-deploy-succeed",
    conditionId: "0x0",
};

await messenger.sendAlert(anomaly, metadata);

// 直接确认一次 bot 身份与目标会话，便于核对 chat id 是否为你要的那个
const { default: TelegramBot } = await import("node-telegram-bot-api");
const { HttpsProxyAgent } = await import("https-proxy-agent");
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
const bot = new TelegramBot(token, { polling: false, request: proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : undefined });
const me = await bot.getMe();
const chat = await bot.getChat(chatId);
console.log(`[test] bot=@${me.username} (id ${me.id})  目标会话: type=${chat.type} title=${chat.title || chat.first_name || ""} id=${chat.id}`);
