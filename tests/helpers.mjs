/**
 * 测试公共工具：全部离线、确定性。
 * 用内存库 + 假来源，把「采集 → 账本 → 行为 → 报告」整条链路跑通。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../dist/db/Database.js';
import { Repos } from '../dist/db/repos.js';
import { loadConfig } from '../dist/config.js';
import { Collector } from '../dist/ledger/Collector.js';
import { LedgerPipeline } from '../dist/ledger/Pipeline.js';
import { AlertOutbox } from '../dist/alerts/Outbox.js';
import { Reports } from '../dist/report/Reports.js';
import { RequestBudget } from '../dist/sources/http.js';
import {
    CONTRACT_VERSION, validateActivity, validateTrades, validatePositions, validateValue, validateHolders, validateGammaMarkets,
} from '../dist/sources/contracts.js';

export const W1 = '0x1111111111111111111111111111111111111111';
export const W2 = '0x2222222222222222222222222222222222222222';
export const W3 = '0x3333333333333333333333333333333333333333';
export const CID = '0xaaaa00000000000000000000000000000000000000000000000000000000000000';
export const T_YES = '100000000000000000000000000000000000000000000000000000000000000001';
export const T_NO = '100000000000000000000000000000000000000000000000000000000000000002';
export const TOKEN = T_YES;

export function tempDbPath() { return join(mkdtempSync(join(tmpdir(), 'polysniper-test-')), 'test.sqlite'); }

export function mkConfig(over = {}) {
    const base = loadConfig();
    const cfg = {
        ...base,
        dbPath: ':memory:',
        proxyUrl: undefined,
        shadowMode: true,
        telegram: { token: '', chatIds: ['999'], enabled: false },
        ...over,
    };
    cfg.budgets = { ...base.budgets, ...(over.budgets ?? {}) };
    cfg.rules = { ...base.rules, ...(over.rules ?? {}) };
    cfg.push = { ...base.push, ...(over.push ?? {}) };
    return cfg;
}

export function ok(data, url = 'fake://x') { return { ok: true, data, status: 200, ms: 1, url }; }
export function fail(kind = 'network', error = 'boom', url = 'fake://x') { return { ok: false, kind, error, url, ms: 1 }; }

/** 假 DataApi：按钱包/市场返回预置数据，输出与真实 DataApiClient 一样经过契约规范化。
 *  未预置的调用返回可配置的失败或空（空 ≠ 失败，测试要能区分）。 */
export function fakeDataApi(spec = {}) {
    const {
        activity = {}, positions = {}, value = {}, trades = [], holders = [],
        markets = [], marketBySlug = {}, activeEvents = { data: [] },
        failActivity = null, failPositions = null, emptyActivity = false,
    } = spec;
    return {
        calls: [],
        async getActivity(w, opts = {}) {
            this.calls.push(['getActivity', w, opts.direction ?? 'DESC', opts.offset ?? 0]);
            if (failActivity) return fail(failActivity.kind ?? 'network', failActivity.error ?? 'activity failed');
            if (emptyActivity) return ok([]);
            const rows = activity[w] ?? [];
            const dir = opts.direction ?? 'DESC';
            const sorted = [...rows].sort((a, b) => (dir === 'DESC' ? b.timestamp - a.timestamp : a.timestamp - b.timestamp));
            const offset = opts.offset ?? 0;
            const limit = opts.limit ?? 500;
            return ok(validateActivity(sorted.slice(offset, offset + limit).map((r) => ({ ...r, proxyWallet: r.proxyWallet ?? w }))));
        },
        async getPositions(w) {
            this.calls.push(['getPositions', w]);
            if (failPositions) return fail(failPositions.kind ?? 'network', failPositions.error ?? 'positions failed');
            return ok(validatePositions(positions[w] ?? []));
        },
        async getValue(w) { this.calls.push(['getValue', w]); return value[w] === undefined ? ok([]) : ok(validateValue([{ user: w, value: value[w] }])); },
        async getTrades(conditionId, opts = {}) {
            this.calls.push(['getTrades', conditionId, opts.offset ?? 0]);
            const off = opts.offset ?? 0, lim = opts.limit ?? 500;
            return ok(validateTrades(trades.slice(off, off + lim).map((t) => ({ ...t, conditionId: t.conditionId ?? conditionId }))));
        },
        async getHolders(conditionId) { this.calls.push(['getHolders', conditionId]); return ok(validateHolders(holders)); },
        async getMarkets(q) { this.calls.push(['getMarkets', q]); return ok(validateGammaMarkets(markets)); },
        async getMarketBySlug(slug) { this.calls.push(['getMarketBySlug', slug]); return ok(marketBySlug[slug] ?? null); },
        async getActiveEvents(limit) { this.calls.push(['getActiveEvents', limit]); return ok(activeEvents.data ?? activeEvents); },
    };
}

