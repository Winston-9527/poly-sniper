/**
 * P1 推送质量（本轮修复：市场维度 / 单钱包聚合 / 摘要内容 / 高优先级预算）。
 * 只测「报告里到底写了什么」与「一条还是多条」，不测网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../dist/db/Database.js';
import { Repos } from '../dist/db/repos.js';
import { AlertOutbox } from '../dist/alerts/Outbox.js';
import { mkApp, mkConfig, seedMarket, seedWallet, seedPosition, seedActivity, W1, CID, TOKEN } from './helpers.mjs';

const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-02T00:00:00.000Z';
const STUB_MARKET = '0x9999999999999999999999999999999999999999999999999999999999999999';
const CID2 = '0xbbbb00000000000000000000000000000000000000000000000000000000000000';
const T2 = '100000000000000000000000000000000000000000000000000000000000000003';
const W2 = '0x2222222222222222222222222222222222222222';
const W3 = '0x3333333333333333333333333333333333333333';

function rowOf(ev) {
    return {
        id: Number(ev.id), wallet: String(ev.wallet), condition_id: ev.condition_id, token_id: ev.token_id,
        event_type: String(ev.event_type), magnitude: ev.magnitude, evidence: String(ev.evidence),
        data_quality: ev.data_quality, priority: ev.priority, priority_reason: String(ev.priority_reason),
        rule_version: String(ev.rule_version), event_at: String(ev.event_at), observed_at: String(ev.observed_at),
    };
}

test('市场维度：报告必须写出 24h 成交量/流动性/现价/市场页链接；缺标题时显式声明缺口', async () => {
    const app = mkApp();
    seedMarket(app.repos, { question: '测试市场？' });
    app.repos.insertMarketObservation({ conditionId: CID, volume24h: '1200000', liquidity: '340000', observedAt: T1 });

    const ev = {
        id: 1, wallet: W1, condition_id: CID, token_id: TOKEN, event_type: 'position_reduced',
        magnitude: JSON.stringify({ before: '100000', after: '30000', delta: '-70000', pct: '-70.00%', notional: '42000', outcome: 'Yes' }),
        evidence: '{}', data_quality: 'verified', priority: 'high', priority_reason: '自身持仓变化 -70.0%',
        rule_version: 'p1-rules-2', event_at: T1, observed_at: T1,
    };
    const rep = app.reports.behaviorReport(ev, { shadow: true });
    assert.match(rep.body, /24h 成交量 \$1\.2M/, '24h 成交量必须出现在报告里');
    assert.match(rep.body, /流动性 \$340k/, '流动性必须出现在报告里');
    assert.match(rep.body, /polymarket\.com\/market\/test-market/, '有 slug 时必须给出市场页链接');
    assert.match(rep.body, /名义金额估算：-\$42,000/, '金额要四舍五入并带方向');

    // 缺市场标题：不能省略，要写成数据缺口
    app.repos.upsertMarket({ conditionId: STUB_MARKET });
    const ev2 = { ...ev, condition_id: STUB_MARKET, token_id: null };
    const rep2 = app.reports.behaviorReport(ev2, { shadow: true });
    assert.match(rep2.body, /市场标题未取到/, '缺标题必须显式声明，而不是静默省略');
    assert.match(rep2.body, /condition 0x9999999999…/, '缺标题时至少要能定位 conditionId');
    assert.ok(!/polymarket\.com/.test(rep2.body.split('<b>证据</b>')[1] ?? ''), '缺 slug 时不伪造市场链接');
    app.close();
});

test('单钱包一轮聚合：多个事件只推一条卡片，事件逐行、背景只出现一次', async () => {
    const app = mkApp();
    seedMarket(app.repos, { question: '市场A？' });
    app.repos.upsertMarket({ conditionId: CID2, slug: 'market-b', eventSlug: 'event-b', question: '市场B？' });
    app.repos.upsertOutcomeToken({ tokenId: T2, conditionId: CID2, outcome: 'Yes', outcomeIndex: 0 });
    app.repos.insertMarketObservation({ conditionId: CID, volume24h: '1200000', liquidity: '340000', observedAt: T1 });
    seedWallet(app.repos, W1, '2026-09-01T00:00:00.000Z');   // 观察起点必须早于被验证的活动

    // 同一钱包、同一轮、两个市场：$30,000 开仓（高）+ $20,000 开仓（中）
    seedActivity(app.repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, side: 'BUY', size: '60000', price: '0.5', usdcSize: '30000', eventAt: T0 });
    seedActivity(app.repos, { wallet: W1, tokenId: T2, conditionId: CID2, side: 'BUY', size: '40000', price: '0.5', usdcSize: '20000', eventAt: '2026-10-01T01:00:00.000Z' });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });

    const events = app.repos.eventsForWallet(W1, 10);
    assert.equal(events.length, 2, '两个市场的变化各自记录一条事件');
    assert.ok(events.every((e) => e.priority !== 'low'), '两条都达到推送阈值');

    const rows = app.repos.db.all("SELECT id, payload FROM alert_outbox WHERE dedupe_key LIKE 'alert:cycle|%'");
    assert.equal(rows.length, 1, '同一钱包一轮只入队一条卡片（不再按事件刷屏）');
    const payload = JSON.parse(rows[0].payload);
    assert.match(payload.title, /钱包动态 · 2 个事件/);
    assert.equal(payload.digestLines.length, 2, '摘要用的逐事件行必须齐备');
    assert.equal(payload.body.split('<b>背景</b>').length - 1, 1, '背景只出现一次');
    assert.match(payload.body, /① /);
    assert.match(payload.body, /② /);
    assert.match(payload.body, /市场A？/);
    assert.match(payload.body, /市场B？/);
    assert.match(payload.body, /\+\$30,000/, '高优先级事件的金额要出现');
    assert.match(payload.body, /24h 成交量 \$1\.2M/, '卡片里每条事件都要带市场背景');
    assert.match(payload.digestLines[0], /市场A？｜0x1111…1111｜\+\$30,000/);
    assert.match(payload.digestLines[0], /｜高$/);
    app.close();
});

test('合并摘要：按市场归并并写出钱包/金额/变化%，而不是只列标题', async () => {
    const cfg = mkConfig({ push: { maxPerMinute: 1, maxPerDay: 1, maxHighPerDay: 0, maxAttempts: 3, retryBackoffSeconds: [0] } });
    const db = openDb(':memory:');
    const repos = new Repos(db);
    const sent = [];
    const outbox = new AlertOutbox(repos, cfg, async (_c, body) => { sent.push(body); return { ok: true, messageId: `m${sent.length}` }; });
    outbox.enqueue('alert:a1', { chatId: '999', title: 't1', body: 'b1', priority: 'medium', digestLines: ['市场A？｜0x1111…1111｜+$12,000（+150.00%）｜高'] });
    outbox.enqueue('alert:a2', { chatId: '999', title: 't2', body: 'b2', priority: 'medium', digestLines: ['市场A？｜0x2222…2222｜-$3,000（-40.00%）｜中'] });
    outbox.enqueue('alert:a3', { chatId: '999', title: 't3', body: 'b3', priority: 'medium', digestLines: ['市场B？｜0x3333…3333｜+$5,000（+20.00%）｜中'] });

    const t0 = new Date();
    const r1 = await outbox.flush(t0);
    assert.equal(r1.sent, 1, '每分钟/每天各 1 条');
    assert.equal(r1.merged, 2, '其余并入摘要，不丢');

    const r2 = await outbox.flush(new Date(t0.getTime() + 26 * 3600_000));
    assert.equal(r2.sent, 1, '次日只发一条汇总');
    const digest = sent[sent.length - 1];
    assert.match(digest, /被合并的告警（2 条）/);
    assert.match(digest, /▸ 市场A？/);
    assert.match(digest, /0x2222…2222｜-\$3,000（-40\.00%）｜中/, '摘要必须有金额与变化%，不能只列标题');
    assert.match(digest, /▸ 市场B？/);
    db.close();
});

test('高优先级有独立预算：不被普通日上限挤掉，但有硬顶', async () => {
    const cfg = mkConfig({ push: { maxPerMinute: 100, maxPerDay: 1, maxHighPerDay: 2, maxAttempts: 3, retryBackoffSeconds: [0] } });
    const db = openDb(':memory:');
    const repos = new Repos(db);
    const sent = [];
    const outbox = new AlertOutbox(repos, cfg, async (_c, body) => { sent.push(body); return { ok: true, messageId: `m${sent.length}` }; });
    outbox.enqueue('alert:m1', { chatId: '999', title: '中优先', body: 'm', priority: 'medium', digestLines: ['市场A？｜0x1111…1111｜+$1,000（+20.00%）｜中'] });
    outbox.enqueue('alert:h1', { chatId: '999', title: '高优先1', body: 'h1', priority: 'high', digestLines: ['市场B？｜0x2222…2222｜+$30,000（+150.00%）｜高'] });
    outbox.enqueue('alert:h2', { chatId: '999', title: '高优先2', body: 'h2', priority: 'high', digestLines: ['市场C？｜0x3333…3333｜+$40,000（+200.00%）｜高'] });
    outbox.enqueue('alert:h3', { chatId: '999', title: '高优先3', body: 'h3', priority: 'high', digestLines: ['市场D？｜0x4444…4444｜+$50,000（+250.00%）｜高'] });

    const t0 = new Date();
    const r1 = await outbox.flush(t0);
    assert.equal(r1.sent, 3, '中 1 条走日预算，高 2 条走高优先级预算');
    assert.equal(r1.merged, 1, '第三条高优先级超过硬顶后并入摘要');
    const stats = repos.outboxStats();
    assert.equal(stats.sent, 3);
    assert.equal(stats.merged, 1);
    db.close();
});
