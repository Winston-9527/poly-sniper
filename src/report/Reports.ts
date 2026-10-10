/**
 * 报告渲染（方案 §9）。规则：
 *   - 先给行为与背景，再给证据和限制；「事实 / 推断 / 缺失」分开写。
 *   - 不把「没有观察到」改写成「没有发生」。
 *   - Telegram HTML 模式：动态内容只转义 & < >（方案 §10）。
 *   - 时间展示用东八区并注明。
 */
import { Repos } from '../db/repos.js';
import { Config } from '../config.js';
import { decToString, fromDb, parseDec, pctString, decToNumber, mul, sumDec } from '../util/decimal.js';
import { toDisplay, durationText, nowIso, unixToIso } from '../util/time.js';
import { fmtUsd, fmtQty, fmtPct, fmtCompactUsd } from '../util/format.js';
import { scoreWalletProfile, ScoreInput } from '../ledger/WalletScore.js';
import { Profiler, ProfileMetrics } from '../ledger/Profiler.js';
import { DataQuality, Priority } from '../ledger/Behaviors.js';

export function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface MarketObservationRow {
    condition_id: string; token_id: string | null; outcome: string | null; price: string | null;
    best_bid: string | null; best_ask: string | null; spread: string | null; last_trade_price: string | null;
    change_1h: string | null; change_24h: string | null; volume_24h: string | null; liquidity: string | null;
    observed_at: string;
}

/** 市场异动一行（market_anomalies） */
export interface MarketAnomalyRow {
    id: number; condition_id: string; token_id: string | null; outcome: string | null; kind: string;
    window_minutes: number; price_before: string | null; price_after: string | null; delta: string | null;
    best_bid: string | null; best_ask: string | null; spread: string | null; volume_24h: string | null;
    liquidity: string | null; change_1h: string | null; change_24h: string | null;
    priority: string; reason: string; data_quality: string; rule_version: string; event_at: string; observed_at: string;
}

export interface Magnitude { before?: string | null; after?: string | null; delta?: string | null; pct?: string | null; notional?: string | null; cashDelta?: string | null; outcome?: string | null; }

export interface BehaviorRow {
    id: number; wallet: string; condition_id: string | null; token_id: string | null; event_type: string;
    magnitude: string | null; evidence: string; data_quality: DataQuality; priority: Priority; priority_reason: string;
    rule_version: string; event_at: string; observed_at: string;
}

const EVENT_LABEL: Record<string, string> = {
    position_opened: '新出现的持仓',
    position_increased: '显著加仓',
    position_reduced: '部分减仓',
    position_exited: '本地址退出（份数归零）',
    reactivated: '沉寂后恢复活动',
    capital_in: '资金转入（可解释部分）',
    capital_out: '资金转出（可解释部分）',
    unexplained_change: '未解释的份数/资金变化',
};
const QUALITY_LABEL: Record<string, string> = { verified: '已核对', partial: '部分核对', incomplete: '证据不足' };
const PRIORITY_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' };
const NOTIONAL_LABEL: Record<string, string> = { '?': '?' };

export function eventLabel(t: string): string { return EVENT_LABEL[t] ?? t; }
export function qualityLabel(q: string): string { return QUALITY_LABEL[q] ?? q; }

export class Reports {
    private profiler: Profiler;
    constructor(private repos: Repos, private config: Config) { this.profiler = new Profiler(repos); }

    private link(text: string, url: string): string { return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`; }

    // ---------- 市场维度（方案 §9.1：报告必须有市场信息） ----------

    /** 市场页链接：优先 slug（market），退而用 event_slug；都没有则返回 null（不伪造链接） */
    private marketUrl(market?: { slug: string | null; event_slug: string | null } | undefined): string | null {
        if (!market) return null;
        if (market.slug) return `https://polymarket.com/market/${market.slug}`;
        if (market.event_slug) return `https://polymarket.com/event/${market.event_slug}`;
        return null;
    }

