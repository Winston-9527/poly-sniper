import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyTrade, rankTrades, coarseScore } from '../dist/sentinel/TradeScanner.js';
import { Scorer } from '../dist/sentinel/Scorer.js';

const YES = 'YES_TOKEN';
const NO = 'NO_TOKEN';

function trade(over = {}) {
    return {
        proxyWallet: '0xaaa',
        side: 'BUY',
        asset: YES,
        conditionId: '0xcond',
        size: 100,
        price: 0.5,
        timestamp: 1000,
        ...over,
    };
}

const ctx = (over = {}) => ({
    anomalyTokenId: YES,
    conditionId: '0xcond',
    tokenIds: [YES, NO],
    direction: 'UP',
    anomalyTs: 2000,
    detectedAt: 0,
    ...over,
});

test('classifyTrade：同向/反向的四种组合 + 方向未知时按买入处理', () => {
    assert.equal(classifyTrade(trade(), ctx()), 'aligned');                                   // UP + 买 Yes
    assert.equal(classifyTrade(trade({ side: 'SELL' }), ctx()), 'opposed');                    // UP + 卖 Yes
    assert.equal(classifyTrade(trade({ asset: NO }), ctx()), 'opposed');                       // UP + 买 No
    assert.equal(classifyTrade(trade({ asset: NO, side: 'SELL' }), ctx()), 'aligned');         // UP + 卖 No
    assert.equal(classifyTrade(trade({ side: 'SELL' }), ctx({ direction: 'DOWN' })), 'aligned');
    assert.equal(classifyTrade(trade(), ctx({ direction: undefined })), 'aligned');
    assert.equal(classifyTrade(trade({ side: 'SELL' }), ctx({ direction: undefined })), 'opposed');
});

test('rankTrades：同向成交额/占比/提前秒数/双边判定', () => {
    const trades = [
        trade({ proxyWallet: '0xalice', size: 1000, price: 0.5, timestamp: 1500 }), // $500 同向，异动前 500s
        trade({ proxyWallet: '0xalice', side: 'SELL', size: 100, price: 0.5, timestamp: 1600 }), // $50 反向
        trade({ proxyWallet: '0xbob', asset: NO, size: 200, price: 0.5, timestamp: 1900 }), // 反向 $100
        trade({ proxyWallet: '0xcarol', size: 100, price: 0.5, timestamp: 2100 }), // 异动后追 $50
    ];
    const pool = rankTrades(trades, ctx(), 10);
    assert.equal(pool.poolWallets, 3);
    assert.equal(pool.poolTrades, 4);

    const alice = pool.candidates.find(c => c.address === '0xalice').features;
    assert.equal(alice.alignedNotionalUsd, 500);
    assert.equal(alice.opposingNotionalUsd, 50);
    assert.equal(alice.alignedTrades, 1);
    assert.equal(alice.leadSeconds, 500);
    assert.equal(alice.alignedRatio, round4(500 / 550));
    assert.equal(alice.isSingleMarketWallet, true);
    assert.equal(alice.side, 'YES'); // 同一 token 上既买又卖 → 仍是单边 token

    // 同时出现在 Yes / No 两边的钱包记为 BOTH
    const both = rankTrades([
        trade({ proxyWallet: '0xdave', size: 10 }),
        trade({ proxyWallet: '0xdave', asset: NO, side: 'SELL', size: 10 }),
    ], ctx(), 5);
    assert.equal(both.candidates[0].features.side, 'BOTH');

    const carol = pool.candidates.find(c => c.address === '0xcarol').features;
    assert.ok(carol.leadSeconds < 0, '异动后成交的 leadSeconds 应为负');
    assert.equal(carol.side, 'YES');

    // 排序：方向一致 + 提前 + 金额大 的 alice 应该排在只有反向成交的 bob 前面
    assert.equal(pool.candidates[0].address, '0xalice');
    assert.ok(pool.candidates.findIndex(c => c.address === '0xbob') > 0);
    assert.ok(pool.candidates[0].features.coarseScore > pool.candidates[2].features.coarseScore);
});

