/**
 * 影子运行（方案 §13）：用真实来源跑一轮 P1 链路，但对 Telegram 只记录不发送，也不动生产进程。
 * 用法：
 *   node dist/tools/shadow-run.js                          # 自动取热门市场
 *   node dist/tools/shadow-run.js --market <slug|conditionId>
 *   node dist/tools/shadow-run.js --wallet 0x…             # 只处理一个钱包
 *   node dist/tools/shadow-run.js --no-network             # 离线重算（不发请求）
 * 输出：终端摘要 + data/shadow-<时间>.json 明细
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../app.js';
import type { ProcessResult } from '../ledger/Pipeline.js';
import { normalizeAddress } from '../sources/contracts.js';
import { nowIso, toDisplay } from '../util/time.js';

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
    const offline = process.argv.includes('--no-network');
    const walletArg = arg('wallet');
    const marketArg = arg('market');
    const objectLimit = Number(arg('limit') ?? 8);

    const app = createApp({ config: { shadowMode: true } });
    app.log(`影子运行开始（shadowMode=${app.config.shadowMode}，offline=${offline}）`);
    app.log(`数据库：${app.config.dbPath}`);
    app.log(`代理：${app.config.proxyUrl ?? '未设置'}`);

    const started = nowIso();
    const detail: Record<string, unknown> = { started, offline, market: marketArg ?? null, wallet: walletArg ?? null, objects: [], reports: [], gaps: [], outbox: null };

    if (walletArg) {
        const addr = normalizeAddress(walletArg);
        if (!addr) throw new Error(`地址非法：${walletArg}`);
        app.repos.ensureWallet(addr);
        app.repos.watch(addr, { source: 'manual', tier: 1, reason: '影子运行指定地址', nextCollectAt: nowIso() });
        const res = await app.pipeline.processWallet(addr, '', { skipNetwork: offline, cold: true });
        (detail.objects as unknown[]).push(res);
        printWalletResult(app, res);
    } else {
        const markets = marketArg ? [await resolveMarket(app, marketArg)] : undefined;
        const rep = await app.pipeline.runCycle({ markets, flush: true, discovery: true });
        detail.cycle = rep;
        console.log(`\n=== 一轮结果 ===`);
        console.log(`市场：${rep.markets.join(', ') || '（无）'}`);
        for (const d of rep.discovered) {
            console.log(`发现：${d.market.slice(0, 14)}… 新增关注 ${d.added}（${JSON.stringify(d.byEntry)}），因预算跳过 ${d.skippedOverBudget}`);
        }
        console.log(`处理对象：${rep.processed}；新增行为事件：${rep.events}；入队：${rep.queued}；记录未推送：${rep.suppressed}`);
        if (rep.flush) console.log(`投递：${JSON.stringify(rep.flush)}`);
        for (const w of rep.warnings.slice(0, 10)) console.log(`警告：${w}`);

        // 逐个关注对象打印细节
        for (const row of app.repos.watchlist(true).slice(0, objectLimit)) {
            const addr = String(row.address);
            const res = await app.pipeline.processWallet(addr, String(row.market_condition_id ?? ''), { skipNetwork: true });
            (detail.objects as unknown[]).push(res);
            printWalletResult(app, res, true);
        }
    }

    // 账本 vs 来源快照的核对汇总（切换生产前最关键的证据）
    console.log(`\n=== 账本 vs 来源快照核对 ===`);
    const verify = verifyLedger(app);
    for (const line of verify.lines) console.log(line);
    detail.verify = verify.data;

    // 报告预览（不发送）
    const events = app.repos.recentEvents(10);
    console.log(`\n=== 最近行为事件（${events.length}） ===`);
    for (const e of events) {
        const rep = app.reports.behaviorReport({
            id: Number(e.id), wallet: String(e.wallet), condition_id: (e.condition_id as string | null), token_id: (e.token_id as string | null),
            event_type: String(e.event_type), magnitude: (e.magnitude as string | null), evidence: String(e.evidence),
            data_quality: e.data_quality as never, priority: e.priority as never, priority_reason: String(e.priority_reason),
            rule_version: String(e.rule_version), event_at: String(e.event_at), observed_at: String(e.observed_at),
        }, { shadow: true });
        console.log(`\n--- ${rep.title} ---\n${rep.body.replace(/<\/?[^>]+>/g, '')}`);
        (detail.reports as unknown[]).push({ title: rep.title, body: rep.body });
    }

    console.log(`\n=== 状态 ===\n${app.reports.statusReport({ cycles: app.pipeline.stats().cycles, lastCycleAt: app.pipeline.stats().lastCycleAt }).replace(/<\/?[^>]+>/g, '')}`);
    detail.outbox = app.outbox.stats();
    detail.gaps = app.repos.openGaps(50);
    detail.finishedAt = nowIso();

    mkdirSync(resolve('data'), { recursive: true });
    const file = resolve('data', `shadow-${started.replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(detail, null, 2));
    console.log(`\n明细已写入：${file}`);
    console.log(`开始 ${toDisplay(started)} → 结束 ${toDisplay(detail.finishedAt as string)}`);
    app.close();
}

async function resolveMarket(app: ReturnType<typeof createApp>, input: string): Promise<string> {
    if (/^0x[0-9a-fA-F]{64}$/.test(input)) return input.toLowerCase();
    const slug = /polymarket\.com\/(?:event|market)\/([\w-]+)/.exec(input)?.[1] ?? input;
    const r = await app.dataApi.getMarketBySlug(slug);
    if (!r.ok || !r.data) throw new Error(`无法解析市场 ${input}（${r.ok ? '没有结果' : r.error}）`);
    app.repos.upsertMarket({ conditionId: r.data.conditionId, slug: r.data.slug, question: r.data.question, negRisk: r.data.negRisk, closed: r.data.closed, endDate: r.data.endDate });
    for (const t of r.data.tokens) app.repos.upsertOutcomeToken({ tokenId: t.tokenId, conditionId: r.data.conditionId, outcome: t.outcome, outcomeIndex: t.outcomeIndex });
    return r.data.conditionId;
}

/**
 * 账本核对汇总：对每个「有快照 + 有持仓过程」的 token，比较账本推导份数与来源快照份数。
 * 只统计「快照之后没有新活动」的 token（否则差异是正常的时序，不是错误）。
 * 这是切换生产前最关键的证据：账本算术必须与来源一致。
 */
