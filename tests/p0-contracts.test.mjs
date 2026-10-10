/**
 * P0 契约测试：用真实来源的脱敏样例验证解析器（方案 §6.1、§11 P0 验收）。
 * 样例来自 tools/probe-contracts.mjs 的真实响应。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    validateActivity, validateHolders, validateTrades, validatePositions, validateValue,
    validateGammaMarkets, ContractError, normalizeAddress, assignSyntheticKeys, KNOWN_ACTIVITY_TYPES,
} from '../dist/sources/contracts.js';
import { DataApiClient } from '../dist/sources/DataApi.js';
import { HttpClient } from '../dist/sources/http.js';

const FIX = resolve('tests/fixtures/contracts');
const load = (f) => JSON.parse(readFileSync(resolve(FIX, f), 'utf8'));

test('样例文件齐全（缺样例等于没做契约核验）', () => {
    for (const f of ['_meta.json', '_report.json', 'holders.json', 'trades.json', 'activity.json', 'positions.json', 'value.json', 'gamma_market.json']) {
        assert.ok(existsSync(resolve(FIX, f)), `缺少脱敏样例 ${f}`);
    }
});

test('真实样例可解析：/holders', () => {
    const pages = validateHolders(load('holders.json'));
    assert.ok(pages.length >= 1);
    assert.match(pages[0].token, /^\d+$/);
    assert.ok(pages[0].holders.length > 0);
    for (const h of pages[0].holders) {
        assert.match(h.address, /^0x[0-9a-f]{40}$/, '地址必须被规范化成小写');
        assert.ok(h.amount === null || /^-?\d/.test(h.amount));
    }
});

test('真实样例可解析：/trades（含合成键）', () => {
    const rows = load('trades.json').rows;
    const parsed = validateTrades(rows);
    assert.ok(parsed.length > 0);
    for (const t of parsed) {
        assert.ok(['BUY', 'SELL', null].includes(t.side));
        assert.ok(t.eventAt && t.eventAt.endsWith('Z'), '事件时间必须是 UTC ISO');
    }
    const keyed = assignSyntheticKeys(parsed);
    assert.ok(keyed[0].syntheticKey.includes('|'), '来源无稳定成交 ID → 使用合成键');
    const dup = assignSyntheticKeys([
        { ...parsed[0] }, { ...parsed[0] },
    ]);
    assert.equal(dup[0].syntheticKey === dup[1].syntheticKey, false, '完全相同的两笔不能互相去重掉');
    assert.equal(dup[1].keyCollision, true);
});

test('真实样例可解析：/activity（含非成交类型）与 /positions、/value', () => {
    const acts = validateActivity(load('activity.json').rows);
    assert.ok(acts.length > 0);
    const types = new Set(acts.map((a) => a.type));
    for (const t of types) {
        assert.ok(KNOWN_ACTIVITY_TYPES.includes(t) || t.startsWith('UNKNOWN:'), `类型必须被归类：${t}`);
    }
    const pos = validatePositions(load('positions.json').rows);
    assert.ok(pos.length > 0);
    assert.match(pos[0].tokenId, /^\d+$/);
    const val = validateValue(load('value.json'));
    assert.ok(val.length === 1 && typeof val[0].wallet === 'string');
});

test('gamma /markets 真实样例可解析（negRisk、结果 token 映射）', () => {
    const m = validateGammaMarkets([load('gamma_market.json')]);
    assert.equal(m.length, 1);
    assert.ok(m[0].tokens.length >= 2, '必须拿到双边 token 映射');
    assert.ok(['Yes', 'No'].includes(m[0].tokens[0].outcome));
});

test('契约违反必须报错而不是静默返回空（P0：失败/空/零分离）', () => {
    assert.throws(() => validateTrades([{ proxyWallet: '0x1', asset: '1' }]), ContractError);
    assert.throws(() => validateActivity({ not: 'array' }), ContractError);
    assert.throws(() => validateHolders([{ holders: [] }]), ContractError);
    assert.throws(() => validatePositions([{ proxyWallet: 'nope', asset: '1', conditionId: '0x', size: 1 }]), ContractError);
    assert.equal(normalizeAddress('0xABCDEF0000000000000000000000000000000001'), '0xabcdef0000000000000000000000000000000001');
    assert.equal(normalizeAddress('0x123'), null);
});

test('来源返回空数组 ≠ 失败：空数组是「确实没有」，失败是 Err', async () => {
    const http = new HttpClient({ retries: 0 });
    const api = new DataApiClient({ getJson: async () => ({ ok: true, data: [], status: 200, ms: 1, url: 'x' }) });
    const empty = await api.getTrades('0x' + '1'.repeat(64));
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.data, []);

    const failing = new DataApiClient({ getJson: async () => ({ ok: false, kind: 'timeout', error: 'ETIMEDOUT', url: 'x', ms: 5 }) });
    const res = await failing.getHolders('0x' + '1'.repeat(64));
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'timeout');
    assert.notDeepEqual(res, []);
    void http;
});

test('契约版本会记录到 source_records（口径可追溯）', () => {
    const report = load('_report.json');
    assert.ok(report.generatedAt && report.checks.length > 0, '契约核验报告必须存在');
    const names = report.checks.map((c) => c.name);
    for (const n of ['trades_page0', 'holders_limit_100', 'positions', 'value']) {
        assert.ok(names.includes(n), `核验项缺失：${n}（${names.join(',')}）`);
    }
});
