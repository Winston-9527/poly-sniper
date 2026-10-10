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
    assert.match(rep.body, /\$12000/);
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

test('配置默认值可用（异动阈值来自配置，可调）', () => {
    const app = mkApp();
    const r = anomalyRulesFromConfig(app.cfg);
    assert.equal(r.priceMove, 0.05);
    assert.equal(r.volumeSurge, 3);
    assert.ok(r.minVolume24h > 0);
    app.close();
});
