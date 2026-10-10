/**
 * 可靠性：限速、重启恢复、备份/恢复、预算耗尽（方案 §7.3、§8、§12 场景 10/14/15）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../dist/db/Database.js';
import { Repos } from '../dist/db/repos.js';
import { AlertOutbox } from '../dist/alerts/Outbox.js';
import { Collector } from '../dist/ledger/Collector.js';
import { RequestBudget, HttpClient } from '../dist/sources/http.js';
import { validateActivity } from '../dist/sources/contracts.js';
import { mkConfig, mkApp, tempDbPath, seedMarket, seedPosition, seedActivity, seedWallet, W1, CID, TOKEN } from './helpers.mjs';

test('场景14：达到限速后不丢消息 —— 溢出合并成摘要，重启后队列与进度恢复', async () => {
    const cfg = mkConfig({ push: { maxPerMinute: 2, maxAttempts: 5, retryBackoffSeconds: [1, 2] } });
    const dbPath = tempDbPath();
    let db = openDb(dbPath);
    let repos = new Repos(db);
    const sent = [];
    const outbox = new AlertOutbox(repos, cfg, async (_c, body) => { sent.push(body); return { ok: true, messageId: `m${sent.length}` }; });
    for (let i = 0; i < 7; i++) outbox.enqueue(`alert:k${i}`, { chatId: '999', title: `告警${i}`, body: `body${i}` });

    const t0 = new Date();
    const r1 = await outbox.flush(t0);
    assert.equal(r1.sent, 2, '每分钟最多 2 条');
    assert.equal(r1.merged, 5, '超过限速的 5 条合并进摘要，不能丢');
    const stats = repos.outboxStats();
    assert.equal(stats.sent, 2);
    assert.equal(stats.merged, 5);
    assert.equal(stats.pending, 1, '摘要本身仍待投递');

    // 「重启」：重新打开同一个库文件，队列状态必须还在
    db.close();
    db = openDb(dbPath);
    repos = new Repos(db);
    const outbox2 = new AlertOutbox(repos, cfg, async (_c, body) => { sent.push(body); return { ok: true, messageId: `m${sent.length}` }; });
    assert.equal(repos.outboxStats().sent, 2, '重启后统计不丢');
    assert.equal(outbox2.pendingCount(), 1);
    const r2 = await outbox2.flush(new Date(t0.getTime() + 90_000)); // 下一分钟
    assert.equal(r2.sent, 1);
    assert.match(sent[sent.length - 1], /告警/, '摘要里必须能看到被合并的告警');
    assert.match(sent[sent.length - 1], /合并/);

    // 卡在 sending 的条目在重启后回到 retry（可能重复投递一次，已显式记录）
    repos.enqueueAlert('alert:stuck', JSON.stringify({ chatId: '999', title: '卡住的', body: 'x' }));
    const stuckId = repos.db.get("SELECT id FROM alert_outbox WHERE dedupe_key='alert:stuck'").id;
    repos.claimAlert(stuckId, new Date(t0.getTime() - 3600_000).toISOString());
    const recovered = outbox2.recover(new Date(t0.getTime() + 300_000).toISOString());
    assert.equal(recovered, 1);
    const row = repos.db.get('SELECT * FROM alert_outbox WHERE id=?', stuckId);
    assert.equal(row.status, 'retry');
    assert.match(String(row.last_error), /重复投递/);
    db.close();
});

test('日上限是硬闸：超过后不再即时推送，并入当日摘要，次日只汇总一条', async () => {
    const cfg = mkConfig({ push: { maxPerMinute: 100, maxPerDay: 5, maxAttempts: 3, retryBackoffSeconds: [0] } });
    const db = openDb(':memory:');
    const repos = new Repos(db);
    const sent = [];
    const outbox = new AlertOutbox(repos, cfg, async (_c, body) => { sent.push(body); return { ok: true, messageId: `m${sent.length}` }; });
    for (let i = 0; i < 12; i++) outbox.enqueue(`alert:d${i}`, { chatId: '999', title: `日上限告警${i}`, body: `b${i}` });

    const t0 = new Date();
    const r1 = await outbox.flush(t0);
    assert.equal(r1.sent, 5, '日上限 5 条，只能即时发 5 条');
    assert.equal(r1.merged, 7);
    const stats = repos.outboxStats();
    assert.equal(stats.sent, 5);
    assert.equal(stats.merged, 7);
    assert.equal(repos.db.get('SELECT COUNT(*) AS n FROM alert_outbox WHERE dedupe_key=?', `digest-day:${t0.toISOString().slice(0, 10)}`).n, 1, '当日摘要只建一条');

    // 同一天再 flush：一条都不发（日预算已用尽），全部并入摘要
    const r2 = await outbox.flush(new Date(t0.getTime() + 3600_000));
    assert.equal(r2.sent, 0);
    outbox.enqueue('alert:later', { chatId: '999', title: '晚一点的高优先级告警', body: 'x' });
    const r3 = await outbox.flush(new Date(t0.getTime() + 3700_000));
    assert.equal(r3.sent, 0, '当天不会再即时推送');

    // 次日：只发一条汇总，且正文里能看到被合并的告警标题
    const nextDay = new Date(t0.getTime() + 26 * 3600_000);
    const r4 = await outbox.flush(nextDay);
    assert.equal(r4.sent, 1, '次日只发一条汇总');
    const digestMsg = sent[sent.length - 1];
    assert.match(digestMsg, /被合并的告警（8 条）/);
    assert.match(digestMsg, /日上限告警5/);
    assert.match(digestMsg, /晚一点的高优先级告警/);
    db.close();
});

test('失败重试 → 超过最大次数转 dead 并保留原因（不静默丢弃）', async () => {
    const cfg = mkConfig({ push: { maxPerMinute: 10, maxPerDay: 8, maxAttempts: 2, retryBackoffSeconds: [0] } });
    const db = openDb(':memory:');
    const repos = new Repos(db);
    const outbox = new AlertOutbox(repos, cfg, async () => ({ ok: false, error: '429 Too Many Requests' }));
    outbox.enqueue('alert:x', { chatId: '999', title: 't', body: 'b' });
    const t0 = new Date();
    const r1 = await outbox.flush(t0);
    assert.equal(r1.retried, 1);
    const r2 = await outbox.flush(new Date(t0.getTime() + 5000));
    assert.equal(r2.dead, 1);
    const row = repos.db.get("SELECT * FROM alert_outbox WHERE dedupe_key='alert:x'");
    assert.equal(row.status, 'dead');
    assert.match(String(row.last_error), /429/);
    db.close();
});

test('场景15：备份后恢复 —— 快照、来源进度、事件证据与待发送状态都在', () => {
    const dbPath = tempDbPath();
    const db = openDb(dbPath);
    const repos = new Repos(db);
    seedMarket(repos);
    seedWallet(repos, W1);
    seedPosition(repos, { wallet: W1, size: '123', price: '0.5', snapshotAt: '2026-10-01T00:00:00.000Z' });
    seedActivity(repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, side: 'BUY', size: '123', price: '0.5', usdcSize: '61.5', eventAt: '2026-10-01T01:00:00.000Z' });
    repos.upsertState(`activity:${W1}`, { watermarkTs: '2026-10-01T01:00:00.000Z', earliestTs: '2026-09-01T00:00:00.000Z', reachedStart: false, truncated: true, lastOkAt: '2026-10-01T01:00:00.000Z' });
    repos.insertBehaviorEvent({
        dedupeKey: 'e1', wallet: W1, conditionId: CID, tokenId: TOKEN, eventType: 'position_opened',
        magnitude: '{"delta":"123"}', evidence: '{"ledgerEntryIds":[1]}', dataQuality: 'verified',
        priority: 'high', priorityReason: 'r', ruleVersion: 'p1-rules-1', eventAt: '2026-10-01T01:00:00.000Z', observedAt: '2026-10-01T01:00:00.000Z',
    });
    repos.enqueueAlert('alert:e1', JSON.stringify({ chatId: '999', title: 't', body: 'b' }));

    const dir = mkdtempSync(join(tmpdir(), 'polysniper-backup-'));
    const file = db.backupTo(dir, 'test');
    assert.ok(existsSync(file));
    db.close();

    const restored = openDb(file);
    const r = new Repos(restored);
    assert.match(restored.integrityCheck(), /ok/);
    assert.equal(r.db.get('SELECT COUNT(*) AS n FROM position_snapshots').n, 1);
    assert.equal(r.db.get('SELECT COUNT(*) AS n FROM wallet_activities').n, 1);
    assert.equal(r.db.get('SELECT COUNT(*) AS n FROM behavior_events').n, 1);
    assert.equal(r.outboxStats().pending, 1);
    const st = r.getState(`activity:${W1}`);
    assert.equal(st.watermark_ts, '2026-10-01T01:00:00.000Z');
    assert.equal(Number(st.truncated), 1, '截断状态必须随备份恢复');
    restored.close();
});

test('场景10：页数用尽/预算耗尽 → 记录实际覆盖与缺口，不宣称完整覆盖', async () => {
    // 预算耗尽：HttpClient 在发请求前就返回 kind=budget（真实代码路径，无网络）
    const http = new HttpClient({ retries: 0, budget: new RequestBudget(0) });
    const blocked = await http.getJson('http://127.0.0.1:1/never', 'test');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.kind, 'budget');

    // 采集器收到 budget 失败：显式缺口，且不产生任何行为事件
    const app = mkApp({ dataApiSpec: { failActivity: { kind: 'budget', error: '本轮请求预算用尽（0）' } } });
    seedMarket(app.repos);
    seedWallet(app.repos, W1);
    const res = await app.pipeline.processWallet(W1, CID, {});
    assert.equal(res.collected.stopped, 'budget');
    assert.equal(res.eventsCreated, 0);
    const gaps = app.repos.openGaps(20).map((g) => String(g.reason));
    assert.ok(gaps.includes('budget_exhausted'), '预算耗尽必须是显式缺口');
    assert.match(app.reports.statusReport({}), /budget_exhausted/);
    const state = app.repos.getState(`activity:${W1}`);
    assert.ok(Number(state.consecutive_failures) >= 1);
    app.close();

    // 页数上限：max_pages 停止原因 + 截断标记
    const cfg = mkConfig({ budgets: { activityPagesPerPull: 1 } });
    const db = openDb(':memory:');
    const repos = new Repos(db);
    const full = Array.from({ length: 500 }, (_, i) => ({
        proxyWallet: W1, type: 'TRADE', timestamp: 1700000000 + i, asset: TOKEN, conditionId: CID,
        size: 1, price: 0.5, usdcSize: 0.5, side: 'BUY', transactionHash: `0x${i}`, outcome: 'Yes', outcomeIndex: 0,
    }));
    const dataApi = {
        async getActivity(_w, opts) { return { ok: true, data: opts.direction === 'ASC' ? full : full, status: 200, ms: 1, url: 'x' }; },
        async getPositions() { return { ok: true, data: [], status: 200, ms: 1, url: 'x' }; },
        async getValue() { return { ok: true, data: [], status: 200, ms: 1, url: 'x' }; },
    };
    const collector = new Collector({ repos, dataApi, chain: {}, config: cfg, budget: new RequestBudget(100), log: () => { } });
    const out = await collector.collectActivity(W1, { cold: true });
    assert.equal(out.stoppedBecause, 'max_pages');
    const st = repos.getState(`activity:${W1}`);
    assert.equal(Number(st.truncated), 1, '首页满 500 条必须标记历史未到起点');
    assert.match(String(st.truncation_reason), /起点未取到/);
    assert.ok(repos.openGaps(20).some((g) => String(g.reason) === 'truncated'));
    assert.ok(out.warnings.some((w) => /截断/.test(w)));
    db.close();
});

test('采集器幂等：同一页重复拉取不重复入库，水位与原始记录在同一事务', async () => {
    const cfg = mkConfig();
    const db = openDb(':memory:');
    const repos = new Repos(db);
    const rows = [
        { proxyWallet: W1, type: 'TRADE', timestamp: 1700000100, asset: TOKEN, conditionId: CID, size: 5, price: 0.5, usdcSize: 2.5, side: 'BUY', transactionHash: '0xa', outcome: 'Yes', outcomeIndex: 0 },
        { proxyWallet: W1, type: 'TRADE', timestamp: 1700000200, asset: TOKEN, conditionId: CID, size: 7, price: 0.5, usdcSize: 3.5, side: 'BUY', transactionHash: '0xb', outcome: 'Yes', outcomeIndex: 0 },
    ];
    const dataApi = {
        async getActivity(_w, opts) { return { ok: true, data: validateActivity(opts.direction === 'ASC' ? rows : [...rows].reverse()), status: 200, ms: 1, url: 'x' }; },
        async getPositions() { return { ok: true, data: [], status: 200, ms: 1, url: 'x' }; },
        async getValue() { return { ok: true, data: [], status: 200, ms: 1, url: 'x' }; },
    };
    const collector = new Collector({ repos, dataApi, chain: {}, config: cfg, budget: new RequestBudget(100), log: () => { } });
    const a = await collector.collectActivity(W1, { cold: true });
    assert.equal(a.inserted, 2);
    const b = await collector.collectActivity(W1, { cold: false });
    assert.equal(b.inserted, 0, '重复拉取必须零新增');
    assert.equal(repos.activityCount(W1), 2);
    const srAfterFirst = repos.db.get('SELECT COUNT(*) AS n FROM source_records').n;
    assert.equal(srAfterFirst, 2, '同一页只写一条原始记录（DESC 首页 + ASC 首页）');
    const c = await collector.collectActivity(W1, { cold: false });
    assert.equal(c.inserted, 0);
    assert.equal(repos.db.get('SELECT COUNT(*) AS n FROM source_records').n, srAfterFirst, '重复拉取不再新增原始记录');
    assert.equal(repos.getState(`activity:${W1}`).watermark_ts, new Date(1700000200 * 1000).toISOString());
    db.close();
});
