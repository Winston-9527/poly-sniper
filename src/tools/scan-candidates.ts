import 'dotenv/config';
import { GammaClient } from '../sentinel/GammaClient.js';
import { TradeScanner, rankTrades, resolveScannerOptions } from '../sentinel/TradeScanner.js';
import { ChainAnalyzer } from '../sentinel/ChainAnalyzer.js';
import { Scorer } from '../sentinel/Scorer.js';
import { Profiler } from '../sentinel/Profiler.js';
import { AnomalyContext } from '../sentinel/types.js';

/**
 * 候选池体检工具：在真实市场上对比「旧口径（/holders 前 20 名）」与
 * 「新口径（/trades 全量成交流 + 本地粗筛 + top-K 深挖）」的覆盖率。
 *
 * 用法：
 *   node dist/tools/scan-candidates.js --slug will-the-us-invade-iran
 *   node dist/tools/scan-candidates.js --condition 0xd438...  --direction UP
 *   node dist/tools/scan-candidates.js --slug armenia-azerbaijan --topk 30 --json /tmp/out.json
 */

function arg(name: string, dflt?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
    const inline = process.argv.find(a => a.startsWith(`--${name}=`));
    return inline ? inline.split('=').slice(1).join('=') : dflt;
}

async function legacyPoolSize(conditionId: string, tokenId: string): Promise<{ holders: number; top20: number }> {
    const gamma = new GammaClient();
    const all = await gamma.getTopHolders(conditionId, tokenId, 1000);
    const top20 = await gamma.getTopHolders(conditionId, tokenId, 20);
    return { holders: all.length, top20: top20.length };
}

async function main() {
    const slug = arg('slug');
    const conditionArg = arg('condition');
    const tokenArg = arg('token');
    const direction = (arg('direction', 'UP') || 'UP').toUpperCase() as 'UP' | 'DOWN';
    const topK = parseInt(arg('topk', '') || process.env.CANDIDATE_TOP_K || '25', 10);
    const jsonOut = arg('json');

    const gamma = new GammaClient();
    let conditionId = conditionArg;
    let tokenId = tokenArg;
    let title = conditionId || tokenId || '';

    if (slug) {
        const meta = await gamma.getMarketMetadataBySlug(slug);
        if (!meta) {
            console.error(`找不到市场 slug: ${slug}`);
            process.exit(1);
        }
        conditionId = meta.conditionId;
        tokenId = meta.tokenIds[0];
        title = meta.title;
    }
    if (!conditionId && tokenId) {
        const info = await gamma.getTokenPair(tokenId);
        conditionId = info?.conditionId;
        title = info?.title || title;
    }
    if (!conditionId || !tokenId) {
        console.error('需要 --slug / --condition + --token');
        process.exit(1);
    }

    const opts = resolveScannerOptions();
    opts.topK = topK;
    const scanner = new TradeScanner(opts);
    const now = Math.floor(Date.now() / 1000);
    const ctx: AnomalyContext = {
        anomalyTokenId: tokenId,
        conditionId,
        direction,
        anomalyTs: now,
        detectedAt: Date.now(),
    };

    console.log('='.repeat(72));
    console.log(`市场: ${title}`);
    console.log(`conditionId: ${conditionId}`);
    console.log(`方向: ${direction} | 窗口: ${opts.windowHours}h | topK: ${opts.topK}`);
    console.log('='.repeat(72));

    const t0 = Date.now();
    const trades = await scanner.fetchTrades(conditionId, ctx);
    const pool = rankTrades(trades, ctx, opts.topK);
    const legacy = await legacyPoolSize(conditionId, tokenId);

    console.log(`\n[成交池] ${pool.poolTrades} 笔成交 → ${pool.poolWallets} 个唯一钱包（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    console.log(`[旧口径] /holders 前 20 名（当前总持仓者 ${legacy.holders}）`);

    const legacyAddrs = new Set((await gamma.getTopHolders(conditionId, tokenId, 20)).map(h => h.address.toLowerCase()));
    const poolAddrs = new Set(pool.candidates.map(c => c.address.toLowerCase()));
    const legacyInPool = [...legacyAddrs].filter(a => poolAddrs.has(a)).length;
    console.log(`\n[覆盖率对比]`);
    console.log(`  旧口径可见参与者: ${legacy.top20}/${legacy.holders} 个持仓者 = 大市场里 ${(legacy.top20 / Math.max(1, legacy.holders) * 100).toFixed(1)}%`);
    console.log(`  新口径候选池:     ${pool.poolWallets} 个真实成交钱包（含 Yes/No 双边）`);
    console.log(`  旧口径那 20 个钱包中，落在新池子里的: ${legacyInPool}/${legacyAddrs.size}`);

    console.log(`\n[粗筛 top-${pool.candidates.length}] (中位同向成交额 $${pool.medianAlignedNotional})`);
    console.log('排名  粗筛分  同向额      占比   提前      笔数  地址');
    pool.candidates.forEach((c, i) => {
        const f = c.features;
        const lead = f.leadSeconds > 0 ? `${(f.leadSeconds / 3600).toFixed(1)}h` : `-${(Math.abs(f.leadSeconds) / 60).toFixed(0)}m`;
        console.log(
            `${String(i + 1).padStart(3)}   ${String(f.coarseScore).padStart(5)}   `
            + `$${String(Math.round(f.alignedNotionalUsd)).padStart(9)}   `
            + `${(f.alignedRatio * 100).toFixed(0).padStart(3)}%   ${lead.padStart(7)}   `
            + `${String(f.alignedTrades).padStart(3)}   ${c.address}`
        );
    });

    // 深挖 + 打分（可选：--deep）
    if (process.argv.includes('--deep')) {
        const analyzer = new ChainAnalyzer();
        const profiler = new Profiler(gamma, analyzer, new Scorer(), scanner);
        const t1 = Date.now();
        const report = await profiler.analyzeMarket(tokenId, conditionId, 0.5, {
            direction,
            includeLowScores: true,
        });
        console.log(`\n[深挖] ${((Date.now() - t1) / 1000).toFixed(1)}s | 统计 ${JSON.stringify(report.stats)}`);
        console.log('得分  成交  新鲜  专注  同源  仓位  资金  同源键(owner/注资)         地址');
        report.results.forEach(r => {
            const b = r.breakdown;
            const key = r.profile.clusterKey
                ? `${r.profile.clusterKeySource === 'owner' ? 'O:' : 'F:'}${r.profile.clusterKey.slice(0, 14)}…`
                : '-';
            console.log(
                `${String(r.totalScore).padStart(4)}  ${String(b.tradeSignal).padStart(4)}  `
                + `${String(b.freshness).padStart(4)}  ${String(b.focus).padStart(4)}  `
                + `${String(b.correlation).padStart(4)}  ${String(b.position).padStart(4)}  `
                + `${String(b.capital).padStart(4)}  ${key.padEnd(24)} ${r.address}`
            );
        });
        analyzer.flush();
    }

    if (jsonOut) {
        const fs = await import('fs');
        fs.writeFileSync(jsonOut, JSON.stringify({
            title, conditionId, direction, windowHours: opts.windowHours,
            legacy: { holders: legacy.holders, top20: legacy.top20, top20inPool: legacyInPool },
            pool: { trades: pool.poolTrades, wallets: pool.poolWallets, medianAlignedNotional: pool.medianAlignedNotional },
            candidates: pool.candidates,
        }, null, 2));
        console.log(`\n已写出 ${jsonOut}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