test('coarseScore：早进场的大额同向单打满方向/时点，迟到的反向单接近 0', () => {
    const early = {
        trades: 3, notionalUsd: 30000, alignedNotionalUsd: 30000, alignedTrades: 3, alignedRatio: 1,
        opposingNotionalUsd: 0, relativeAlignedSize: 1000, firstTradeTs: 100, lastTradeTs: 900, leadSeconds: 60,
        side: 'YES', isSingleMarketWallet: true, coarseScore: 0, reasons: [],
    };
    const late = {
        trades: 1, notionalUsd: 10, alignedNotionalUsd: 0, alignedTrades: 0, alignedRatio: 0,
        opposingNotionalUsd: 10, relativeAlignedSize: 0, firstTradeTs: 2100, lastTradeTs: 2100, leadSeconds: -100,
        side: 'NO', isSingleMarketWallet: false, coarseScore: 0, reasons: [],
    };
    const a = coarseScore(early).score;
    const b = coarseScore(late).score;
    assert.ok(a >= 75, `贴着异动进场的超大额同向单应 ≥75，实际 ${a}`);
    assert.ok(b <= 5, `迟到的反向小单应 ≤5，实际 ${b}`);

    // 两面下注（反向额 >= 同向额）会被打折
    const hedger = { ...early, alignedNotionalUsd: 1000, opposingNotionalUsd: 5000, alignedRatio: 0.17, relativeAlignedSize: 20 };
    assert.ok(coarseScore(hedger).score < coarseScore(early).score / 2);
});

test('Scorer：成交行为维度权重最高，且未知年龄不再白送新鲜度分', () => {
    const scorer = new Scorer();
    const now = Math.floor(Date.now() / 1000);
    const features = {
        trades: 2, notionalUsd: 20000, alignedNotionalUsd: 20000, alignedTrades: 2, alignedRatio: 1,
        opposingNotionalUsd: 0, relativeAlignedSize: 50, firstTradeTs: now - 600, lastTradeTs: now - 100,
        leadSeconds: 3600, side: 'YES', isSingleMarketWallet: true, coarseScore: 0, reasons: ['同向成交占比 100%'],
    };

    const fresh = scorer.score({
        address: '0xfresh', transactionCount: 2, usdcBalance: 60000, marketCount: 1,
        eventCount: 1, isNew: true, firstActivityTs: now - 3600,
        clusterKey: '0xfunder', clusterKeySource: 'owner', fundingClusterSize: 1,
    }, 20000, { isCorrelated: true, features });

    // 成交行为 = round(coarse * 0.30)，保持「排序依据」与「报告分数」同源
    assert.equal(fresh.breakdown.tradeSignal, Math.round(coarseScore(features).score * 0.30));
    assert.equal(fresh.breakdown.correlation, 15);
    assert.equal(fresh.breakdown.freshness, 20);
    assert.equal(fresh.breakdown.focus, 15);
    assert.ok(fresh.totalScore > 60);

    // 关键回归：没有首次活动时间时，不再因为「合约 nonce 恒为 0」而拿到新鲜度分
    const unknownAge = scorer.score({
        address: '0xold', transactionCount: 0, usdcBalance: 0, marketCount: 0, isNew: false,
    }, 0, { features });
    assert.equal(unknownAge.breakdown.freshness, 0);
    assert.equal(unknownAge.breakdown.focus, 0);
    assert.equal(unknownAge.breakdown.correlation, 0);

    // 没有同源注资时不加 correlation 分
    const noFunder = scorer.score({
        address: '0xnf', transactionCount: 0, usdcBalance: 0, marketCount: 1, eventCount: 1, isNew: false,
        firstActivityTs: now - 3600,
    }, 0, { features, isCorrelated: true });
    assert.equal(noFunder.breakdown.correlation, 0);
});

test('escapeHtml：Telegram HTML 模式的转义', async () => {
    const { escapeHtml } = await import('../dist/sentinel/TelegramMessenger.js');
    assert.equal(escapeHtml('a<b>&"c"'), 'a&lt;b&gt;&amp;"c"');
});

function round4(x) {
    return Math.round(x * 10000) / 10000;
}
