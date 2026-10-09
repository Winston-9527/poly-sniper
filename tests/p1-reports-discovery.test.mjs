/**
 * 报告与候选发现（方案 §5.1、§7.3、§9、§12 场景 13）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkApp, seedMarket, seedWallet, seedPosition, seedActivity, tempDbPath, W1, W2, W3, CID, TOKEN, T_NO } from './helpers.mjs';
import { createApp } from '../dist/app.js';
import { escapeHtml, Reports } from '../dist/report/Reports.js';
import { partitionByGroup, sameBatchEvidence, isPublicFunding } from '../dist/ledger/GroupAggregation.js';
import { assignSyntheticKeys } from '../dist/sources/contracts.js';

const T0 = '2026-10-01T00:00:00.000Z';
const T1 = '2026-10-02T00:00:00.000Z';

const nowSec = () => Math.floor(Date.now() / 1000);

function trade(wallet, side, size, price, tsOffsetSec, extra = {}) {
    const timestamp = nowSec() - tsOffsetSec;
    return { proxyWallet: wallet, side, asset: TOKEN, conditionId: CID, size, price, timestamp, transactionHash: extra.tx ?? `0x${wallet.slice(2, 6)}${side}${timestamp}`, outcome: 'Yes', outcomeIndex: 0, title: '测试市场？', slug: 'test-market', eventSlug: 'test-event' };
}

test('候选发现：买卖双边都纳入，不只选顺着价格的人；大户入口独立保留', async () => {
    const trades = [
        trade(W1, 'BUY', 1000, 0.5, 600),      // $500
        trade(W2, 'SELL', 5000, 0.5, 500),     // $2,500 —— 只有卖出，也必须被发现
        trade(W3, 'BUY', 10, 0.5, 400),        // $5 —— 金额太小，不入选
    ];
    const holders = [{ token: TOKEN, holders: [
        { proxyWallet: W2, amount: 90000, outcomeIndex: 0, asset: TOKEN },
        { proxyWallet: '0x4444444444444444444444444444444444444444', amount: 50000, outcomeIndex: 0, asset: TOKEN },
        { proxyWallet: '0x5555555555555555555555555555555555555555', amount: 10, outcomeIndex: 0, asset: TOKEN },
    ] }];
    const app = mkApp({ config: { rules: { significantTradeNotional: 400, significantTradeSum: 1000 } }, dataApiSpec: { trades, holders } });
    seedMarket(app.repos);
    const res = await app.collector.discoverFromMarket(CID);
    const watched = app.repos.watchlist(true).map((r) => String(r.address));
    assert.ok(watched.includes(W1), '买方入选');
    assert.ok(watched.includes(W2), '只卖出的钱包同样入选（不做顺价过滤）');
    assert.ok(!watched.includes(W3), '低于阈值的成交不入选');
    assert.ok(watched.includes('0x4444444444444444444444444444444444444444'), '重要存量持有人入选');
    assert.ok(!watched.includes('0x5555555555555555555555555555555555555555'), '灰尘持仓不入选');
    assert.ok(res.byEntry.significant_trade >= 2);
    assert.ok(res.byEntry.major_holder >= 1);
    // 每个进入关注的对象都要有来源与原因（首次发现它的入口负责解释）
    const row = app.repos.db.get('SELECT * FROM watchlist WHERE address=?', W2);
    assert.match(String(row.reason), /买入|卖出/);
    assert.equal(String(row.source), 'significant_trade');
    app.close();
});

test('候选发现：预算上限外的候选记缺口，不静默丢弃', async () => {
    const trades = Array.from({ length: 6 }, (_, i) => trade(`0x${String(i + 1).repeat(40)}`, 'BUY', 10000, 0.5, 1000 + i));
    const app = mkApp({ config: { budgets: { newCandidatesPerCycle: 2 } }, dataApiSpec: { trades, holders: [] } });
    seedMarket(app.repos);
    const res = await app.collector.discoverFromMarket(CID);
    assert.equal(res.added >= 2, true);
    assert.equal(res.skippedOverBudget, 4);
    assert.ok(app.repos.openGaps(20).some((g) => String(g.reason) === 'budget_exhausted'));
    app.close();
});

test('同一交易多条日志 / 跨来源重复：不漏记也不重复入账', () => {
    const row = trade(W1, 'BUY', 100, 0.5, 100, { tx: '0xsame' });
    const dup = assignSyntheticKeys([row, { ...row }, { ...row, size: 101 }]);
    assert.equal(new Set(dup.map((d) => d.syntheticKey)).size, 3, '完全相同的两笔用序号区分；不同笔保持独立');
    assert.equal(dup[0].keyCollision, false);
    assert.equal(dup[1].keyCollision, true);
});

test('场景13：组内转账单列不算外部流入；多签共享签名者不合并身份', async () => {
    // 组内：W1 与 W2 之间有转移
    const items = [
        { from: W1, to: W2, amount: '1000', kind: 'transfer', eventAt: T1 },
        { from: W1, to: '0x9999999999999999999999999999999999999999', amount: '500', kind: 'transfer', eventAt: T1 },
        { from: '0x8888888888888888888888888888888888888888', to: W2, amount: '300', kind: 'transfer', eventAt: T1 },
        { from: W1, to: W2, amount: '1000', kind: 'transfer', eventAt: T1 },  // 重复条目
    ];
    const p = partitionByGroup([W1, W2], items);
    assert.equal(p.internal.length, 1, '组内转移只保留一条');
    assert.equal(p.internalVolume, '1000');
    assert.equal(p.externalOut.length, 1);
    assert.equal(p.externalIn.length, 1);
    assert.equal(p.externalNetIn, '-200', '组内转移不计入对外净额');
    assert.ok(p.notes.some((n) => /去重/.test(n)));
    assert.match(sameBatchEvidence([]).reason, /不足以判定/);

    // 多签共享签名者：只有 owner() 关系能用来判断同实体
    const app = mkApp();
    const S = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    app.repos.insertRelation({ from: S, to: W1, relationType: 'multisig_signer', evidence: '{}', strength: 'verified', checkedAt: T1 });
    app.repos.insertRelation({ from: S, to: W2, relationType: 'multisig_signer', evidence: '{}', strength: 'verified', checkedAt: T1 });
    assert.deepEqual(app.repos.siblingsByOwner(W1), [], '共享多签签名者不据此合并身份');
    app.repos.insertRelation({ from: S, to: W1, relationType: 'owner', evidence: '{}', strength: 'verified', checkedAt: T1 });
    app.repos.insertRelation({ from: S, to: W3, relationType: 'owner', evidence: '{}', strength: 'verified', checkedAt: T1 });
    assert.deepEqual(app.repos.siblingsByOwner(W1), [W3], '同一 owner() 的多个代理钱包才算同源');
    assert.equal(isPublicFunding('0x4fabb145d64652a948d72533023f6e7a623c7c53'), true, '公共来源不能用于合并身份');
    app.close();
});

test('报告：区分事实/推断/缺失；「未观察到」不等于「没有发生」；HTML 只转义动态内容', async () => {
    const app = mkApp();
    seedMarket(app.repos, { question: 'Will <b>X</b> & Y happen?' });
    seedWallet(app.repos, W1);
    seedPosition(app.repos, { wallet: W1, size: '100000', price: '0.5', snapshotAt: T0 });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });   // 先建立观察起点
    seedActivity(app.repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, side: 'SELL', size: '70000', price: '0.6', usdcSize: '42000', eventAt: T1 });
    seedPosition(app.repos, { wallet: W1, size: '30000', price: '0.6', snapshotAt: T1 });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });

    const ev = app.repos.eventsForWallet(W1, 5)[0];
    const row = {
        id: Number(ev.id), wallet: String(ev.wallet), condition_id: ev.condition_id, token_id: ev.token_id,
        event_type: String(ev.event_type), magnitude: ev.magnitude, evidence: String(ev.evidence),
        data_quality: ev.data_quality, priority: ev.priority, priority_reason: String(ev.priority_reason),
        rule_version: String(ev.rule_version), event_at: String(ev.event_at), observed_at: String(ev.observed_at),
    };
    const rep = app.reports.behaviorReport(row, { shadow: true });
    assert.match(rep.body, /部分减仓/);
    assert.match(rep.body, /100000 → 30000/);
    assert.match(rep.body, /-70\.00%/);
    assert.match(rep.body, /按该 token 自身价格/);
    assert.match(rep.body, /数据完整度/);
    assert.match(rep.body, /证据/);
    assert.match(rep.body, /减仓不自动解释为止盈或止损/);
    assert.match(rep.body, /已核对｜关注优先级：高/);
    assert.ok(!/<b>X<\/b>/.test(rep.body), '市场标题里的标记不能被当成 Telegram HTML 传出（必须转义）');
    assert.match(rep.body, /Will &lt;b&gt;X&lt;\/b&gt; &amp; Y/, '动态内容必须转义');
    assert.equal(escapeHtml('a<b>&c'), 'a&lt;b&gt;&amp;c');

    // 没有事件时的市场报告必须写「未观察到」，不能写「没有发生」
    const mr = app.reports.marketReport(CID);
    assert.match(mr, /未发现达到记录阈值的事件/);
    assert.match(mr, /未观察到/);
    assert.ok(!/确认没有发生/.test(mr));

    // 钱包报告：覆盖与缺口必须显式
    const wr = app.reports.walletReport(W1);
    assert.match(wr, /本机首次见到该地址/);
    assert.match(wr, /不能证明账户新旧/);
    assert.match(wr, /成本不完整|不输出胜率/);

    // /status：队列语义与限速策略必须写清楚
    const st = app.reports.statusReport({});
    assert.match(st, /至少一次/);
    assert.match(st, /限速/);
    app.close();
});

test('「提前进场」必须说明相对哪个时刻', () => {
    const before = Reports.earlyEntryText('2026-10-01T00:00:00.000Z', '2026-10-03T00:00:00.000Z');
    assert.match(before, /之前/);
    const after = Reports.earlyEntryText('2026-10-04T00:00:00.000Z', '2026-10-03T00:00:00.000Z');
    assert.match(after, /晚于价格变化|不构成/);
    const unknown = Reports.earlyEntryText('2026-10-04T00:00:00.000Z', null);
    assert.match(unknown, /无法判断先后/);
});

test('影子模式：不向 Telegram 发送真实消息，但状态机照常走完', async () => {
    const app = createApp({ dbPath: tempDbPath(), config: { shadowMode: true } });
    assert.equal(app.config.shadowMode, true);
    app.repos.enqueueAlert('alert:shadow', JSON.stringify({ chatId: '999', title: 't', body: 'b' }));
    const r = await app.outbox.flush(new Date());
    assert.equal(r.sent, 1, '影子模式下状态机照常推进');
    const row = app.db.get("SELECT * FROM alert_outbox WHERE dedupe_key='alert:shadow'");
    assert.equal(row.status, 'sent');
    assert.equal(row.telegram_message_id, 'shadow', '影子发送必须可识别，便于切生产时重新入队');
    // 影子模式不要求任何 Telegram 凭据
    assert.equal(app.config.telegram.enabled, false);
    app.close();
});

test('画像版本落盘：可回放「当时已经获取的信息」', async () => {
    const app = mkApp();
    seedMarket(app.repos);
    seedWallet(app.repos, W1);
    seedPosition(app.repos, { wallet: W1, size: '100', price: '0.5', snapshotAt: T0 });
    seedActivity(app.repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, side: 'BUY', size: '100', price: '0.5', usdcSize: '50', eventAt: T1 });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });
    const pv = app.repos.db.all('SELECT * FROM profile_versions WHERE wallet=?', W1);
    assert.ok(pv.length >= 1);
    const metrics = JSON.parse(String(pv[0].metrics));
    assert.ok(metrics.coverage.firstSeenLocally, '必须记录本机首次看到时间');
    assert.ok(Number(pv[0].coverage_complete) === 0);
    assert.equal(String(pv[0].algorithm_version), 'p1-1');
    app.close();
});

test('低频观察的存量持有人也进入 /check 的覆盖说明', async () => {
    const app = mkApp();
    seedMarket(app.repos);
    seedWallet(app.repos, W2);
    seedPosition(app.repos, { wallet: W2, tokenId: T_NO, conditionId: CID, outcome: 'No', size: '400000', price: '0.2', snapshotAt: T0 });
    app.repos.watch(W2, { marketConditionId: CID, source: 'major_holder', tier: 3, reason: '长期未交易的重点持有人' });
    const mr = app.reports.marketReport(CID);
    assert.match(mr, /观察对象：1 个/);
    assert.match(mr, /major_holder/);
    app.close();
});