function verifyLedger(app: ReturnType<typeof createApp>): { lines: string[]; data: Record<string, unknown> } {
    const lines: string[] = [];
    const typeCounts: Record<string, number> = {};
    const activityRows = app.repos.db.all<{ type: string; n: number }>(
        'SELECT type, COUNT(*) AS n FROM wallet_activities GROUP BY type ORDER BY n DESC',
    );
    for (const r of activityRows) typeCounts[r.type] = r.n;

    const wallets = app.repos.db.all<{ address: string }>('SELECT DISTINCT address FROM watchlist WHERE withdrawn_at IS NULL');
    let tokens = 0, matched = 0, mismatch = 0, pending = 0, noEpisode = 0, failedSnapshot = 0;
    const mismatches: string[] = [];
    for (const { address, } of wallets) {
        if (app.repos.db.get('SELECT id FROM position_snapshots WHERE wallet=? AND completeness=? LIMIT 1', address, 'failed')) failedSnapshot++;
        for (const s of app.repos.latestPositionSnapshots(address)) {
            const tokenId = String(s.token_id);
            if (tokenId === '*') continue;
            const ep = app.repos.db.get<{ id: number; last_size: string; opened_at: string }>(
                'SELECT id, last_size, opened_at FROM position_episodes WHERE wallet=? AND token_id=? ORDER BY opened_at DESC LIMIT 1',
                address, tokenId,
            );
            if (!ep) { noEpisode++; continue; }
            // 快照之后又有活动 → 差异属于时序，不算错误
            const newer = app.repos.db.get<{ n: number }>(
                'SELECT COUNT(*) AS n FROM wallet_activities WHERE wallet=? AND token_id=? AND event_at > ?',
                address, tokenId, String(s.snapshot_at),
            );
            if (Number(newer?.n ?? 0) > 0) { pending++; continue; }
            tokens++;
            const derived = String(ep.last_size);
            const snap = s.size === null ? null : String(s.size);
            if (snap === null) { pending++; continue; }
            if (derived === snap) matched++;
            else {
                mismatch++;
                mismatches.push(`${address.slice(0, 10)}… ${tokenId.slice(0, 8)}… 推导 ${derived} vs 快照 ${snap}（${String(s.snapshot_at)}）`);
            }
        }
    }
    const rate = tokens ? ((matched / tokens) * 100).toFixed(1) + '%' : 'n/a';
    lines.push(`有快照的关注钱包：${wallets.length}；可比对的 token：${tokens}（另有 ${pending} 个因快照后有新活动跳过、${noEpisode} 个无持仓过程）`);
    lines.push(`账本推导 = 来源快照：${matched}/${tokens}（${rate}）；不一致 ${mismatch}；快照失败 ${failedSnapshot}`);
    for (const m of mismatches.slice(0, 8)) lines.push(`  ✗ ${m}`);
    if (!mismatch) lines.push('  （没有未解释差异：账本算术与来源快照一致）');
    lines.push(`已采集活动类型分布：${Object.entries(typeCounts).map(([k, v]) => `${k}×${v}`).join('，') || '无'}`);
    return { lines, data: { wallets: wallets.length, tokens, matched, mismatch, pending, noEpisode, failedSnapshot, mismatches, typeCounts } };
}

function printWalletResult(app: ReturnType<typeof createApp>, res: ProcessResult, brief = false): void {
    console.log(`\n· ${res.wallet}`);
    console.log(`  采集：新增活动 ${res.collected.activityInserted}，页数 ${res.collected.pages}，停止原因 ${res.collected.stopped}${res.collected.error ? `，错误 ${res.collected.error}` : ''}`);
    console.log(`  账本：入账 ${res.ledger.applied}，判为观察起点之前的历史 ${res.ledger.skippedHistory}`);
    console.log(`  事件：新增 ${res.eventsCreated}，缺口 ${res.gaps}`);
    if (res.ledger.issues.length && !brief) {
        for (const i of res.ledger.issues.slice(0, 6)) console.log(`  ⚠ ${i.reason}: ${i.detail.slice(0, 160)}`);
    }
    if (!brief) {
        const entries = app.repos.ledgerForWallet(res.wallet);
        console.log(`  账本条目 ${entries.length}：`);
        for (const e of entries.slice(-6)) {
            console.log(`    ${toDisplay(String(e.event_at))} ${String(e.kind)} Δ${String(e.delta_size)} 现金Δ${String(e.cash_delta ?? '未知')} [${String(e.source_type)}]`);
        }
        const snaps = app.repos.latestPositionSnapshots(res.wallet);
        console.log(`  当前快照 ${snaps.length} 个 token：`);
        for (const s of snaps.slice(0, 6)) {
            console.log(`    ${String(s.outcome ?? '?')} ${String(s.size ?? '未知')} 份 @ ${String(s.price ?? '未知')}（${String(s.completeness)}）`);
        }
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
