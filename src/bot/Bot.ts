/**
 * Telegram 交互（方案 §9.2）。命令是计划中的接口，这里实现 P1 需要的部分：
 *   /status  /wallet <地址>  /check <市场链接|slug|conditionId>  /watch  /unwatch  /watchlist  /help
 * 访问控制沿用并验证：只响应 TELEGRAM_CHAT_ID 白名单。
 */
import TelegramBot from 'node-telegram-bot-api';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Config } from '../config.js';
import { Repos } from '../db/repos.js';
import { Reports } from '../report/Reports.js';
import { LedgerPipeline } from '../ledger/Pipeline.js';
import { AlertOutbox, SendResult } from '../alerts/Outbox.js';
import { DataApiClient } from '../sources/DataApi.js';
import { normalizeAddress } from '../sources/contracts.js';
import { nowIso } from '../util/time.js';

export interface BotDeps {
    config: Config; repos: Repos; reports: Reports; pipeline: LedgerPipeline;
    outbox: AlertOutbox; dataApi: DataApiClient; log: (m: string) => void;
}

const HELP = [
    '<b>可用命令</b>',
    '/status — 采集延迟、覆盖、队列积压、未解决缺口',
    '/wallet &lt;地址&gt; — 长期画像、当前组合、数据缺口',
    '/check &lt;市场链接|slug|conditionId&gt; — 市场背景与重点增删仓钱包',
    '/watch &lt;地址|市场链接&gt; — 加入持续关注（手动关注不会被自动淘汰）',
    '/unwatch &lt;地址|市场链接&gt; — 取消关注（历史记录保留）',
    '/watchlist — 当前关注对象',
    '',
    '说明：报告区分「事实 / 推断 / 缺失」；「未观察到」不等于「没有发生」。',
].join('\n');

const HELL_TEXT_LIMIT = 4096;
/** 按行切分长消息（Telegram 单条上限 4096 字符），不截断内容 */
export function splitForTelegram(html: string, limit = HELL_TEXT_LIMIT - 96): string[] {
    if (html.length <= HELL_TEXT_LIMIT - 16) return [html];
    const out: string[] = [];
    let cur = '';
    for (const line of html.split('\n')) {
        if (cur.length + line.length + 1 > limit) { out.push(cur); cur = ''; }
        cur += (cur ? '\n' : '') + line;
    }
    if (cur) out.push(cur);
    return out.length ? out : [html];
}

export class LedgerBot {
    private bot: TelegramBot | null = null;
    private allowed: Set<string>;
    private log: (m: string) => void;

    constructor(private deps: BotDeps) {
        this.allowed = new Set(deps.config.telegram.chatIds.map((x) => String(x)));
        this.log = deps.log;
    }

    /** outbox 用的发送器；影子模式下不真的发送 */
    sender = async (chatId: string, html: string): Promise<SendResult> => {
        if (this.deps.config.shadowMode) {
            this.log(`[shadow] 不发送 Telegram 消息（${html.length} 字符）→ ${chatId}`);
            return { ok: true, messageId: 'shadow' };
        }
        if (!this.bot) return { ok: false, error: 'Telegram 未初始化（缺 token 或被禁用）' };
        // Telegram 单条上限 4096 字符：超长报告按行切分，顺序发送，不截断内容
        const chunks = splitForTelegram(html);
        let lastId = '';
        for (const [i, chunk] of chunks.entries()) {
            try {
                const msg = await this.bot.sendMessage(chatId, chunk, { parse_mode: 'HTML', disable_web_page_preview: true });
                lastId = String(msg.message_id);
            } catch (e) {
                const err = e as { response?: { body?: { description?: string; error_code?: number } }; message?: string };
                const desc = err.response?.body?.description ?? err.message ?? '未知错误';
                const code = err.response?.body?.error_code;
                return { ok: false, error: `${code ?? ''} ${desc}`.trim() + (chunks.length > 1 ? `（第 ${i + 1}/${chunks.length} 段失败）` : '') };
            }
        }
        return { ok: true, messageId: lastId };
    };

    send(html: string, chatId?: string): Promise<SendResult> {
        const target = chatId ?? this.deps.config.telegram.chatIds[0];
        if (!target) return Promise.resolve({ ok: false, error: '没有配置 chat id' });
        return this.sender(target, html);
    }

    /**
     * 为一次性发送创建 Telegram 客户端（**不开轮询**）。
     * 供 test-push 这类工具使用：不与正在运行的服务抢 getUpdates（避免 409 Conflict），
     * 也不受 TELEGRAM_ENABLED 影响（该开关只管常驻轮询）。
     */
    ensureSender(): boolean {
        if (this.bot) return true;
        const { token } = this.deps.config.telegram;
        if (!token) return false;
        const options: TelegramBot.ConstructorOptions = { polling: false };
        if (this.deps.config.proxyUrl) {
            // @ts-expect-error node-telegram-bot-api 类型未包含 request 选项
            options.request = { agent: new HttpsProxyAgent(this.deps.config.proxyUrl) };
        }
        this.bot = new TelegramBot(token, options);
        this.log('[bot] 已创建一次性发送客户端（不轮询，不影响正在运行的服务）');
        return true;
    }

    start(): void {
        const { token, enabled } = this.deps.config.telegram;
        if (!token || !enabled) {
            this.log('[bot] Telegram 未启用（TELEGRAM_ENABLED/token 未配置），只跑采集与本地报告');
            return;
        }
        const options: TelegramBot.ConstructorOptions = { polling: true };
        if (this.deps.config.proxyUrl) {
            // @ts-expect-error node-telegram-bot-api 类型未包含 request 选项
            options.request = { agent: new HttpsProxyAgent(this.deps.config.proxyUrl) };
        }
        this.bot = new TelegramBot(token, options);
        this.bot.on('polling_error', (e: Error) => this.log(`[bot] polling_error: ${e.message}`));
        this.bot.on('message', (msg) => { void this.handle(msg); });
        this.log('[bot] Telegram 已启动（轮询模式）');
    }