export function fakeChain(spec = {}) {
    const { control = {}, fail = false } = spec;
    return {
        async readControl(address) {
            if (fail) return fail2('network', 'rpc down');
            return ok({
                address, bytecodeSize: 146, owner: control[address]?.owner ?? null,
                owners: control[address]?.owners ?? null, threshold: control[address]?.threshold ?? null,
                status: (control[address]?.owner || control[address]?.owners) ? 'verified' : 'unknown',
                reason: (control[address]?.owner || control[address]?.owners) ? undefined : '不支持 owner()/getOwners()',
                blockNumber: '0x1', checkedAt: new Date().toISOString(),
            });
        },
        async usdcBalance() { return ok('0'); },
        async getTransfers() { return ok({ count: 0, logs: [] }); },
        async blockNumber() { return ok('0x1'); },
    };
}
function fail2(kind, error) { return { ok: false, kind, error, url: 'rpc://x', ms: 1 }; }

/** 建一个离线 app（内存库 + 假来源） */
export function mkApp({ config = {}, dataApiSpec = {}, chainSpec = {} } = {}) {
    const cfg = mkConfig(config);
    const db = openDb(cfg.dbPath);
    const repos = new Repos(db);
    const budget = new RequestBudget(cfg.budgets.requestsPerCycle);
    const dataApi = fakeDataApi(dataApiSpec);
    const chain = fakeChain(chainSpec);
    const collector = new Collector({ repos, dataApi, chain, config: cfg, budget, log: () => { } });
    const sentMessages = [];
    let senderMode = 'ok';
    const outbox = new AlertOutbox(repos, cfg, async (chatId, body) => {
        if (senderMode === 'fail') return { ok: false, error: 'simulated send failure' };
        sentMessages.push({ chatId, body });
        return { ok: true, messageId: `m${sentMessages.length}` };
    }, () => { });
    const pipeline = new LedgerPipeline({ repos, collector, config: cfg, outbox, log: () => { } });
    const reports = new Reports(repos, cfg);
    return { cfg, db, repos, budget, dataApi, chain, collector, outbox, pipeline, reports, sentMessages, setSenderMode: (m) => { senderMode = m; }, close: () => db.close() };
}

/** 直接把活动写进库（模拟采集结果），避免测试依赖网络 */
export function seedActivity(repos, { wallet, tokenId, conditionId, type = 'TRADE', side, size, price, usdcSize, eventAt, txHash = '0xtx', outcome = 'Yes' }) {
    const ts = Math.floor(Date.parse(eventAt) / 1000);
    const key = `${txHash}|${type}|${tokenId}|${side ?? '-'}|${size ?? '-'}|${price ?? '-'}|${ts}|${wallet}`;
    const srId = repos.insertSourceRecord({
        source: 'test/seed', sourceKey: `seed:${key}`, syntheticKey: true, wallet, conditionId,
        payload: JSON.stringify({ seeded: true }), eventAt, observedAt: eventAt, contractVersion: CONTRACT_VERSION,
    });
    return repos.insertActivity({
        sourceRecordId: srId, activityKey: key, syntheticKey: true, wallet, type, conditionId, tokenId,
        outcomeIndex: outcome === 'Yes' ? 0 : 1, outcome, side: side ?? null, size: size ?? null, price: price ?? null,
        usdcSize: usdcSize ?? null, eventAt, observedAt: eventAt, txHash, marketSlug: 'test-market', eventSlug: 'test-event',
    });
}

export function seedPosition(repos, { wallet, tokenId = TOKEN, conditionId = CID, outcome = 'Yes', size, price, value, snapshotAt }) {
    repos.insertPositionSnapshot({
        wallet, tokenId, conditionId, outcome, size, currentValue: value ?? null, price, avgPrice: null,
        redeemable: false, completeness: 'complete', snapshotAt,
    });
}

export function seedMarket(repos, { conditionId = CID, slug = 'test-market', question = '测试市场？', negRisk = false } = {}) {
    repos.upsertMarket({ conditionId, slug, eventSlug: 'test-event', question, negRisk, closed: false, endDate: null });
    repos.upsertOutcomeToken({ tokenId: T_YES, conditionId, outcome: 'Yes', outcomeIndex: 0 });
    repos.upsertOutcomeToken({ tokenId: T_NO, conditionId, outcome: 'No', outcomeIndex: 1 });
}

export function seedWallet(repos, address, firstSeenAt = new Date(Date.now() - 86400_000).toISOString()) {
    repos.db.run('INSERT OR REPLACE INTO wallets(address, first_seen_at, last_seen_at) VALUES (?,?,?)', address.toLowerCase(), firstSeenAt, firstSeenAt);
}

export function eventTypes(repos, wallet = null) {
    const rows = wallet ? repos.eventsForWallet(wallet, 50) : repos.recentEvents(50);
    return rows.map((r) => String(r.event_type));
}
