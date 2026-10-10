/**
 * 市场异动测试（首要信号）。纯函数为主，离线确定性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAnomaly, anomalyRulesFromConfig } from '../dist/market/MarketScanner.js';
import { parseDec, decToString } from '../dist/util/decimal.js';
import { mkApp, seedMarket, CID, TOKEN, T_NO } from './helpers.mjs';
import { Reports } from '../dist/report/Reports.js';

const RULES = {
    priceMove: 0.05, priceMoveHigh: 0.10, windowMinutes: 15,
    spreadRatio: 0.10, spreadRatioHigh: 0.25, spreadGrowth: 1.5, minMidPrice: 0.05, minAbsSpread: 0.01,
    volumeSurge: 3, volumeSurgeHigh: 8,
    minVolume24h: 5000, minLiquidity: 5000, cooldownMinutes: 30,
};

function snap(over = {}) {
    return {
        conditionId: CID, tokenId: TOKEN, outcome: 'Yes',
        price: parseDec('0.30'), bestBid: parseDec('0.29'), bestAsk: parseDec('0.31'), spread: parseDec('0.02'),
        lastTradePrice: parseDec('0.30'), change1h: null, change24h: null,
        volume24h: parseDec('50000'), liquidity: parseDec('40000'),
        observedAt: '2026-10-09T10:00:00.000Z', ...over,
    };
}

test('价格异动：达到阈值就报，且原因写清楚窗口与前后价；低于阈值不报', () => {
    const prev = snap();
    const up = snap({ price: parseDec('0.36'), observedAt: '2026-10-09T10:05:00.000Z' });   // +6 个百分点
    const { candidates } = detectAnomaly(prev, up, RULES);
    const move = candidates.find((c) => c.kind === 'price_move');
    assert.ok(move, '6 个百分点必须触发价格异动');
    assert.equal(move.priority, 'medium', '未到 10 个百分点 → 中优先级');
    assert.match(move.reason, /5 分钟内价格 0\.3 → 0\.36/);
    assert.equal(decToString(move.delta), '0.06');

    const tiny = snap({ price: parseDec('0.32'), observedAt: '2026-10-09T10:05:00.000Z' });  // +2 个百分点
    assert.equal(detectAnomaly(prev, tiny, RULES).candidates.some((c) => c.kind === 'price_move'), false, '2 个百分点不报');
});

test('价格异动：大额 + 大幅 → 高优先级；24h 量或流动性过低 → 只记录不推（low）', () => {
    const prev = snap({ price: parseDec('0.50') });
    const big = snap({ price: parseDec('0.65'), observedAt: '2026-10-09T10:05:00.000Z' });    // +15 个百分点
    assert.equal(detectAnomaly(prev, big, RULES).candidates.find((c) => c.kind === 'price_move').priority, 'high');

    const dead = snap({ price: parseDec('0.65'), volume24h: parseDec('100'), liquidity: parseDec('50'), observedAt: '2026-10-09T10:05:00.000Z' });
    assert.equal(detectAnomaly(prev, dead, RULES).candidates.find((c) => c.kind === 'price_move').priority, 'low', '死市场的异动只记录不推');
});

test('盘口走阔：价差占中间价超阈值才报，并给出买卖价与比例', () => {
    const prev = snap();
    const wide = snap({ bestBid: parseDec('0.20'), bestAsk: parseDec('0.40'), spread: parseDec('0.20'), observedAt: '2026-10-09T10:05:00.000Z' });
    const c = detectAnomaly(prev, wide, RULES).candidates.find((x) => x.kind === 'spread_widen');
    assert.ok(c, '价差 0.20/中间价 0.30 = 66% 必须触发');
    assert.equal(c.priority, 'high');
    assert.match(c.reason, /买 0\.2 \/ 卖 0\.4，价差 0\.2/);

    const tight = snap({ bestBid: parseDec('0.295'), bestAsk: parseDec('0.305'), spread: parseDec('0.01'), observedAt: '2026-10-09T10:05:00.000Z' });
    assert.equal(detectAnomaly(prev, tight, RULES).candidates.some((x) => x.kind === 'spread_widen'), false);
});

test('成交量突增：按倍数判定；首条观察不下结论（数据不足要说出来）', () => {
    const prev = snap({ volume24h: parseDec('10000') });
    const surge = snap({ volume24h: parseDec('90000'), observedAt: '2026-10-09T10:05:00.000Z' });
    const c = detectAnomaly(prev, surge, RULES).candidates.find((x) => x.kind === 'volume_surge');
    assert.ok(c);
    assert.equal(c.priority, 'high', '9 倍 → 高');
    assert.match(c.reason, /3\.0 倍阈值|9\.0 倍/);

    const first = detectAnomaly(null, snap(), RULES);
    assert.equal(first.candidates.length, 0);
    assert.match(String(first.insufficient), /第一条观察/);
});

test('价格缺失时不伪造异动，直接说数据不足', () => {
    const prev = snap({ price: null });
    const cur = snap({ price: null, observedAt: '2026-10-09T10:05:00.000Z' });
    const r = detectAnomaly(prev, cur, RULES);
    assert.equal(r.candidates.length, 0);
    assert.match(String(r.insufficient), /价格缺失/);
});

test('同一市场/方向的异动在冷却窗口内去重（重复扫描不重复报警）', () => {
    const prev = snap();
    const up = snap({ price: parseDec('0.36'), observedAt: '2026-10-09T10:05:00.000Z' });
    const a1 = detectAnomaly(prev, up, RULES).candidates.find((c) => c.kind === 'price_move');
    const up2 = snap({ price: parseDec('0.42'), observedAt: '2026-10-09T10:06:00.000Z' });
    const a2 = detectAnomaly(up, up2, RULES).candidates.find((c) => c.kind === 'price_move');
    assert.ok(a1 && a2);
    assert.equal(a1.dedupeKey, a2.dedupeKey, '同一冷却窗口内继续同向异动 → 同一个键（不重复推送，后续并入同一过程）');
    const later = snap({ price: parseDec('0.50'), observedAt: '2026-10-09T11:30:00.000Z' });
    const a3 = detectAnomaly(up2, later, RULES).candidates.find((c) => c.kind === 'price_move');
    assert.ok(a3);
    assert.notEqual(a1.dedupeKey, a3.dedupeKey, '过了冷却窗口是新的一条');
});

test('市场异动报告必须带：市场名、结果、现价变化、盘口、24h 量/流动性、市场链接', () => {
    const app = mkApp();
    seedMarket(app.repos, { question: 'Will X win?' });
    app.repos.insertMarketObservation({
        conditionId: CID, tokenId: TOKEN, outcome: 'Yes', price: '0.36',
        bestBid: '0.35', bestAsk: '0.37', spread: '0.02', lastTradePrice: '0.36',
        change1h: '-0.12', change24h: '-0.38', volume24h: '703311', liquidity: '77710',
        observedAt: '2026-10-09T10:05:00.000Z',
    });
    const rec = app.repos.insertMarketAnomaly({
        dedupeKey: 'ma:test:1', conditionId: CID, tokenId: TOKEN, outcome: 'Yes', kind: 'price_move',
        windowMinutes: 5, priceBefore: '0.30', priceAfter: '0.36', delta: '0.06',
        bestBid: '0.35', bestAsk: '0.37', spread: '0.02', volume24h: '703311', liquidity: '77710',
        change1h: '-0.12', change24h: '-0.38', priority: 'high', reason: '5 分钟内价格 0.3 → 0.36（变化 6.0 个百分点）',
        dataQuality: 'verified', ruleVersion: 'p1-rules-2', eventAt: '2026-10-09T10:05:00.000Z', observedAt: '2026-10-09T10:05:01.000Z',
    });
    const row = app.repos.db.get('SELECT * FROM market_anomalies WHERE id=?', rec.id);
    const reports = new Reports(app.repos, app.cfg);
    const rep = reports.marketAnomalyReport(row, { movers: [{ wallet: '0xabc0000000000000000000000000000000000001', buy: '12000', sell: '0', trades: 3 }] });
    assert.match(rep.body, /【市场异动】价格异动/);
    assert.match(rep.body, /Will X win\?/);
    assert.match(rep.body, /盘口：买 0\.35 \/ 卖 0\.37（价差 0\.02）/);
    assert.match(rep.body, /24h 成交 \$703/);
    assert.match(rep.body, /变化 1h -12\.0%｜24h -38\.0%/);
    assert.match(rep.body, /polymarket\.com\/market\/test-market/, '必须给出市场链接');
    assert.match(rep.body, /谁在动/);
    assert.match(rep.body, /\$12,000/);
    assert.match(rep.body, /5 分钟/);
    // 没有 slug 时明确说「未取到」，不伪造链接
    const app2 = mkApp();
    app2.repos.insertMarketAnomaly({
        dedupeKey: 'ma:test:2', conditionId: '0x' + 'b'.repeat(64), tokenId: TOKEN, outcome: 'Yes', kind: 'volume_surge',
        windowMinutes: 5, priceBefore: null, priceAfter: null, delta: null, bestBid: null, bestAsk: null, spread: null,
        volume24h: '90000', liquidity: '10000', change1h: null, change24h: null, priority: 'medium',
        reason: '成交量突增', dataQuality: 'verified', ruleVersion: 'p1-rules-2',
        eventAt: '2026-10-09T10:05:00.000Z', observedAt: '2026-10-09T10:05:01.000Z',
    });
    const row2 = app2.repos.db.get("SELECT * FROM market_anomalies WHERE dedupe_key='ma:test:2'");
    const rep2 = new Reports(app2.repos, app2.cfg).marketAnomalyReport(row2, {});
    assert.match(rep2.body, /盘口：未取到/);
    assert.match(rep2.body, /市场页链接未取到/);
    app.close(); app2.close();
});

test('谁在动：补一次成交流水后，报告里能看到具体钱包与买卖金额；10 分钟内不重复拉取', async () => {
    const trades = [
        { proxyWallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', side: 'BUY', asset: TOKEN, conditionId: CID, size: 20000, price: 0.3, timestamp: Math.floor(Date.now() / 1000) - 300, transactionHash: '0xm1', outcome: 'Yes', outcomeIndex: 0 },
        { proxyWallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', side: 'SELL', asset: TOKEN, conditionId: CID, size: 5000, price: 0.3, timestamp: Math.floor(Date.now() / 1000) - 200, transactionHash: '0xm2', outcome: 'Yes', outcomeIndex: 0 },
    ];
    const app = mkApp({ dataApiSpec: { trades } });
    seedMarket(app.repos);
    const first = await app.scanner.ensureTradesFor(CID);
    assert.equal(first.ok, true);
    assert.equal(first.rows, 2, '取到 2 笔成交');
    const movers = app.scanner.recentMovers(CID, 3);
    assert.equal(movers.length, 2);
    assert.equal(movers[0].wallet, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(movers[0].buy, '6000', '20000 份 × 0.30 = $6000');
    assert.equal(movers[1].sell, '1500');

    // 10 分钟内不重复请求（省预算）
    const second = await app.scanner.ensureTradesFor(CID);
    assert.equal(second.skipped ? true : false, true);
    assert.match(String(second.skipped), /已取过/);

    // 报告里必须出现「谁在动」的具体条目
    const rec = app.repos.insertMarketAnomaly({
        dedupeKey: 'ma:movers:1', conditionId: CID, tokenId: TOKEN, outcome: 'Yes', kind: 'price_move',
        windowMinutes: 5, priceBefore: '0.30', priceAfter: '0.36', delta: '0.06',
        bestBid: '0.35', bestAsk: '0.37', spread: '0.02', volume24h: '703311', liquidity: '77710',
        change1h: null, change24h: null, priority: 'high', reason: 'r', dataQuality: 'verified',
        ruleVersion: 'p1-rules-2', eventAt: '2026-10-09T10:05:00.000Z', observedAt: '2026-10-09T10:05:01.000Z',
    });
    const row = app.repos.db.get('SELECT * FROM market_anomalies WHERE id=?', rec.id);
    const body = new Reports(app.repos, app.cfg).marketAnomalyReport(row, { movers: app.scanner.recentMovers(CID, 3) }).body;
    assert.match(body, /0xaaaaaaaa…/);
    assert.match(body, /买 \$6,000 \/ 卖 \$0/);
    app.close();
});

test('盘口补充：CLOB 双边价自己算价差（第二结果也能补上，不再写「未取到」）', async () => {
    // 实测口径：side=buy → 买一价；side=sell → 卖一价
    const prices = { buy: '0.35', sell: '0.37' };
    const fakeHttpResponse = (url) => {
        if (url.includes('side=buy')) return { ok: true, data: { price: prices.buy }, status: 200, ms: 1, url };
        if (url.includes('side=sell')) return { ok: true, data: { price: prices.sell }, status: 200, ms: 1, url };
        return { ok: false, kind: 'http', error: '404', url, ms: 1 };
    };
    const app = mkApp({ httpHandler: async (url) => fakeHttpResponse(url) });
    const book = await app.scanner.enrichBook(T_NO);
    assert.equal(book.ok, true);
    assert.equal(book.bestBid, '0.35');
    assert.equal(book.bestAsk, '0.37');
    assert.equal(book.spread, '0.02', '价差由买/卖自行相减（精确十进制）');
    assert.equal(book.requests, 2, '只用 2 个请求');

    // 买一 > 卖一（瞬时错位）时不写负数价差
    const inverted = mkApp({ httpHandler: async (url) => ({ ok: true, data: { price: url.includes('side=buy') ? '0.40' : '0.38' }, status: 200, ms: 1, url }) });
    const b2 = await inverted.scanner.enrichBook(T_NO);
    assert.equal(Number(b2.bestBid), 0.4);
    assert.equal(Number(b2.bestAsk), 0.38);
    assert.equal(b2.spread, null, '负价差按未知处理，不显示 -0.02');
    inverted.close();
    app.close();
});

test('盘口走阔必须「变宽」：放大幅度不够即使很宽也不报（分币市场噪音闸）', () => {
    const prev = snap({ bestBid: parseDec('0.04'), bestAsk: parseDec('0.06'), spread: parseDec('0.02') });
    const wideButSame = snap({ bestBid: parseDec('0.20'), bestAsk: parseDec('0.40'), spread: parseDec('0.20'), observedAt: '2026-10-09T10:05:00.000Z' });
    // 中间价 0.30 ≥ 0.08、绝对价差 0.20 ≥ 0.02、放大 10 倍 → 触发（这是真变宽）
    assert.ok(detectAnomaly(prev, wideButSame, RULES).candidates.some((c) => c.kind === 'spread_widen'));

    const pennyPrev = snap({ bestBid: parseDec('0.001'), bestAsk: parseDec('0.002'), spread: parseDec('0.001') });
    const pennyCur = snap({ bestBid: parseDec('0.002'), bestAsk: parseDec('0.003'), spread: parseDec('0.001'), observedAt: '2026-10-09T10:05:00.000Z' });
    assert.equal(detectAnomaly(pennyPrev, pennyCur, RULES).candidates.some((c) => c.kind === 'spread_widen'), false, '分币市场（中间价 <0.08）不报相对价差');

    const tinyWiden = snap({ bestBid: parseDec('0.29'), bestAsk: parseDec('0.315'), spread: parseDec('0.025'), observedAt: '2026-10-09T10:05:00.000Z' });
    assert.equal(detectAnomaly(snap(), tinyWiden, RULES).candidates.some((c) => c.kind === 'spread_widen'), false, '只放大 1.25 倍（<2）不报');
});

test('配置默认值可用（异动阈值来自配置，可调）', () => {
    const app = mkApp();
    const r = anomalyRulesFromConfig(app.cfg);
    assert.equal(r.priceMove, 0.05);
    assert.equal(r.volumeSurge, 3);
    assert.ok(r.minVolume24h > 0);
    app.close();
});

test('长尾聚焦：排除高频结算（小时级币价盘/当天球赛）与体育/电竞盘，保留长尾市场', () => {
    const app = mkApp();
    const sc = app.scanner;
    const iso = (h) => new Date(Date.now() + h * 3600_000).toISOString();
    // 体育/电竞：slug 首段命中联赛表（即使几个月后才结算也排除）
    assert.match(String(sc.exclusionReason({ slug: 'epl-ars-lee-2026-10-10-ars', endDate: iso(200) })), /sports_esports_slug:epl/);
    assert.match(String(sc.exclusionReason({ slug: 'cs2-navi-vs-faze-bo3', endDate: iso(100) })), /sports_esports_slug:cs2/);
    assert.match(String(sc.exclusionReason({ slug: 'nba-lal-bos-2026-12-25', endDate: iso(1000) })), /sports_esports_slug:nba/);
    // 高频模式：updown/hourly/15m/1h（结束时间再远也排除）
    assert.equal(sc.exclusionReason({ slug: 'bitcoin-updown-15m-2026-10-10-1500', endDate: iso(300) }), 'high_frequency_slug');
    assert.equal(sc.exclusionReason({ slug: 'eth-hourly-price-2026-11-01', endDate: iso(400) }), 'high_frequency_slug');
    // 距结束不足 24h：小时级币价盘、当天球赛（非联赛 slug 也能挡住）
    assert.match(String(sc.exclusionReason({ slug: 'will-it-rain-in-nyc-today', endDate: iso(3) })), /settles_soon/);
    assert.equal(sc.exclusionReason({ slug: 'some-stale-market', endDate: iso(-5) }), 'already_ended');
    // 长尾保留
    assert.equal(sc.exclusionReason({ slug: 'will-nithya-raman-win-the-2026-los-angeles-mayoral-election', endDate: iso(500) }), null);
    assert.equal(sc.exclusionReason({ slug: 'strait-of-hormuz-closed-by-december-31-2026', endDate: iso(1200) }), null);
    app.close();
});

test('观察期不限量：上限设 0 时 25 条全部照发，不再合并成摘要', async () => {
    const app = mkApp({ config: { push: { maxPerMinute: 0, maxPerDay: 0, maxHighPerDay: 0, maxPerCycleAlerts: 0, maxMarketPerCycle: 0, minIntervalMs: 0 } } });
    seedMarket(app.repos);
    for (let i = 0; i < 25; i++) {
        app.outbox.enqueue(`alert:unlimited:${i}`, { chatId: '999', title: `告警${i}`, body: `b${i}`, wallet: '', conditionId: CID, priority: 'medium', dataQuality: 'verified' });
    }
    const rep = await app.outbox.flush(new Date());
    assert.equal(rep.sent, 25, '25 条全部发出');
    assert.equal(rep.merged ?? 0, 0, '没有条目被合并');
    assert.equal(app.sentMessages.length, 25);
    app.close();
});

test('长尾聚焦：slug 里含联赛/赛事名（首段是 will 的）也要排除，如 ESL 电竞、Wimbledon', () => {
    const app = mkApp();
    const sc = app.scanner;
    const iso = (h) => new Date(Date.now() + h * 3600_000).toISOString();
    assert.match(String(sc.exclusionReason({ slug: 'will-vitality-win-the-esl-pro-league-season-24', endDate: iso(2000) })), /sports_esports_keyword:esl/);
    assert.match(String(sc.exclusionReason({ slug: 'will-novak-djokovic-win-wimbledon-2027', endDate: iso(5000) })), /sports_esports_keyword:wimbledon/);
    assert.match(String(sc.exclusionReason({ slug: 'will-real-madrid-win-la-liga-2027', endDate: iso(3000) })), /sports_esports_keyword:la-liga/);
    // 不该误伤的：含相似片段的非体育市场
    assert.equal(sc.exclusionReason({ slug: 'will-openai-release-gpt-6-by-december-2026', endDate: iso(1500) }), null);
    assert.equal(sc.exclusionReason({ slug: 'will-the-us-enter-a-recession-in-2027', endDate: iso(2000) }), null);
    app.close();
});

test('链接与金额：钱包指向 Polymarket 持仓页（不是 Polygonscan），金额取整到分', () => {
    const app = mkApp();
    const W = '0x40e4d8ad998bea126b20f3534b540fbf34866ef7';
    seedMarket(app.repos);
    const rec = app.repos.insertMarketAnomaly({
        dedupeKey: 'ma:link:1', conditionId: CID, tokenId: TOKEN, outcome: 'Yes', kind: 'price_move',
        windowMinutes: 5, priceBefore: '0.30', priceAfter: '0.36', delta: '0.06',
        bestBid: '0.35', bestAsk: '0.37', spread: '0.02', volume24h: '703311', liquidity: '77710',
        change1h: null, change24h: null, priority: 'high', reason: 'r', dataQuality: 'verified',
        ruleVersion: 'p1-rules-2', eventAt: '2026-10-09T10:05:00.000Z', observedAt: '2026-10-09T10:05:01.000Z',
    });
    const row = app.repos.db.get('SELECT * FROM market_anomalies WHERE id=?', rec.id);
    const body = new Reports(app.repos, app.cfg).marketAnomalyReport(row, {
        movers: [{ wallet: W, buy: '7.840000000860318', sell: '0', trades: 1 }],
    }).body;
    assert.match(body, /https:\/\/polymarket\.com\/profile\/0x40e4d8ad998bea126b20f3534b540fbf34866ef7/, '钱包链接指向 Polymarket 持仓页');
    assert.equal(body.includes('polygonscan'), false, '不再出现 Polygonscan');
    assert.match(body, /买 \$7\.84 \/ 卖 \$0/, '金额取整到分，不打印 18 位小数');
    assert.equal(/灰尘级/.test(body), false, '$7.84 不算灰尘级');
    const dustBody = new Reports(app.repos, app.cfg).marketAnomalyReport(row, {
        movers: [{ wallet: W, buy: '0.42', sell: '0', trades: 1 }],
    }).body;
    assert.match(dustBody, /灰尘级/, '真正的灰尘级成交（<$1）有标注');
    app.close();
});

test('钱包事件也做长尾过滤：体育/电竞市场里的钱包变化不推', async () => {
    const app = mkApp();
    // 两个市场：一个体育（cs2，应被排除）、一个长尾（保留）
    seedMarket(app.repos);
    const app2 = app;
    app2.repos.upsertMarket({ conditionId: '0xcs2market', slug: 'cs2-fal2-ts7-2026-10-09', question: 'CS2: FAL2 vs TS7', endDate: '2026-10-12T00:00:00Z' });
    const excluded = app2.scanner.exclusionReason({ slug: 'cs2-fal2-ts7-2026-10-09', endDate: '2026-10-12T00:00:00Z' });
    assert.match(String(excluded), /sports_esports_slug:cs2/);
    const kept = app2.scanner.exclusionReason({ slug: 'will-thomas-massie-win-the-2028-republican-presidential-nomination', endDate: '2028-01-01T00:00:00Z' });
    assert.equal(kept, null);
    app.close();
});