    async stop(): Promise<void> { if (this.bot) await this.bot.stopPolling(); }

    /** 解析输入：地址 / polymarket 链接 / slug / conditionId */
    async resolveTarget(text: string): Promise<{ kind: 'wallet'; address: string } | { kind: 'market'; conditionId: string; slug?: string } | { kind: 'unknown' }> {
        const t = text.trim();
        const addr = normalizeAddress(t);
        if (addr) return { kind: 'wallet', address: addr };
        const urlMatch = /polymarket\.com\/(event|market)\/([\w-]+)/.exec(t);
        const slug = urlMatch ? urlMatch[2] : (/^[\w-]{6,}$/.test(t) ? t : null);
        if (slug) {
            const m = await this.deps.dataApi.getMarketBySlug(slug);
            if (m.ok && m.data) return { kind: 'market', conditionId: m.data.conditionId, slug };
        }
        if (/^0x[0-9a-fA-F]{64}$/.test(t)) return { kind: 'market', conditionId: t.toLowerCase() };
        return { kind: 'unknown' };
    }

    private async handle(msg: TelegramBot.Message): Promise<void> {
        const chatId = String(msg.chat.id);
        const text = (msg.text ?? '').trim();
        if (!text.startsWith('/')) return;
        if (!this.allowed.has(chatId)) {
            this.log(`[bot] 拒绝未授权会话 ${chatId}`);
            return;
        }
        const [cmd, ...rest] = text.split(/\s+/);
        const arg = rest.join(' ').trim();
        try {
            switch (cmd) {
                case '/start':
                case '/help':
                    await this.reply(chatId, HELP);
                    return;
                case '/status': {
                    const s = this.deps.pipeline.stats();
                    await this.reply(chatId, this.deps.reports.statusReport({ cycles: s.cycles, lastCycleAt: s.lastCycleAt }));
                    return;
                }
                case '/wallet': {
                    const a = normalizeAddress(arg);
                    if (!a) { await this.reply(chatId, '用法：/wallet 0x…（40 位十六进制地址）'); return; }
                    this.deps.repos.ensureWallet(a);
                    await this.reply(chatId, this.deps.reports.walletReport(a));
                    return;
                }
                case '/check': {
                    const target = await this.resolveTarget(arg);
                    if (target.kind !== 'market') { await this.reply(chatId, '无法解析市场。用法：/check <polymarket 链接 | slug | conditionId>'); return; }
                    await this.reply(chatId, this.deps.reports.marketReport(target.conditionId));
                    return;
                }
                case '/watch': {
                    const target = await this.resolveTarget(arg);
                    if (target.kind === 'wallet') {
                        this.deps.repos.watch(target.address, { source: 'manual', tier: 1, reason: `用户手动关注（${chatId}）`, nextCollectAt: nowIso() });
                        await this.reply(chatId, `已关注钱包 ${target.address}（手动关注不会被自动淘汰，需要 /unwatch 才退出）`);
                        return;
                    }
                    if (target.kind === 'market') {
                        this.deps.repos.addWatchedMarket(target.conditionId, target.slug ?? null, `用户手动关注（${chatId}）`);
                        await this.reply(chatId, `已关注市场 ${target.slug ?? target.conditionId}；下一轮会建立候选与快照。`);
                        return;
                    }
                    await this.reply(chatId, '用法：/watch <地址|市场链接>');
                    return;
                }
                case '/unwatch': {
                    const target = await this.resolveTarget(arg);
                    if (target.kind === 'wallet') {
                        const n = this.deps.repos.unwatch(target.address);
                        await this.reply(chatId, n ? `已取消关注 ${target.address}（历史记录保留）` : `该地址不在关注名单里`);
                        return;
                    }
                    if (target.kind === 'market') {
                        const n = this.deps.repos.removeWatchedMarket(target.conditionId);
                        await this.reply(chatId, n ? `已取消关注市场 ${target.slug ?? target.conditionId}` : '该市场不在关注名单里');
                        return;
                    }
                    await this.reply(chatId, '用法：/unwatch <地址|市场链接>');
                    return;
                }
                case '/watchlist': {
                    const rows = this.deps.repos.watchlist(true);
                    const markets = this.deps.repos.listWatchedMarkets();
                    const lines = [`<b>关注对象</b>（${rows.length} 个钱包，${markets.length} 个市场）`];
                    for (const r of rows.slice(0, 20)) {
                        lines.push(`· ${String(r.address).slice(0, 10)}…  tier${r.priority_tier} ${r.source} ${r.state}｜${String(r.reason ?? '').slice(0, 50)}`);
                    }
                    for (const m of markets) lines.push(`· 市场 ${String(m.slug ?? m.condition_id).slice(0, 40)}`);
                    await this.reply(chatId, lines.join('\n'));
                    return;
                }
                default:
                    await this.reply(chatId, `未知命令。\n\n${HELP}`);
            }
        } catch (e) {
            this.log(`[bot] 处理命令失败：${(e as Error).message}`);
            await this.reply(chatId, `命令执行失败：${(e as Error).message}`);
        }
    }

    private async reply(chatId: string, html: string): Promise<void> {
        const res = await this.sender(chatId, html);
        if (!res.ok) this.log(`[bot] 回复失败：${res.error}`);
    }
}
