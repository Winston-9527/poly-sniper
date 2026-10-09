/**
 * P1 核心：持仓账本与行为识别（方案 §11 P1 验收 + §12 验收场景）。
 * 全部确定性离线，不依赖网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkApp, seedActivity, seedPosition, seedMarket, seedWallet, W1, W2, CID, T_YES, T_NO, TOKEN, eventTypes } from './helpers.mjs';
import { PositionLedger } from '../dist/ledger/PositionLedger.js';
import { classifyChange, aggregateFills, computePriority } from '../dist/ledger/Behaviors.js';
import { parseDec, decToString, mul } from '../dist/util/decimal.js';

const T0 = '2026-10-01T00:00:00.000Z';   // 观察起点（快照）
const T1 = '2026-10-02T00:00:00.000Z';
const T2 = '2026-10-03T00:00:00.000Z';

function setup({ activity = {}, positions = {}, config = {} } = {}) {
    const app = mkApp({ config, dataApiSpec: { activity, positions } });
    seedMarket(app.repos);
    seedWallet(app.repos, W1, '2026-09-01T00:00:00.000Z');
    return app;
}

test('场景2：长期持有 100,000 份，卖出 10,000 份 → 减仓 10%，不能称清仓', async () => {
    const app = setup();
    seedPosition(app.repos, { wallet: W1, size: '100000', price: '0.5', snapshotAt: T0 });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });     // 建立观察起点
    seedActivity(app.repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, side: 'SELL', size: '10000', price: '0.6', usdcSize: '6000', eventAt: T1 });
    seedPosition(app.repos, { wallet: W1, size: '90000', price: '0.6', snapshotAt: T1 }); // 来源快照确认剩余
    const res = await app.pipeline.processWallet(W1, CID, { skipNetwork: true });

    const events = app.repos.eventsForWallet(W1, 10);
    assert.equal(events.length, 1, '只应产生一条行为事件');
    assert.equal(events[0].event_type, 'position_reduced', '必须是减仓，不是退出');
    const mag = JSON.parse(events[0].magnitude);
    assert.equal(mag.before, '100000');
    assert.equal(mag.after, '90000');
    assert.equal(mag.pct, '-10.00%');
    assert.equal(events[0].data_quality, 'verified', '与快照对账一致 → 已核对');
    // 账本里不能出现 reset 成 0 的痕迹
    const ep = app.repos.db.get("SELECT * FROM position_episodes WHERE wallet=? AND token_id=?", W1, TOKEN);
    assert.equal(ep.status, 'open');
    assert.equal(ep.last_size, '90000');
    assert.ok(res.eventsCreated >= 1);
    app.close();
});

test('场景3：10,000 份全部卖出且快照确认归零 → 本地址退出，且成交额不作为当前仓位', async () => {
    const app = setup();
    seedPosition(app.repos, { wallet: W1, size: '10000', price: '0.5', snapshotAt: T0 });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });
    seedActivity(app.repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, side: 'SELL', size: '10000', price: '0.5', usdcSize: '5000', eventAt: T1 });
    seedPosition(app.repos, { wallet: W1, size: '0', price: '0', snapshotAt: T1 });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });

    const events = app.repos.eventsForWallet(W1, 10);
    const exit = events.find((e) => e.event_type === 'position_exited');
    assert.ok(exit, '应产生「本地址退出」事件');
    assert.equal(exit.data_quality, 'verified', '快照确认归零 → 已核对');

    // 当前仓位来自快照，而不是累计成交额
    const profile = app.pipeline.profiler.build(W1, { windowsDays: [90] });
    const pos = profile.positions.find((p) => p.tokenId === TOKEN);
    assert.equal(pos.size, '0', '当前份数必须是 0（按快照），不能用成交额充当仓位');
    app.close();
});

test('场景3b：推导归零但快照未确认 → 只报「疑似退出，待核对」（质量 partial）', async () => {
    const app = setup();
    seedPosition(app.repos, { wallet: W1, size: '10000', price: '0.5', snapshotAt: T0 });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });
    seedActivity(app.repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, side: 'SELL', size: '10000', price: '0.5', usdcSize: '5000', eventAt: T1 });
    // 快照仍显示 10,000（延迟），未确认归零
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });
    const exit = app.repos.eventsForWallet(W1, 10).find((e) => e.event_type === 'position_exited');
    assert.ok(exit);
    assert.equal(exit.data_quality, 'partial', '未确认归零时不能标为已核对');
    assert.equal(exit.priority, 'medium', '名义金额低于绝对下限时不因「退出」自动升级（避免微小仓位刷屏）');
    assert.match(exit.priority_reason, /自身持仓变化 -100\.0%/);
    app.close();
});

test('场景4：0.2 买入后 0.4 卖出同样份数 → 识别为买入后退出，不因卖出金额更大判对冲', async () => {
    const app = setup();
    seedWallet(app.repos, W1, '2026-09-30T00:00:00.000Z');
    seedActivity(app.repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, side: 'BUY', size: '20000', price: '0.2', usdcSize: '4000', eventAt: T1, txHash: '0xbuy' });
    seedActivity(app.repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, side: 'SELL', size: '20000', price: '0.4', usdcSize: '8000', eventAt: T2, txHash: '0xsell' });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });
    const types = eventTypes(app.repos, W1);
    assert.deepEqual(types.sort(), ['position_exited', 'position_opened'].sort());
    const entries = app.repos.ledgerForWallet(W1);
    const buy = entries.find((e) => e.kind === 'trade_buy');
    const sell = entries.find((e) => e.kind === 'trade_sell');
    assert.equal(buy.cash_delta, '-4000');
    assert.equal(sell.cash_delta, '8000');
    // 卖出金额更大，但账本上没有「对冲/反手」这类判定
    assert.ok(!entries.some((e) => /hedge|对冲/.test(String(e.kind) + String(e.note ?? ''))));
    app.close();
});

test('场景5：Yes=0.9 且只持有 20,000 份 No → 按 No 自己的价格估值，不能得到 $18,000', async () => {
    const app = setup();
    const ledger = new PositionLedger(app.repos);
    const size = parseDec('20000');
    const noPrice = parseDec('0.1');
    const yesPrice = parseDec('0.9');
    assert.equal(decToString(ledger.valuePosition(size, noPrice)), '2000');
    assert.notEqual(decToString(ledger.valuePosition(size, yesPrice)), '2000');
    assert.equal(decToString(ledger.valuePosition(size, yesPrice)), '18000', '拿 Yes 价格估值才会得到错误金额——代码路径必须按 token 取价');

    // 端到端：两个 token 用各自价格
    seedPosition(app.repos, { wallet: W1, tokenId: T_YES, conditionId: CID, outcome: 'Yes', size: '20000', price: '0.9', snapshotAt: T0 });
    seedPosition(app.repos, { wallet: W1, tokenId: T_NO, conditionId: CID, outcome: 'No', size: '20000', price: '0.1', snapshotAt: T0 });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });
    const profile = app.pipeline.profiler.build(W1, { windowsDays: [90] });
    const no = profile.positions.find((p) => p.tokenId === T_NO);
    const yes = profile.positions.find((p) => p.tokenId === T_YES);
    assert.equal(no.value, '2000');
    assert.equal(yes.value, '18000');
    assert.equal(profile.positionValueCovered, '20000', '组合价值是各自估值之和');
    app.close();
});

test('场景6：买卖同时出现 / 订单拆成多笔成交 → 保留顺序与聚合口径，不自动解释反手或多次决策', () => {
    const rows = [
        { wallet: W1, tokenId: TOKEN, kind: 'trade_buy', eventAt: '2026-10-02T00:00:05.000Z' },
        { wallet: W1, tokenId: TOKEN, kind: 'trade_buy', eventAt: '2026-10-02T00:00:40.000Z' },
        { wallet: W1, tokenId: TOKEN, kind: 'trade_sell', eventAt: '2026-10-02T00:01:10.000Z' },
        { wallet: W1, tokenId: TOKEN, kind: 'trade_buy', eventAt: '2026-10-02T03:00:00.000Z' },
    ];
    const agg = aggregateFills(rows, 10);
    assert.equal(agg.length, 4, '原始顺序与笔数必须保留');
    assert.deepEqual(agg.map((a) => a.eventAt), [...rows].map((r) => r.eventAt), '按时间排序，不重排');
    assert.equal(agg[0].groupIndex, agg[1].groupIndex, '同向且窗口内的两笔合成一次行为决策');
    assert.equal(agg[0].groupSize, 2);
    assert.equal(agg[2].groupIndex === agg[1].groupIndex, false, '反向成交不合并');
    assert.equal(agg[3].groupIndex === agg[0].groupIndex, false, '超出窗口的不合并');
});

test('场景12：拆分/合并/转换/赎回造成份数变化 → 按来源类型记录，不支持时报告待解释差异', async () => {
    const app = setup();
    seedPosition(app.repos, { wallet: W1, size: '5000', price: '0.5', snapshotAt: T0 });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });
    // 一次 SPLIT（份数变化无法单独归因）
    seedActivity(app.repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, type: 'SPLIT', size: '5000', price: '0.5', usdcSize: '-5000', eventAt: T1, txHash: '0xsplit' });
    // 快照显示份数变多（拆分导致），账本推导无法解释
    seedPosition(app.repos, { wallet: W1, size: '10000', price: '0.5', snapshotAt: T1 });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });
    const entries = app.repos.ledgerForWallet(W1);
    const split = entries.find((e) => e.kind === 'split');
    assert.ok(split, 'SPLIT 必须按来源类型记录');
    assert.equal(split.source_type, 'unexplained', '不能伪装成买卖');
    const gaps = app.repos.openGaps(50).map((g) => String(g.reason));
    assert.ok(gaps.includes('unsupported_activity'), '未支持的类型要有缺口记录');
    assert.ok(gaps.includes('unexplained_change'), '与快照不一致要报告待解释差异');

    // REDEEM：按推导持仓归零
    const app2 = setup();
    seedPosition(app2.repos, { wallet: W1, size: '8000', price: '0.5', snapshotAt: T0 });
    await app2.pipeline.processWallet(W1, CID, { skipNetwork: true });
    seedActivity(app2.repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, type: 'REDEEM', size: '8000', price: '0', usdcSize: '8000', eventAt: T1, txHash: '0xredeem' });
    await app2.pipeline.processWallet(W1, CID, { skipNetwork: true });
    const ep = app2.repos.db.get('SELECT * FROM position_episodes WHERE wallet=? AND token_id=?', W1, TOKEN);
    assert.equal(ep.last_size, '0');
    assert.equal(ep.closed_reason, 'redeem');
    const redeem = app2.repos.ledgerForWallet(W1).find((e) => e.kind === 'redeem');
    assert.equal(redeem.delta_size, '-8000');
    assert.equal(redeem.source_type, 'derived');
    app.close(); app2.close();
});

test('场景11 + P1 验收：重复采集不重复入账、不重复报警', async () => {
    const app = setup();
    seedPosition(app.repos, { wallet: W1, size: '100000', price: '0.5', snapshotAt: T0 });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });
    const a = seedActivity(app.repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, side: 'SELL', size: '20000', price: '0.6', usdcSize: '12000', eventAt: T1, txHash: '0xsame' });
    // 同一来源记录再次入库（跨来源/同一交易多条日志的重复）
    const again = seedActivity(app.repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, side: 'SELL', size: '20000', price: '0.6', usdcSize: '12000', eventAt: T1, txHash: '0xsame' });
    assert.equal(again.inserted, false, '同一合成键不能重复入库');
    assert.equal(a.inserted, true);

    seedPosition(app.repos, { wallet: W1, size: '80000', price: '0.6', snapshotAt: T1 });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });
    const entryCount = app.repos.ledgerForWallet(W1).length;
    assert.equal(entryCount, 1, '账本条目必须去重');
    assert.equal(app.repos.eventsForWallet(W1, 10).length, 1, '行为事件必须去重');
    assert.equal(app.repos.outboxStats().pending ?? 0, 1, '报警只入队一次');
    app.close();
});

test('场景1：老钱包突然大额买入 → 可以发现并报告，不要求新号或同源关联', async () => {
    const app = setup({ config: { rules: { absoluteNotionalFloor: 10000 } } });
    seedWallet(app.repos, W1, '2020-01-01T00:00:00.000Z');  // 很老的钱包
    seedActivity(app.repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, side: 'BUY', size: '100000', price: '0.5', usdcSize: '50000', eventAt: T1, txHash: '0xbig' });
    const res = await app.pipeline.processWallet(W1, CID, { skipNetwork: true });
    const ev = app.repos.eventsForWallet(W1, 10);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].event_type, 'position_opened');
    assert.equal(ev[0].priority, 'high', '大额买入本身就该触发高优先级，不需要新号或同源条件');
    // 没有任何控制关系/同源记录也照样成立
    assert.equal(app.repos.relationsFrom(W1).length, 0);
    assert.ok(res.eventsCreated === 1);
    app.close();
});

test('场景7：查询失败 → 记录缺口与失败，不产生「分析正常」的成功结论', async () => {
    const app = mkApp({ dataApiSpec: { failActivity: { kind: 'timeout', error: 'ETIMEDOUT' } } });
    seedMarket(app.repos);
    seedWallet(app.repos, W1);
    const res = await app.pipeline.processWallet(W1, CID, {});
    assert.equal(res.eventsCreated, 0);
    assert.match(String(res.collected.error), /timeout|ETIMEDOUT/);
    const gaps = app.repos.openGaps(20).map((g) => String(g.reason));
    assert.ok(gaps.includes('query_failed'), '失败必须留下缺口');
    const state = app.repos.getState(`activity:${W1}`);
    assert.ok(Number(state.consecutive_failures) >= 1, '失败要累计');
    const status = app.reports.statusReport({});
    assert.match(status, /query_failed/);
    app.close();
});

test('场景7b：首次在本机出现不获得加分（优先级里没有钱包年龄这一项）', () => {
    const rules = { absoluteNotionalFloor: 10000, reducePctThreshold: 0.15, relativeSizeMultiplier: 3, reactivationHours: 720, alertCooldownMinutes: 30 };
    const base = { eventType: 'position_increased', relativeMultiplier: null, positionChangeRatio: parseDec('0.05'), dataQuality: 'verified', firstTimeLongTermChange: false, rules };
    const p1 = computePriority({ ...base, notional: parseDec('1000') });
    const p2 = computePriority({ ...base, notional: parseDec('1000') });
    assert.equal(p1.priority, 'low');
    assert.equal(p1.priority, p2.priority, '同样的变化必须得到同样的优先级（不存在「新钱包」加成）');
    assert.match(p1.reason, /未达到绝对下限/);
});

test('场景8：最早 200 条只涉及一个事件且历史被截断 → 不判定其终身只关注一个事件', async () => {
    const app = setup();
    seedWallet(app.repos, W1, '2026-09-01T00:00:00.000Z');
    seedActivity(app.repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, side: 'BUY', size: '100', price: '0.5', usdcSize: '50', eventAt: T1 });
    app.repos.upsertState(`activity:${W1}`, {
        earliestTs: T1, reachedStart: false, truncated: true,
        truncationReason: 'ASC 首页已满 500 条，起点未取到（2026-10-02T00:00:00.000Z）', lastOkAt: T1,
    });
    const profile = app.pipeline.profiler.build(W1, { windowsDays: [90] });
    const text = app.pipeline.profiler.describeActivityHistory(profile);
    assert.match(text, /历史可能更长|尚未取到起点/, '必须说明历史不完整');
    assert.ok(!/终身|只关注|仅参与一个/.test(text), '不能把局部当终身');
    assert.equal(profile.coverage.reachedSourceStart, false);
    assert.match(String(profile.notes.join(' ')), /截断/);
    app.close();
});

test('场景9：最近两天没有交易、但数月前已有大仓位 → 保留存量观察，不被静默归档', async () => {
    const app = setup();
    seedPosition(app.repos, { wallet: W1, size: '500000', price: '0.4', snapshotAt: '2026-06-01T00:00:00.000Z' });
    app.repos.watch(W1, { marketConditionId: CID, source: 'major_holder', tier: 2, reason: '重点持有人', nextCollectAt: '2026-06-01T00:00:00.000Z' });
    app.repos.setWatchState(W1, CID, { lastCollectAt: '2026-06-01T00:00:00.000Z', state: 'watching' });
    const { downgraded } = app.collector.applyTierPolicy();
    assert.equal(downgraded, 1, '长期静默的存量大户降级为低频观察');
    const row = app.repos.db.get('SELECT * FROM watchlist WHERE address=?', W1);
    assert.equal(row.state, 'lowfreq');
    assert.equal(row.withdrawn_at, null, '降级不等于归档，仍然保留观察');
    assert.equal(Number(row.priority_tier), 3);
    const due = app.repos.dueWatch(new Date().toISOString(), 10);
    assert.ok(due.some((d) => d.address === W1), '低频观察对象仍会被调度');
    // 手动关注不降级
    seedWallet(app.repos, W2);
    app.repos.watch(W2, { source: 'manual', tier: 1, reason: '手动' });
    app.repos.setWatchState(W2, '', { lastCollectAt: '2026-06-01T00:00:00.000Z' });
    app.collector.applyTierPolicy();
    assert.equal(Number(app.repos.db.get('SELECT priority_tier FROM watchlist WHERE address=?', W2).priority_tier), 1, '手动关注不被自动淘汰');
    app.close();
});

test('P1 验收：不依赖完整历史成本也能准确说明上线后的份数变化；老钱包不被年龄门槛排除', async () => {
    const app = setup();
    seedWallet(app.repos, W1, '2019-05-05T00:00:00.000Z');   // 6 年前就开始的老钱包
    seedPosition(app.repos, { wallet: W1, size: '30000', price: '0.3', snapshotAt: T0 });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });
    seedActivity(app.repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, side: 'BUY', size: '30000', price: '0.35', usdcSize: '10500', eventAt: T1, txHash: '0xb' });
    seedPosition(app.repos, { wallet: W1, size: '60000', price: '0.35', snapshotAt: T1 });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });
    const ev = app.repos.eventsForWallet(W1, 10)[0];
    assert.equal(ev.event_type, 'position_increased');
    const mag = JSON.parse(ev.magnitude);
    assert.equal(mag.before, '30000');
    assert.equal(mag.after, '60000');
    const ep = app.repos.db.get('SELECT * FROM position_episodes WHERE wallet=? AND token_id=?', W1, TOKEN);
    assert.equal(Number(ep.baseline_complete), 0, '观察起点建立的持仓过程必须标注基线不完整（不补造历史成本）');
    const profile = app.pipeline.profiler.build(W1, { windowsDays: [90] });
    assert.equal(profile.pnl.available, false, '成本不完整时不输出收益率');
    app.close();
});

test('卖出超过已知持仓（顺序不自洽）→ 报未解释变化，不当作退出', async () => {
    const app = setup();
    seedPosition(app.repos, { wallet: W1, size: '100', price: '0.5', snapshotAt: T0 });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });
    seedActivity(app.repos, { wallet: W1, tokenId: TOKEN, conditionId: CID, side: 'SELL', size: '500', price: '0.5', usdcSize: '250', eventAt: T1, txHash: '0xover' });
    await app.pipeline.processWallet(W1, CID, { skipNetwork: true });
    const ev = app.repos.eventsForWallet(W1, 10);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].event_type, 'unexplained_change');
    assert.equal(ev[0].data_quality, 'incomplete');
    const gaps = app.repos.openGaps(20).map((g) => String(g.reason));
    assert.ok(gaps.includes('unexplained_change'));
    app.close();
});