    /** 市场背景：现价、盘口、24h 量/流动性、变化、结束时间（缺失写「未知」，不猜 0） */
    private marketBackgroundLines(conditionId: string | null, tokenId: string | null, wallet: string): string[] {
        if (!conditionId) return [];
        const obs = this.repos.latestMarketObservation(conditionId);
        const market = this.repos.market(conditionId);
        const snap = tokenId ? this.repos.snapshotForToken(wallet, tokenId) : undefined;
        const parts: string[] = [];
        const price = snap?.price ?? obs?.price ?? null;
        parts.push(price ? `现价 ${fmtQty(price)}` : '现价 未知');
        const bid = obs?.best_bid ?? null, ask = obs?.best_ask ?? null, sp = obs?.spread ?? null;
        parts.push(bid && ask ? `盘口 买 ${fmtQty(bid)}/卖 ${fmtQty(ask)}${sp ? `（价差 ${fmtQty(sp)}）` : ''}` : '盘口 未取到');
        parts.push(obs ? `24h 成交量 ${fmtCompactUsd(obs.volume_24h)}` : '24h 成交量 未知');
        parts.push(obs ? `流动性 ${fmtCompactUsd(obs.liquidity)}` : '流动性 未知');
        const ch1 = Reports.ratioToPct(obs?.change_1h ?? null), ch24 = Reports.ratioToPct(obs?.change_24h ?? null);
        const n1 = obs?.change_1h === null || obs?.change_1h === undefined ? null : Number(obs.change_1h);
        const n24 = obs?.change_24h === null || obs?.change_24h === undefined ? null : Number(obs.change_24h);
        if (ch1 || ch24) parts.push(`1h ${ch1 ?? '未知'}${Reports.ratioEmoji(n1)}｜24h ${ch24 ?? '未知'}${Reports.ratioEmoji(n24)}`);
        if (market?.end_date) parts.push(`结束 ${String(market.end_date).slice(0, 10)}`);
        if (market?.closed === 1) parts.push('状态 已关闭');
        const lines = [`${parts.join('｜')}`];
        if (!market?.question) {
            lines.push('⚠️ 市场标题未取到（这是数据缺口：只能用 conditionId 定位，不代表该市场无数据）');
        }
        return lines;
    }

    // ---------- 市场异动（首要信号） ----------

    static readonly ANOMALY_LABEL: Record<string, string> = {
        price_move: '价格异动', spread_widen: '盘口走阔', volume_surge: '成交量突增',
    };

    /** 涨=🟢 跌=🔴（绿涨红跌） */
    static arrow(d: number | null): string {
        if (d === null || !Number.isFinite(d) || d === 0) return '⚪';
        return d > 0 ? '🟢' : '🔴';
    }

    static kindEmoji(kind: string, delta: number | null): string {
        if (kind === 'spread_widen') return '📊';
        if (kind === 'volume_surge') return '🔥';
        if (delta === null) return '⚪';
        return delta > 0 ? '🟢📈' : delta < 0 ? '🔴📉' : '⚪';
    }

    static ratioEmoji(v: number | null): string {
        if (v === null || !Number.isFinite(v) || v === 0) return '';
        return v > 0 ? ' 🟢' : ' 🔴';
    }

    /** 价格变化：+5.0 个点 / -5.0 个点（带符号，方便一眼看方向） */
    static signedPctPoints(d: number): string {
        const p = (d * 100).toFixed(1);
        return `${d > 0 ? '+' : ''}${p} 个点`;
    }

