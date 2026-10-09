#!/usr/bin/env node
/**
 * P0 契约核验（只读）：对真实来源做小规模探测，产出
 *   - tests/fixtures/contracts/*.json   脱敏后的响应样例（供契约测试）
 *   - docs/contract-report.md           人类可读的核验结论与缺口清单
 *
 * 只发 GET，不发消息、不写业务库。用法：node tools/probe-contracts.mjs [--market <slug|conditionId>]
 * 代理：沿用 .env 的 HTTPS_PROXY（本机直连 Polymarket 会超时）。
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetch, ProxyAgent } from 'undici';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'tests/fixtures/contracts');
mkdirSync(FIX, { recursive: true });

// --- .env（只读，不打印密钥）---
function loadEnv() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const env = { ...loadEnv(), ...process.env };
const PROXY = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY;
const dispatcher = PROXY ? new ProxyAgent(PROXY) : undefined;
const RPC = env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA = 'https://data-api.polymarket.com';

const notes = [];
const note = (s) => { notes.push(s); console.log(s); };

async function getJson(url, timeoutMs = 25000) {
  const t0 = Date.now();
  const res = await fetch(url, { dispatcher, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { __nonjson: text.slice(0, 200) }; }
  return { status: res.status, ok: res.ok, ms: Date.now() - t0, body, headers: Object.fromEntries(res.headers) };
}

// --- 脱敏：保留形状（0x+40 hex、长度、大小写风格），不保留真实身份 ---
let counter = 0;
const map = new Map();
function hashStr(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function fakeHex(s, len, prefix = '0x') {
  const h = hashStr(String(s));
  let out = '';
  let x = h || 1;
  while (out.length < len) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; out += x.toString(16).padStart(8, '0'); }
  out = out.slice(0, len);
  // 模仿真实地址的混合大小写（EIP-55 风格），保持长度与字符集一致
  if (prefix === '0x' && len === 40) out = out.split('').map((c, i) => (parseInt(out[i], 16) > 7 && i % 2 === 0 ? c.toUpperCase() : c)).join('');
  return prefix + out;
}
function san(v, key = '') {
  if (typeof v === 'string') {
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) { if (!map.has(v)) map.set(v, fakeHex(v, 40)); return map.get(v); }
    if (/^0x[0-9a-fA-F]{64}$/.test(v)) { if (!map.has(v)) map.set(v, fakeHex(v, 64)); return map.get(v); }
    if (/^\d{10,13}$/.test(v) && /hash|token|asset|id|Id/.test(key) === false && key === '') return v;
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => san(x, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      // 脱敏身份类字段；token/condition id 保留（公开市场标识，非个人信息）
      if (/^(proxyWallet|userAddress|address|from|to|maker|taker|name|pseudonym|bio|profileImage|profileImageOptimized)$/.test(k) && typeof val === 'string') {
        o[k] = /^0x/.test(val) ? san(val) : (val ? `«user-${++counter}»` : val);
      } else if (/transactionHash|txHash/.test(k) && typeof val === 'string') o[k] = san(val);
      else o[k] = san(val, k);
    }
    return o;
  }
  return v;
}
const keysOf = (arr) => [...new Set((arr || []).flatMap((x) => Object.keys(x || {})))].sort();

const report = { generatedAt: new Date().toISOString(), proxy: PROXY ? 'set' : 'unset', checks: [] };
function record(name, data) { report.checks.push({ name, ...data }); }
writeFix('_meta.json', { generatedAt: report.generatedAt, proxyUsed: !!PROXY });
function writeFix(name, obj) { writeFileSync(join(FIX, name), JSON.stringify(obj, null, 2)); }

// ============ 1. 目标市场 ============
const argSlug = process.argv.indexOf('--market');
let target = argSlug > -1 ? process.argv[argSlug + 1] : null;
let gammaMarket = null;

if (!target) {
  const r = await getJson(`${GAMMA}/events?limit=5&active=true&closed=false&order=volume24hr&ascending=false`);
  const ev = (r.body || [])[0];
  target = ev?.slug;
  note(`[1] 取热门 event: ${ev?.slug} | ${ev?.title}`);
}
{
  const r = await getJson(`${GAMMA}/events?slug=${encodeURIComponent(target)}`);
  const ev = Array.isArray(r.body) ? r.body[0] : null;
  gammaMarket = ev?.markets?.[0] || null;
  if (!gammaMarket) {
    const r2 = await getJson(`${GAMMA}/markets?slug=${encodeURIComponent(target)}`);
    gammaMarket = Array.isArray(r2.body) ? r2.body[0] : null;
  }
  const m = gammaMarket || {};
  const keys = Object.keys(m).sort();
  record('gamma_market', { slug: target, httpStatus: r.status, ms: r.ms, fields: keys.length, hasClobTokenIds: !!m.clobTokenIds });
  note(`[1] Gamma market 字段数=${keys.length}；clobTokenIds=${m.clobTokenIds ? '有' : '无'}；outcomes=${m.outcomes}；negRisk=${m.negRisk}`);
  note(`    关键字段: ${['id', 'conditionId', 'question', 'slug', 'clobTokenIds', 'outcomes', 'outcomePrices', 'liquidity', 'volume24hr', 'closed', 'endDate', 'negRisk', 'umaResolutionStatus'].filter((k) => k in m).join(', ')}`);
  writeFix('gamma_market.json', san(m));
}

const conditionId = gammaMarket?.conditionId;
const tokenIds = gammaMarket?.clobTokenIds ? JSON.parse(gammaMarket.clobTokenIds) : [];
const outcomes = gammaMarket?.outcomes ? JSON.parse(gammaMarket.outcomes) : [];
note(`[1] conditionId=${conditionId} tokens=${tokenIds.length} outcomes=${JSON.stringify(outcomes)}`);

// ============ 2. /holders ============
let sampleWallet = null;
for (const limit of [20, 100, 500]) {
  const r = await getJson(`${DATA}/holders?market=${conditionId}&limit=${limit}`);
  const groups = Array.isArray(r.body) ? r.body : [];
  const g0 = groups[0] || {};
  const holders = g0.holders || [];
  record(`holders_limit_${limit}`, { httpStatus: r.status, ms: r.ms, groups: groups.length, groupKeys: Object.keys(g0).sort(), returned: holders.length, holderKeys: keysOf(holders) });
  note(`[2] /holders limit=${limit} → HTTP ${r.status}，返回 ${holders.length} 条；分组字段=${Object.keys(g0).join(',')}；holder 字段=${keysOf(holders).join(',')}`);
  if (limit === 100) writeFix('holders.json', san(r.body));
  if (holders.length && !sampleWallet) sampleWallet = holders[0].proxyWallet || holders[0].userAddress;
}

// ============ 3. /trades ============
{
  const pages = [];
  let distinctTx = new Set(), wallets = new Set(), ids = new Set();
  for (const offset of [0, 500, 1000, 2500, 3000]) {
    const r = await getJson(`${DATA}/trades?market=${conditionId}&limit=500&offset=${offset}`);
    const rows = Array.isArray(r.body) ? r.body : [];
    pages.push({ offset, status: r.status, n: rows.length });
    if (offset === 0) {
      record('trades_page0', { httpStatus: r.status, ms: r.ms, n: rows.length, fields: keysOf(rows), sample: san(rows[0] || {}) });
      note(`[3] /trades 字段=${keysOf(rows).join(',')}`);
      note(`    sample=${JSON.stringify(san(rows[0] || {})).slice(0, 400)}`);
      writeFix('trades.json', san({ market: conditionId, rows: rows.slice(0, 60) }));
    }
    for (const t of rows) {
      wallets.add(t.proxyWallet || t.userAddress);
      if (t.transactionHash) distinctTx.add(t.transactionHash);
      for (const k of ['id', 'tradeId', 'timestamp', 'transactionHash', 'outcomeIndex']) ids.add(k);
    }
    if (rows.length < 500) break;
  }
  record('trades_pagination', { pages, uniqueWallets: wallets.size, uniqueTx: distinctTx.size });
  note(`[3] /trades 分页: ${pages.map((p) => `${p.offset}:${p.n}`).join(' ')}；唯一钱包=${wallets.size}；事务哈希=${distinctTx.size}`);
  note(`[3] 去重键候选字段存在性: ${[...ids].join(',')}`);
}

// ============ 4. /activity（含非成交类型） ============
if (sampleWallet) {
  for (const dir of ['ASC', 'DESC']) {
    const r = await getJson(`${DATA}/activity?user=${sampleWallet}&limit=500&sortBy=TIMESTAMP&sortDirection=${dir}`);
    const rows = Array.isArray(r.body) ? r.body : [];
    const types = {};
    for (const a of rows) types[a.type] = (types[a.type] || 0) + 1;
    record(`activity_${dir}`, { httpStatus: r.status, ms: r.ms, n: rows.length, types, fields: keysOf(rows) });
    note(`[4] /activity ${dir} → ${rows.length} 条；type 分布=${JSON.stringify(types)}`);
    if (dir === 'ASC') {
      note(`[4] activity 字段=${keysOf(rows).join(',')}`);
      writeFix('activity.json', san({ user: sampleWallet, rows: rows.slice(0, 40) }));
      note(`[4] 首笔活动 timestamp=${rows[0]?.timestamp} type=${rows[0]?.type} tx=${String(rows[0]?.transactionHash).slice(0, 12)}…`);
    }
  }
}

// ============ 5. /positions /value ============
if (sampleWallet) {
  const r = await getJson(`${DATA}/positions?user=${sampleWallet}&limit=100&sortBy=CURRENT&sortDirection=DESC`);
  const rows = Array.isArray(r.body) ? r.body : [];
  record('positions', { httpStatus: r.status, ms: r.ms, n: rows.length, fields: keysOf(rows), sample: san(rows[0] || {}) });
  note(`[5] /positions → ${rows.length} 条；字段=${keysOf(rows).join(',')}`);
  note(`    sample=${JSON.stringify(san(rows[0] || {})).slice(0, 400)}`);
  writeFix('positions.json', san({ user: sampleWallet, rows: rows.slice(0, 20) }));

  const v = await getJson(`${DATA}/value?user=${sampleWallet}`);
  record('value', { httpStatus: v.status, ms: v.ms, body: san(v.body) });
  note(`[5] /value → ${JSON.stringify(san(v.body)).slice(0, 200)}`);
  writeFix('value.json', san(v.body));
}

// ============ 6. 链上：owner / getOwners / USDC ============
async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), dispatcher, signal: AbortSignal.timeout(20000) });
  return r.json();
}
{
  const sample = [];
  const r = await getJson(`${DATA}/holders?market=${conditionId}&limit=20`);
  const hs = (Array.isArray(r.body) ? r.body : []).flatMap((g) => g.holders || []).slice(0, 8);
  for (const h of hs) {
    const addr = h.proxyWallet || h.userAddress;
    const code = (await rpc('eth_getCode', [addr, 'latest']))?.result || '0x';
    const call = async (data) => {
      const res = await rpc('eth_call', [{ to: addr, data }, 'latest']);
      return res.error ? { error: res.error.message } : { result: res.result };
    };
    const ownerSel = '0x8da5cb5b';        // owner()
    const getOwnersSel = '0xa0e67e2b';    // getOwners()
    const thresholdSel = '0xe75235b8';    // getThreshold()
    const o = await call(ownerSel);
    const os = await call(getOwnersSel);
    const th = await call(thresholdSel);
    const parseWords = (hex) => {
      if (!hex || hex === '0x') return [];
      const body = hex.slice(2);
      const out = [];
      for (let i = 0; i < body.length; i += 64) out.push('0x' + body.slice(i + 24, i + 64));
      return out;
    };
    const isErr = (x) => !x || !!x.error || !x.result || x.result === '0x';
    sample.push({
      codeLen: (code.length - 2) / 2,
      owner: isErr(o) ? { unsupported: o?.error ? o.error.slice(0, 40) : 'empty' } : { addr: '0x' + o.result.slice(-40) },
      getOwners: isErr(os) ? { unsupported: os?.error ? os.error.slice(0, 40) : 'empty' } : { n: parseWords(os.result).length, addresses: parseWords(os.result).length },
      threshold: isErr(th) ? { unsupported: th?.error ? th.error.slice(0, 40) : 'empty' } : { value: parseInt(th.result, 16) },
    });
  }
  record('chain_owner_probe', { n: sample.length, sample });
  note(`[6] 链上 owner 探测 ${sample.length} 个代理钱包：`);
  for (const s of sample) note(`    codeLen=${s.codeLen} owner=${JSON.stringify(s.owner)} getOwners=${JSON.stringify(s.getOwners)} threshold=${JSON.stringify(s.threshold)}`);
  writeFix('chain_owner.json', sample);

  // USDC 1000 区块内 Transfer 日志（topic2=收款人），只做可得性核验
  const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  const head = parseInt((await rpc('eth_blockNumber', []))?.result, 16);
  const logs = await rpc('eth_getLogs', [{
    fromBlock: '0x' + (head - 999).toString(16), toBlock: '0x' + head.toString(16),
    address: USDC, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
  }]);
  const n = Array.isArray(logs.result) ? logs.result.length : 0;
  record('usdc_getLogs', { ok: Array.isArray(logs.result), n, error: logs.error?.message });
  note(`[6] USDC Transfer 日志（最近 1000 区块）→ ${Array.isArray(logs.result) ? n + ' 条' : '失败: ' + logs.error?.message}`);
}

// ============ 7. 参数边界 ============
{
  const r = await getJson(`${DATA}/trades?market=${conditionId}&limit=1000`);
  const n = Array.isArray(r.body) ? r.body.length : 0;
  record('trades_limit_cap', { requested: 1000, returned: n, httpStatus: r.status });
  note(`[7] /trades limit=1000 → 实际返回 ${n}（>500 说明上限不是 500）`);
}

writeFix('_meta.json', { generatedAt: report.generatedAt, proxyUsed: !!PROXY, market: target, conditionId });
writeFileSync(join(ROOT, 'tests/fixtures/contracts/_report.json'), JSON.stringify(report, null, 2));
console.log(`\n[完成] 样例 → tests/fixtures/contracts/ ；报告 → tests/fixtures/contracts/_report.json`);
