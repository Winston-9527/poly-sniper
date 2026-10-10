/**
 * 市场异动扫描工具（首要信号）：扫一轮活跃市场 → 与上一条观察比较 → 记录并打印异动。
 * 连跑两次（间隔 >1 分钟）就能看到真实的窗口异动。
 *
 *   node dist/tools/market-scan.js                # 扫描 + 判定 + 记录 + 打印（影子，不推 Telegram）
 *   node dist/tools/market-scan.js --pages 5       # 扫更多页（每页 500 个市场）
 *   node dist/tools/market-scan.js --top 8         # 最多打印几条
 *   node dist/tools/market-scan.js --enqueue       # 真的入队（仍受限速/日上限约束）
 *   node dist/tools/market-scan.js --no-network    # 只看已有观察能判定出什么
 */
import { createApp } from '../app.js';
import { detectAnomaly, anomalyRulesFromConfig } from '../market/MarketScanner.js';
import { nowIso, toDisplay } from '../util/time.js';
import { parseDec, Dec } from '../util/decimal.js';
import type { MarketAnomalyRow } from '../report/Reports.js';

function arg(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; }
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }

async function main() {
    const pages = Number(arg('pages') ?? 3);
    const top = Number(arg('top') ?? 6);
    const offline = flag('no-network');
    const enqueue = flag('enqueue');
    const app = createApp({ config: { shadowMode: !enqueue } });
    const rules = anomalyRulesFromConfig(app.config);

    console.log(`=== 市场异动扫描（${offline ? '离线' : '在线'}，页数 ${pages}）===`);
    let snapshots;
    if (offline) {
        snapshots = app.repos.db.all<Record<string, unknown>>(
            `SELECT * FROM market_observations WHERE observed_at = (SELECT MAX(observed_at) FROM market_observations) LIMIT 2000`,
        ).map((r) => ({
            conditionId: String(r.condition_id), tokenId: r.token_id === null ? null : String(r.token_id),
            outcome: r.outcome === null ? null : String(r.outcome), price: numOrNull(r.price),
            bestBid: numOrNull(r.best_bid), bestAsk: numOrNull(r.best_ask), spread: numOrNull(r.spread),
            lastTradePrice: numOrNull(r.last_trade_price), change1h: numOrNull(r.change_1h), change24h: numOrNull(r.change_24h),
            volume24h: numOrNull(r.volume_24h), liquidity: numOrNull(r.liquidity), observedAt: String(r.observed_at),
        }));
        console.log(`离线：使用最近一次观察的 ${snapshots.length} 个 token`);
    } else {
        const scan = await app.scanner.scan({ pages });
        snapshots = scan.snapshots;
        console.log(`扫描：${scan.markets} 个市场 / ${scan.observed} 个 token（停止原因 ${scan.stoppedBecause}）；请求预算剩余 ${app.budget.remaining}`);
        for (const w of scan.warnings) console.log(`警告：${w}`);
    }

    const hits: { row: MarketAnomalyRow; snap: unknown }[] = [];
    let considered = 0, insufficient = 0;
    for (const cur of snapshots) {
        if (!cur.tokenId || cur.price === null) continue;
        considered++;
        const prev = app.scanner.previousSnapshot(cur.tokenId, cur.observedAt);
        const r = detectAnomaly(prev, cur, rules);
        if (r.insufficient) { insufficient++; continue; }
        for (const cand of r.candidates) {
            const rec = app.scanner.recordAnomaly(cand, cur);
            const row = app.repos.db.get<MarketAnomalyRow>('SELECT * FROM market_anomalies WHERE id=?', rec.id);
            if (row) hits.push({ row, snap: cur });
        }
    }
    console.log(`\n可比对 token：${considered}（其中 ${insufficient} 个缺上一次观察/价格，无法判定）`);
    console.log(`异动命中：${hits.length} 条\n`);
    for (const h of hits.sort((a, b) => (a.row.priority === 'high' ? -1 : 1)).slice(0, top)) {
        const movers = app.scanner.recentMovers(h.row.condition_id, 3);
        const rep = app.reports.marketAnomalyReport(h.row, { movers, shadow: !enqueue });
        console.log(`--- ${rep.title} ---`);
        console.log(rep.body.replace(/<\/?[^>]+>/g, ''));
        if (enqueue) {
            const enq = app.outbox.enqueue(`alert:${h.row.condition_id}:${h.row.token_id}:${h.row.kind}:${h.row.event_at}`, {
                chatId: app.config.telegram.chatIds[0] ?? '', title: rep.title, body: rep.body,
                wallet: '', conditionId: h.row.condition_id, priority: h.row.priority, dataQuality: h.row.data_quality,
            });
            console.log(`（已入队：${enq.inserted}）`);
        }
        console.log('');
    }
    const flush = enqueue ? await app.outbox.flush() : null;
    console.log(`数据库里累计异动：${app.repos.anomalyCount()} 条｜队列：${JSON.stringify(app.outbox.stats())}${flush ? `｜本轮投递 ${JSON.stringify(flush)}` : ''}`);
    console.log(`时间：${toDisplay(nowIso())}`);
    app.close();
}

function numOrNull(v: unknown): Dec | null {
    return parseDec(v === null || v === undefined ? null : String(v));
}
main().catch((e) => { console.error(e); process.exit(1); });