    /**
     * 「谁在动」的一条：地址链接 + 买卖金额 + **该钱包的画像分**。
     * 画像分来自最近一次采集的画像（可核验的量：单笔规模/专注度/持仓/活跃时长/覆盖）；
     * 没采集过就如实写「未采集」（并已在采集队列里，下一轮起带分），不编分数。
     */
    walletMoverLines(m: { wallet: string; buy: string; sell: string; trades: number }): string[] {
        const w = m.wallet.toLowerCase();
        const buyN = Number(m.buy), sellN = Number(m.sell);
        const flows: string[] = [];
        if (buyN > 0) flows.push(`买 ${fmtUsd(m.buy)}`);
        if (sellN > 0) flows.push(`卖 ${fmtUsd(m.sell)}`);
        const dust = buyN + sellN < 1 ? '（灰尘级，<$1）' : '';
        const icon = buyN > 0 && sellN === 0 ? '🟢' : sellN > 0 && buyN === 0 ? '🔴' : '🟡';
        const lines = [`${icon} ${this.link(w.slice(0, 10) + '…', `https://polymarket.com/profile/${w}`)} ${flows.join(' / ') || '买/卖金额未知'}（${m.trades} 笔）${dust}`];
        const metrics = this.repos.latestProfileMetrics(w);
        if (metrics) {
            const sc = scoreWalletProfile(metrics as ScoreInput);
            lines.push(`　　🧭 画像 <b>${sc.total}</b> 分（${sc.summary}）${sc.notes.length ? `⚠️ ${sc.notes[0]}` : ''}`);
        } else {
            lines.push('　　🧭 画像未采集（已入采集队列，下一轮起带分）');
        }
        return lines;
    }

    /**
     * 市场异动报告：一眼看到「涨还是跌 / 现价 / 盘口 / 谁在动（含画像分）」。
     * 事件时间与规则版本不再展示（用户要求）；但数据不完整时仍显式标注，不假装完整。
     */
    marketAnomalyReport(a: MarketAnomalyRow, opts: { movers?: { wallet: string; buy: string; sell: string; trades: number }[]; shadow?: boolean } = {}): { title: string; body: string } {
        const market = this.repos.market(a.condition_id);
        const question = String(market?.question ?? `condition ${a.condition_id.slice(0, 12)}…`);
        const url = this.marketUrl(market);
        const label = Reports.ANOMALY_LABEL[a.kind] ?? a.kind;
        const delta = a.delta === null || a.delta === undefined ? null : Number(a.delta);
        const lines: string[] = [];

        lines.push(`<b>${Reports.kindEmoji(a.kind, delta)} ${escapeHtml(label)}</b>${opts.shadow ? '  <i>[影子模式]</i>' : ''}`);
        lines.push(`🏷 ${url ? this.link(question.slice(0, 60), url) : escapeHtml(question)}`);

        if (a.price_after) {
            const tail = a.kind === 'price_move' && a.price_before
                ? ` ${Reports.arrow(delta)} ${Reports.signedPctPoints(delta ?? 0)}（${a.window_minutes} 分钟 ${fmtQty(a.price_before)} → ${fmtQty(a.price_after)}）`
                : (a.outcome ? `（结果 ${escapeHtml(a.outcome)}）` : '');
            lines.push(`💰 现价 <b>${fmtQty(a.price_after)}</b>${tail}`);
        } else if (a.outcome) {
            lines.push(`🎯 结果 ${escapeHtml(a.outcome)}`);
        }

        let book = '未取到';
        if (a.best_bid && a.best_ask) {
            const inverted = Number(a.best_bid) > Number(a.best_ask);
            book = `买 ${fmtQty(a.best_bid)} / 卖 ${fmtQty(a.best_ask)}`
                + (a.spread ? `（价差 ${fmtQty(a.spread)}）` : inverted ? '（买一高于卖一：瞬时错位，价差按未知处理）' : '（价差未取到）');
        }
        lines.push(`📕 盘口 ${book}${a.kind === 'spread_widen' ? ' 🟡 走阔' : ''}`);

        if (a.kind !== 'price_move') lines.push(`⚡ ${escapeHtml(a.reason)}`);

        const bg: string[] = [`24h 成交 ${fmtCompactUsd(a.volume_24h)}`, `流动性 ${fmtCompactUsd(a.liquidity)}`];
        const c1 = Reports.ratioToPct(a.change_1h);
        const c1n = a.change_1h === null || a.change_1h === undefined ? null : Number(a.change_1h);
        const c24 = Reports.ratioToPct(a.change_24h);
        const c24n = a.change_24h === null || a.change_24h === undefined ? null : Number(a.change_24h);
        if (c1 || c24) bg.push(`1h ${c1 ?? '未知'}${Reports.ratioEmoji(c1n)}｜24h ${c24 ?? '未知'}${Reports.ratioEmoji(c24n)}`);
        if (market?.end_date) bg.push(`结束 ${String(market.end_date).slice(0, 10)}`);
        lines.push(`📊 ${bg.join('｜')}`);
        lines.push('');

        if (opts.movers?.length) {
            lines.push('👀 <b>谁在动</b>（该市场最近已获取的成交，非全市场）');
            for (const m of opts.movers) for (const l of this.walletMoverLines(m)) lines.push(l);
        } else {
            lines.push('👀 谁在动：未取到该市场的成交流水（这是缺口，不是「没人交易」）');
        }
        lines.push('');

        if (url) lines.push(this.link('打开 Polymarket 市场页', url));
        else lines.push('🔗 市场页链接未取到（缺 slug，不伪造链接）');
        if (a.data_quality !== 'verified') lines.push(`⚠️ 数据完整度：${qualityLabel(a.data_quality)}`);
        return { title: `${label} · ${question.slice(0, 40)}`, body: lines.join('\n') };
    }

    /** 市场异动的摘要一行（当日汇总用） */
    marketAnomalyLine(a: MarketAnomalyRow): string {
        const market = this.repos.market(a.condition_id);
        const name = market?.question ? String(market.question).slice(0, 34) : `condition ${a.condition_id.slice(0, 10)}…`;
        const label = Reports.ANOMALY_LABEL[a.kind] ?? a.kind;
        const detail = a.kind === 'price_move' && a.price_before && a.price_after
            ? `${fmtQty(a.price_before)}→${fmtQty(a.price_after)}`
            : a.kind === 'volume_surge' ? '24h 量突增' : '盘口走阔';
        return `${label}｜${name}｜${detail}`;
    }

    /** 事件一行摘要（合并摘要与卡片共用）：市场名｜钱包短地址｜金额（%）｜优先级 */
    descriptor(e: BehaviorRow): string {
        const mag = JSON.parse(e.magnitude ?? '{}') as Magnitude;
        const market = e.condition_id ? this.repos.market(e.condition_id) : undefined;
        const name = market?.question ?? (e.condition_id ? `condition ${e.condition_id.slice(0, 10)}…` : '市场未知');
        const delta = mag.delta === null || mag.delta === undefined ? null : Number(mag.delta);
        const sign = delta !== null && delta < 0 ? '-' : '+';
        const amt = mag.notional ? `${sign}${fmtUsd(mag.notional)}` : '金额未知';
        const pct = mag.pct ? `（${fmtPct(mag.pct)}）` : '';
        return `${String(name).slice(0, 46)}｜${e.wallet.slice(0, 6)}…${e.wallet.slice(-4)}｜${amt}${pct}｜${PRIORITY_LABEL[e.priority] ?? e.priority}`;
    }

    /** 行为告警报告（方案 §9.1 的落地） */
    behaviorReport(e: BehaviorRow, opts: { shadow?: boolean } = {}): { title: string; body: string } {
        const mag = JSON.parse(e.magnitude ?? '{}') as Magnitude;
        const market = e.condition_id ? this.repos.market(e.condition_id) : undefined;
        const token = e.token_id ? this.repos.token(e.token_id) : undefined;
        const question = market?.question ?? (e.condition_id ? `condition ${e.condition_id.slice(0, 12)}…` : '（市场未知）');
        const outcome = mag.outcome ?? token?.outcome ?? '?';
        const wallet = e.wallet;
        const profile = this.profiler.build(wallet, { windowsDays: this.config.rules.baselineWindowsDays });
        const gaps = this.repos.openGaps(20).filter((g) => String(g.key) === wallet || (e.condition_id && String(g.key) === e.condition_id));

        const lines: string[] = [];
        lines.push(`<b>${escapeHtml(eventLabel(e.event_type))}</b>${opts.shadow ? '  <i>[影子模式]</i>' : ''}`);
        lines.push('');
        // —— 行为（事实） ——
        const before = mag.before ?? '未知', after = mag.after ?? '未知';
        lines.push(`市场：${escapeHtml(String(question))}`);
        lines.push(`结果：${escapeHtml(String(outcome))}`);
        for (const l of this.marketBackgroundLines(e.condition_id, e.token_id, wallet)) lines.push(escapeHtml(l));
        lines.push(`份数：${fmtQty(String(before))} → ${fmtQty(String(after))}（变化 ${fmtQty(String(mag.delta ?? '未知'))}${mag.pct ? '，' + fmtPct(mag.pct) : ''}）`);
        if (mag.notional) {
            const signed = Number(mag.delta ?? 0) < 0 ? `-${fmtUsd(mag.notional)}` : `+${fmtUsd(mag.notional)}`;
            lines.push(`名义金额估算：${signed}（按该 token 自身价格，本报告不使用另一边的价格）`);
        }
        if (e.event_type === 'position_exited') lines.push(`说明：这是<b>本地址</b>在该 token 上观察到的份数归零；不能据此断言某个自然人全部退出，也不排除外部对冲。`);
        if (e.event_type === 'position_reduced') lines.push(`说明：减仓不自动解释为止盈或止损，也不因为卖出金额更大就判定为反手/对冲。`);
        lines.push('');
        // —— 背景 ——
        lines.push(`<b>背景</b>`);
        lines.push(`钱包：${this.link(wallet.slice(0, 10) + '…' + wallet.slice(-6), `https://polymarket.com/profile/${wallet}`)}`);
        lines.push(this.profileLine(profile));
        const pos = this.positionLine(wallet);
        if (pos) lines.push(pos);
        const sib = this.repos.siblingsByOwner(wallet);
        lines.push(sib.length ? `控制关系：与 ${sib.length} 个地址共享同一 owner（仅记录证据，不合并身份）` : `控制关系：未取到可核验的 owner（未知，不等于无关联）`);
        lines.push(`触发原因：${escapeHtml(e.priority_reason)}`);
        lines.push('');
        // —— 数据完整度 ——
        lines.push(`<b>数据完整度</b>：${qualityLabel(e.data_quality)}｜关注优先级：${PRIORITY_LABEL[e.priority] ?? e.priority}（优先级与数据质量分开判断）`);
        if (gaps.length) {
            lines.push(`已知缺口（${gaps.length}）：`);
            for (const g of gaps.slice(0, 5)) lines.push(`• ${escapeHtml(String(g.reason))}：${escapeHtml(String(g.detail ?? '').slice(0, 120))}`);
        } else {
            lines.push('已知缺口：本报告涉及的钱包/市场当前没有登记的缺口（表示「已获取区间内未发现」，不表示「一定没有」）');
        }
        lines.push('');
        // —— 证据 ——
        const ev = JSON.parse(e.evidence ?? '{}') as Record<string, unknown>;
        lines.push(`<b>证据</b>`);
        lines.push(`事件时间：${escapeHtml(toDisplay(e.event_at))}｜采集时间：${escapeHtml(toDisplay(e.observed_at))}`);
        lines.push(`持仓过程：episode ${escapeHtml(String(ev.episodeId ?? '?'))}，账本条目 ${escapeHtml(JSON.stringify(ev.ledgerEntryIds ?? []))}`);
        lines.push(`规则版本：${escapeHtml(e.rule_version)}（阈值是可配置假设，影子运行后再调整）`);
        const mUrl = this.marketUrl(market);
        if (mUrl) lines.push(this.link(market?.slug ? 'Polymarket 市场页' : 'Polymarket 事件页', mUrl));
        else if (market) lines.push('市场页链接未取到（缺 slug；已尝试用活动里的 slug 补齐）');
        lines.push(this.link('链上地址', `https://polymarket.com/profile/${wallet}`));
        return { title: `${eventLabel(e.event_type)} · ${String(question).slice(0, 40)}`, body: lines.join('\n') };
    }

    /**
     * 一个钱包一轮内的多个事件合并成一张卡片（方案 §9.1）：事件逐行列出，背景/缺口/证据只出现一次。
     * 只有 1 条事件时退回单事件报告（格式不变），但同样返回合并摘要用的 digestLines。
     */
    walletCycleReport(rows: BehaviorRow[], opts: { shadow?: boolean } = {}): { title: string; body: string; digestLines: string[] } {
        const digestLines = rows.map((r) => this.descriptor(r));
        if (!rows.length) return { title: '（无事件）', body: '', digestLines };
        if (rows.length === 1) {
            const one = this.behaviorReport(rows[0], opts);
            return { title: one.title, body: one.body, digestLines };
        }
        const sorted = [...rows].sort((a, b) => Date.parse(a.event_at) - Date.parse(b.event_at));
        const wallet = sorted[0].wallet;
        const marks = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
        const lines: string[] = [];
        lines.push(`<b>钱包动态 · ${sorted.length} 个事件</b>${opts.shadow ? '  <i>[影子模式]</i>' : ''}`);
        lines.push('');
        sorted.forEach((e, i) => lines.push(...this.eventCardLines(e, marks[i] ?? `(${i + 1})`)));
        lines.push('');
        lines.push('<b>背景</b>');
        lines.push(`钱包：${this.link(wallet.slice(0, 10) + '…' + wallet.slice(-6), `https://polymarket.com/profile/${wallet}`)}`);
        const profile = this.profiler.build(wallet, { windowsDays: this.config.rules.baselineWindowsDays });
        lines.push(this.profileLine(profile));
        const pos = this.positionLine(wallet, 3);
        if (pos) lines.push(`${pos}（最多显示 3 项，完整组合见 /wallet）`);
        const sib = this.repos.siblingsByOwner(wallet);
        lines.push(sib.length ? `控制关系：与 ${sib.length} 个地址共享同一 owner（仅记录证据，不合并身份）` : '控制关系：未取到可核验的 owner（未知，不等于无关联）');
        lines.push('');
        const byPriority = { high: 0, medium: 0, low: 0 } as Record<string, number>;
        for (const e of sorted) byPriority[e.priority] = (byPriority[e.priority] ?? 0) + 1;
        const prioText = (['high', 'medium', 'low'] as const).filter((p) => byPriority[p]).map((p) => `${PRIORITY_LABEL[p]} ${byPriority[p]}`).join(' / ');
        const quality = sorted.some((e) => e.data_quality === 'incomplete') ? 'incomplete' : (sorted.some((e) => e.data_quality === 'partial') ? 'partial' : 'verified');
        lines.push(`<b>数据完整度</b>：优先级 ${prioText}｜质量 ${qualityLabel(quality)}（优先级与数据质量分开判断）`);
        const gapSeen = new Set<string>();
        const gaps = this.repos.openGaps(50).filter((g) => {
            const key = String(g.key);
            if (key !== wallet && !sorted.some((e) => e.condition_id && String(e.condition_id) === key)) return false;
            const sig = `${g.reason}|${String(g.detail ?? '').slice(0, 60)}`;
            if (gapSeen.has(sig)) return false;
            gapSeen.add(sig);
            return true;
        });
        if (gaps.length) {
            lines.push(`已知缺口（去重后 ${gaps.length}，同一缺口不再逐条重复）：`);
            for (const g of gaps.slice(0, 5)) lines.push(`• ${escapeHtml(String(g.reason))}：${escapeHtml(String(g.detail ?? '').slice(0, 120))}`);
        } else {
            lines.push('已知缺口：本报告涉及的钱包/市场当前没有登记的缺口（表示「已获取区间内未发现」，不表示「一定没有」）');
        }
        lines.push('');
        lines.push(`<b>证据</b>`);
        lines.push(`事件时间：${escapeHtml(toDisplay(sorted[0].event_at))} → ${escapeHtml(toDisplay(sorted[sorted.length - 1].event_at))}｜采集时间：${escapeHtml(toDisplay(sorted[sorted.length - 1].observed_at))}`);
        lines.push(`规则版本：${escapeHtml(sorted[sorted.length - 1].rule_version)}（阈值是可配置假设，影子运行后再调整）`);
        for (const [, e] of new Map(sorted.map((e) => [e.condition_id ?? '', e])).entries()) {
            const market = e.condition_id ? this.repos.market(e.condition_id) : undefined;
            const url = this.marketUrl(market);
            const name = market?.question ? String(market.question).slice(0, 40) : (e.condition_id ? `condition ${e.condition_id.slice(0, 10)}…` : '市场未知');
            lines.push(url ? this.link(`市场页：${name}`, url) : `市场页未取到（${name}）`);
        }
        lines.push(this.link('链上地址', `https://polymarket.com/profile/${wallet}`));
        return { title: `钱包动态 · ${sorted.length} 个事件 · ${wallet.slice(0, 8)}…`, body: lines.join('\n'), digestLines };
    }

    /** 卡片里单个事件的两行（第一行行为+金额，第二行市场背景） */
    private eventCardLines(e: BehaviorRow, mark: string): string[] {
        const mag = JSON.parse(e.magnitude ?? '{}') as Magnitude;
        const market = e.condition_id ? this.repos.market(e.condition_id) : undefined;
        const name = market?.question ?? (e.condition_id ? `condition ${e.condition_id.slice(0, 10)}…` : '市场未知');
        const url = this.marketUrl(market);
        const label = escapeHtml(eventLabel(e.event_type));
        const outcome = mag.outcome ?? '?';
        const head = url
            ? `${mark} <b>${label}</b>｜${this.link(String(name).slice(0, 46), url)}（${escapeHtml(String(outcome))}）`
            : `${mark} <b>${label}</b>｜${escapeHtml(String(name).slice(0, 46))}（${escapeHtml(String(outcome))}）`;
        const deltaNum = Number(mag.delta ?? 0);
        const amount = mag.notional ? `${deltaNum < 0 ? '-' : '+'}${fmtUsd(mag.notional)}` : '金额未知';
        const pct = mag.pct ? `（${fmtPct(mag.pct)}）` : '';
        const first = `${head}｜${amount}${pct}｜${qualityLabel(e.data_quality)}`;
        const bg = this.marketBackgroundLines(e.condition_id, e.token_id, e.wallet).filter((l) => !l.startsWith('⚠️'));
        const second = `   份数 ${fmtQty(mag.before ?? '未知')} → ${fmtQty(mag.after ?? '未知')}${bg.length ? '｜' + bg[0] : ''}`;
        const extra = this.marketBackgroundLines(e.condition_id, e.token_id, e.wallet).some((l) => l.startsWith('⚠️'))
            ? [`   ⚠️ 市场标题未取到（数据缺口，不代表该市场没有数据）`] : [];
        return [first, second, ...extra];
    }

    private profileLine(p: ProfileMetrics): string {
        return `活跃历史：${escapeHtml(this.profiler.describeActivityHistory(p))}`;
    }

    private positionLine(wallet: string, limit = 5): string | null {
        const snaps = this.repos.latestPositionSnapshots(wallet);
        if (!snaps.length) return '当前组合：没有取到持仓快照（是「未知」，不是「空仓」）';
        const parts: string[] = [];
        for (const s of snaps.slice(0, limit)) {
            const size = fromDb(s.size as string | null);
            const price = fromDb(s.price as string | null);
            const value = size !== null && price !== null ? mul(size, price) : null;
            parts.push(`${String(s.outcome ?? '?')} ${fmtQty(decToString(size))} 份 @ ${fmtQty(decToString(price))}${value ? ` = ${fmtUsd(decToString(value))}` : ''}`);
        }
        return `当前组合（按各 token 自身价格）：${parts.join('；')}`;
    }

    /** /wallet 查询 */
    walletReport(address: string, opts: { windowsDays?: number[] } = {}): string {
        const w = address.toLowerCase();
        const profile = this.profiler.build(w, { windowsDays: opts.windowsDays ?? this.config.rules.baselineWindowsDays });
        const lines: string[] = [];
        lines.push(`<b>钱包画像</b> ${this.link(w.slice(0, 10) + '…' + w.slice(-6), `https://polymarket.com/profile/${w}`)}`);
        lines.push('');
        lines.push(`<b>覆盖与活跃历史</b>`);
        lines.push(this.profiler.describeActivityHistory(profile));
        const c = profile.coverage;
        if (c.truncated) lines.push(`⚠️ 历史被截断：${escapeHtml(c.truncationReason ?? '未取到来源起点')}`);
        lines.push('');
        lines.push(`<b>当前组合</b>（按各 token 自身价格）`);
        if (!profile.positions.length) lines.push('没有取到持仓快照（未知）');
        for (const p of profile.positions.slice(0, 8)) {
            lines.push(`• ${escapeHtml(p.outcome ?? '?')} ${escapeHtml(p.size ?? '未知')} 份 @ ${escapeHtml(p.price ?? '未知')} = $${escapeHtml(p.value ?? '未知')}（${p.completeness}）`);
        }
        if (profile.positionValueCovered) lines.push(`已覆盖组合价值：$${escapeHtml(profile.positionValueCovered)}（只覆盖已获取到的持仓，不等于全部财富）`);
        lines.push('');
        lines.push(`<b>交易习惯</b>（窗口 ${profile.tradeNotional.windowDays} 天，排除当前待评估行为 ${profile.tradeNotional.excludedEvents} 笔）`);
        lines.push(`单笔名义金额：样本 ${profile.tradeNotional.samples}，中位 $${escapeHtml(profile.tradeNotional.p50 ?? '未知')}，90 分位 $${escapeHtml(profile.tradeNotional.p90 ?? '未知')}`);
        lines.push(`活动类型分布：${escapeHtml(Object.entries(profile.activityByType).map(([k, v]) => `${k}×${v}`).join('，') || '无')}`);
        lines.push('');
        lines.push(`<b>关系背景</b>`);
        if (!profile.relations.length) lines.push('没有可核验的控制关系记录（未知，不等于无关联）');
        for (const r of profile.relations.slice(0, 5)) lines.push(`• ${escapeHtml(r.type)} ← ${escapeHtml(r.to.slice(0, 12))}…（${r.strength}）`);
        lines.push('');
        lines.push(`<b>历史表现</b>`);
        lines.push(escapeHtml(profile.pnl.reason));
        lines.push('');
        const gaps = this.repos.openGaps(20).filter((g) => String(g.key) === w);
        lines.push(`<b>数据缺口</b>：${gaps.length ? escapeHtml(gaps.map((g) => String(g.reason)).join('，')) : '无登记缺口'}`);
        for (const n of profile.notes) lines.push(`· ${escapeHtml(n)}`);
        return lines.join('\n');
    }

    /** /check 市场查询：重点增仓/减仓/退出 + 覆盖说明 */
    marketReport(conditionId: string, opts: { hours?: number } = {}): string {
        const hours = opts.hours ?? 24;
        const since = new Date(Date.now() - hours * 3600_000).toISOString();
        const market = this.repos.market(conditionId);
        const tokens = this.repos.db.all<{ token_id: string; outcome: string | null }>('SELECT token_id, outcome FROM outcome_tokens WHERE condition_id=?', conditionId);
        const events = this.repos.db.all<BehaviorRow & Record<string, unknown>>(
            `SELECT * FROM behavior_events WHERE condition_id=? AND event_at >= ? ORDER BY event_at DESC LIMIT 40`, conditionId, since,
        );
        const watch = this.repos.db.all<{ address: string; source: string; reason: string | null }>(
            'SELECT address, source, reason FROM watchlist WHERE market_condition_id=? AND withdrawn_at IS NULL LIMIT 60', conditionId,
        );
        const obs = this.repos.db.get<{ volume_24h: string | null; liquidity: string | null; observed_at: string }>(
            'SELECT volume_24h, liquidity, observed_at FROM market_observations WHERE condition_id=? ORDER BY observed_at DESC LIMIT 1', conditionId,
        );
        const lines: string[] = [];
        lines.push(`<b>市场背景</b> ${escapeHtml(market?.question ?? conditionId)}`);
        if (market?.slug) lines.push(this.link('市场页', `https://polymarket.com/event/${market.slug}`));
        lines.push(`结果 token：${escapeHtml(tokens.map((t) => `${t.outcome ?? '?'}:${t.token_id.slice(0, 8)}…`).join('，') || '未知')}`);
        if (obs) lines.push(`最近观察：24h 成交量 $${escapeHtml(obs.volume_24h ?? '未知')}，流动性 $${escapeHtml(obs.liquidity ?? '未知')}（${escapeHtml(toDisplay(obs.observed_at))}）`);
        lines.push(`观察对象：${watch.length} 个（手动关注 + 显著成交 + 重点持有人）`);
        lines.push('');
        lines.push(`<b>最近 ${hours} 小时的行为事件</b>`);
        if (!events.length) {
            lines.push('已获取数据中未发现达到记录阈值的事件（这是「未观察到」，不等于「没有发生」；覆盖与缺口见下）');
        } else {
            for (const e of events.slice(0, 12)) {
                const mag = JSON.parse(e.magnitude ?? '{}') as Magnitude;
                lines.push(`• ${escapeHtml(eventLabel(e.event_type))}｜${escapeHtml(e.wallet.slice(0, 8))}…｜${escapeHtml(String(mag.before ?? '?'))} → ${escapeHtml(String(mag.after ?? '?'))}${mag.pct ? '（' + escapeHtml(mag.pct) + '）' : ''}｜优先级 ${PRIORITY_LABEL[e.priority]}｜质量 ${qualityLabel(e.data_quality)}`);
            }
        }
        lines.push('');
        lines.push(`<b>覆盖说明</b>`);
        for (const w of watch.slice(0, 10)) lines.push(`· ${escapeHtml(w.address.slice(0, 10))}… ← ${escapeHtml(w.source)}：${escapeHtml(String(w.reason ?? '').slice(0, 60))}`);
        const gaps = this.repos.openGaps(40).filter((g) => String(g.key) === conditionId);
        lines.push(gaps.length
            ? `缺口：${escapeHtml(gaps.map((g) => String(g.reason)).join('，'))}`
            : '没有登记缺口（表示已获取区间内未发现，不表示完整覆盖）');
        return lines.join('\n');
    }

    /** /status */
    statusReport(extra: { cycles?: number; lastCycleAt?: string | null; byType?: Record<string, number> } = {}): string {
        const stats = this.repos.outboxStats();
        const gaps = this.repos.openGaps(100);
        const watch = this.repos.watchlist(true);
        const states = this.repos.db.all<{ key: string; last_ok_at: string | null; consecutive_failures: number; truncated: number; earliest_ts: string | null; reached_start: number }>(
            'SELECT key, last_ok_at, consecutive_failures, truncated, earliest_ts, reached_start FROM collection_state',
        );
        const lines: string[] = [];
        lines.push(`<b>系统状态</b>`);
        lines.push(`关注对象：${watch.length}（手动 ${watch.filter((w) => w.source === 'manual').length}）`);
        lines.push(`采集进度：${states.length} 个游标；其中失败 ${states.filter((s) => s.consecutive_failures > 0).length}，截断 ${states.filter((s) => s.truncated === 1).length}`);
        const latest = states.map((s) => s.last_ok_at).filter(Boolean).sort().pop();
        lines.push(`最近一次成功采集：${escapeHtml(toDisplay(latest ?? null))}`);
        if (extra.lastCycleAt) lines.push(`最近一轮：${escapeHtml(toDisplay(extra.lastCycleAt))}（已跑 ${extra.cycles ?? 0} 轮）`);
        lines.push(`报警队列：${escapeHtml(JSON.stringify(stats))}（限速 ${this.config.push.maxPerMinute}/分钟；限速溢出会合并成摘要，不丢消息）`);
        lines.push(`待投递：${this.pendingCountText()}`);
        lines.push(`未解决缺口：${gaps.length}`);
        for (const g of gaps.slice(0, 8)) lines.push(`· [${escapeHtml(String(g.scope))}] ${escapeHtml(String(g.reason))}：${escapeHtml(String(g.detail ?? '').slice(0, 80))}`);
        if (extra.byType) lines.push(`本轮采集：${escapeHtml(JSON.stringify(extra.byType))}`);
        lines.push(`投递语义：至少一次（发送成功但回写前崩溃会重发一次，不承诺恰好一次）`);
        return lines.join('\n');
    }

    private pendingCountText(): string {
        const r = this.repos.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM alert_outbox WHERE status IN ('pending','retry','sending')`);
        return String(r?.n ?? 0);
    }

    /** 市场观察里的「提前进场」表述必须给出相对时刻（方案 §3.3） */
    static earlyEntryText(activityAt: string, priceChangedAt: string | null): string {
        if (!priceChangedAt) return `该钱包在 ${toDisplay(activityAt)} 有成交（价格变化时刻未知，无法判断先后）`;
        const before = Date.parse(activityAt) < Date.parse(priceChangedAt);
        return before
            ? `该钱包在价格变化（${toDisplay(priceChangedAt)}）之前 ${durationText(activityAt, priceChangedAt)} 成交`
            : `该钱包的成交晚于价格变化（观察时刻 ${toDisplay(priceChangedAt)}），不构成「提前进场」证据`;
    }

    static unixToDisplay(sec: number | null): string { return toDisplay(unixToIso(sec)); }
    /** 比值 → 百分比字符串（来源直接给的 1h/24h 变化是比值，如 -0.1225 → -12.3%） */
    static ratioToPct(v: string | null | undefined): string | null {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        return `${n > 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
    }
    static fmtPct(v: number | null): string { return v === null ? '未知' : `${(v * 100).toFixed(1)}%`; }
    static fmtDec(v: ReturnType<typeof parseDec>): string { return decToString(v) ?? '未知'; }
    /** 供测试：金额不做二进制浮点累加 */
    static sumStrict(values: string[]): string {
        return decToString(sumDec(values.map((v) => parseDec(v)))) ?? '未知';
    }
    static ratioText(from: string | null, to: string | null): string {
        const f = parseDec(from), t = parseDec(to);
        if (f === null || t === null || f === 0n) return '未知';
        return pctString((t - f) * 10n ** 18n / f, 1) ?? '未知';
    }
    static toNum(v: string | null): number | null { return decToNumber(parseDec(v)); }
    static labelUnknown(v: unknown, label = '未知'): string { return v === null || v === undefined || v === '' ? label : String(v); }
    static sinceText(iso: string): string { return `${durationText(iso, nowIso()) ?? '未知'}前`; }
}
