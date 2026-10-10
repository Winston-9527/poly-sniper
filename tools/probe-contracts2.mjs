#!/usr/bin/env node
/**
 * P0 契约核验 第二轮：深挖分页/去重键/maker-taker 覆盖/非成交活动类型/链上日志可得性。
 * 只读。用法 node tools/probe-contracts2.mjs
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetch, ProxyAgent } from 'undici';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'tests/fixtures/contracts');
mkdirSync(FIX, { recursive: true });
function loadEnv() {
  const p = join(ROOT, '.env'); if (!existsSync(p)) return {};
  const out = {};
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l);
    if (m && !l.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const env = { ...loadEnv(), ...process.env };
const PROXY = env.https_proxy || env.HTTPS_PROXY;
const dispatcher = PROXY ? new ProxyAgent(PROXY) : undefined;
const GAMMA = 'https://gamma-api.polymarket.com', DATA = 'https://data-api.polymarket.com';
const out = {};
async function gj(url, t = 25000) {
  const r = await fetch(url, { dispatcher, signal: AbortSignal.timeout(t) });
  const txt = await r.text();
  let b; try { b = JSON.parse(txt); } catch { b = { __nonjson: txt.slice(0, 200) }; }
  return { status: r.status, body: b };
}
const log = (s) => console.log(s);

// 目标市场：一个有 negRisk 的热门市场 + 一个老市场
const ev = (await gj(`${GAMMA}/events?limit=3&active=true&order=volume24hr&ascending=false`)).body[0];
const m = ev.markets[0];
const CID = m.conditionId;
log(`市场: ${m.question} (negRisk=${m.negRisk})`);
out.market = { slug: m.slug, conditionId: CID, negRisk: m.negRisk };

// ---- A. /holders 上限 ----
for (const lim of [600, 1000]) {
  const r = await gj(`${DATA}/holders?market=${CID}&limit=${lim}`);
  const n = Array.isArray(r.body) ? (r.body[0]?.holders?.length ?? 0) : -1;
  log(`[A] /holders limit=${lim} → HTTP ${r.status} 返回 ${n}`);
  out[`holders_${lim}`] = n;
}

// ---- B. /trades：takerOnly、上限、offset 稳定性与重叠 ----
const url = (q) => `${DATA}/trades?market=${CID}&limit=500&offset=${q}`;
const t0 = (await gj(url(0))).body;
log(`[B] /trades?takerOnly 默认 → ${t0.length} 行；字段=${Object.keys(t0[0]).join(',')}`);
const tMaker = (await gj(`${DATA}/trades?market=${CID}&limit=500&takerOnly=false`)).body;
log(`[B] takerOnly=false → ${tMaker.length} 行`);
const mk = (x) => `${x.transactionHash}|${x.asset}|${x.side}|${x.size}|${x.price}|${x.timestamp}|${x.proxyWallet}`;
const s1 = new Set(t0.map(mk)), s2 = new Set(tMaker.map(mk));
const overlap = [...s2].filter((k) => s1.has(k)).length;
log(`[B] takerOnly=true 与 false 的合成键重合 ${overlap}/${s2.length}（false 是否包含 maker 行）`);
const tradKeys = new Set(t0.map(mk));
const dupInPage = t0.length - tradKeys.size;
log(`[B] 单页内合成键唯一性: ${tradKeys.size}/${t0.length}（页内重复 ${dupInPage}）`);
// 分页重叠：同一合成键出现在相邻页 = 翻页期间数据在变
const p0 = t0.map(mk), p1 = (await gj(url(500))).body.map(mk), p2 = (await gj(url(1000))).body.map(mk);
const ov01 = p0.filter((k) => p1.includes(k)).length, ov12 = p1.filter((k) => p2.includes(k)).length;
log(`[B] 相邻页合成键重叠 page0∩page1=${ov01} page1∩page2=${ov12}`);
out.trades = { page0: t0.length, takerOnlyFalse: tMaker.length, keyOverlapTakerOnly: overlap, dupInPage, ov01, ov12, fields: Object.keys(t0[0]) };
// 唯一键候选中，是否有 id 字段
log(`[B] 是否含稳定成交 ID: ${['id', 'tradeId', 'orderId', 'takerOrderHash', 'makerOrderHash'].filter((k) => k in (t0[0] || {})).join(',') || '无'}`);
// 时间排序方向
const ts = t0.map((x) => x.timestamp);
log(`[B] 页内时间有序: 降序=${ts.every((v, i) => i === 0 || ts[i - 1] >= v)} 升序=${ts.every((v, i) => i === 0 || ts[i - 1] <= v)}  最新=${new Date(ts[0] * 1000).toISOString()}`);
out.trades.timeOrder = ts.every((v, i) => i === 0 || ts[i - 1] >= v) ? 'desc' : 'asc';
// 上限
const big = (await gj(`${DATA}/trades?market=${CID}&limit=2000`)).body;
log(`[B] limit=2000 → ${Array.isArray(big) ? big.length : 'err'}`);
out.trades.limit2000 = Array.isArray(big) ? big.length : -1;

// ---- C. 非成交活动类型枚举（多钱包）----
const wallets = [...new Set([...t0.map((x) => x.proxyWallet), ...((await gj(`${DATA}/holders?market=${CID}&limit=100`)).body || []).flatMap((g) => (g.holders || []).map((h) => h.proxyWallet))])].slice(0, 25);
const types = {}; const fieldByType = {};
let ascFirst = [];
for (const w of wallets) {
  const r = await gj(`${DATA}/activity?user=${w}&limit=500&sortBy=TIMESTAMP&sortDirection=ASC`);
  if (!Array.isArray(r.body)) continue;
  if (r.body[0]) ascFirst.push({ w, ts: r.body[0].timestamp, type: r.body[0].type });
  for (const a of r.body) {
    types[a.type] = (types[a.type] || 0) + 1;
    if (!fieldByType[a.type]) fieldByType[a.type] = Object.keys(a).sort();
  }
}
log(`[C] ${wallets.length} 个钱包活动类型分布: ${JSON.stringify(types)}`);
log(`[C] 每种类型的字段: ${JSON.stringify(Object.fromEntries(Object.entries(fieldByType).map(([k, v]) => [k, v.join(',')])))}`);
out.activity = { wallets: wallets.length, types, fieldByType };
// 同一钱包 ASC 是否拿到真实首笔（与 DESC 最后一页比较）
if (ascFirst[0]) {
  const w = ascFirst[0].w;
  const asc = (await gj(`${DATA}/activity?user=${w}&limit=500&sortBy=TIMESTAMP&sortDirection=ASC`)).body;
  const desc = (await gj(`${DATA}/activity?user=${w}&limit=500&sortBy=TIMESTAMP&sortDirection=DESC`)).body;
  const lastDesc = desc[desc.length - 1];
  log(`[C] ASC 首条 ts=${asc[0]?.timestamp} / DESC 末条 ts=${lastDesc?.timestamp}（相当接近说明 ASC 已到最早）`);
  out.activity.ascVsDesc = { wallet: w, ascFirst: asc[0]?.timestamp, descLast: lastDesc?.timestamp, descFirst: desc[0]?.timestamp };
}

// ---- D. 链上：多 RPC 的 getLogs / owner / 余额 可得性 ----
const RPCS = [
  env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.llamarpc.com',
  'https://polygon.drpc.org',
  'https://1rpc.io/matic',
  'https://polygon-rpc.com',
];
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const rpcResults = {};
for (const url of RPCS) {
  const res = { url };
  try {
    const call = async (method, params) => {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), dispatcher, signal: AbortSignal.timeout(12000) });
      return r.json();
    };
    const bn = (await call('eth_blockNumber', [])).result;
    res.blockNumber = bn;
    res.chainId = parseInt((await call('eth_chainId', [])).result, 16);
    const head = parseInt(bn, 16);
    const lg = await call('eth_getLogs', [{ fromBlock: '0x' + (head - 50).toString(16), toBlock: '0x' + head.toString(16), address: USDC, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'] }]);
    res.getLogsRecent = Array.isArray(lg.result) ? lg.result.length : `ERR:${(lg.error?.message || '').slice(0, 60)}`;
    const lg2 = await call('eth_getLogs', [{ fromBlock: '0x' + (head - 100000).toString(16), toBlock: '0x' + (head - 99950).toString(16), address: USDC, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'] }]);
    res.getLogsOld100k = Array.isArray(lg2.result) ? lg2.result.length : `ERR:${(lg2.error?.message || '').slice(0, 60)}`;
    const bal = await call('eth_call', [{ to: USDC, data: '0x70a08231' + '0'.repeat(24) + wallets[0].slice(2) }, 'latest']);
    res.usdcBalance = bal.result ? parseInt(bal.result, 16) / 1e6 : 'ERR';
    const own = await call('eth_call', [{ to: wallets[0], data: '0x8da5cb5b' }, 'latest']);
    res.owner = own.result && own.result !== '0x' ? '0x' + own.result.slice(-40) : `ERR:${(own.error?.message || 'empty').slice(0, 40)}`;
  } catch (e) { res.error = String(e.message).slice(0, 80); }
  rpcResults[url] = res;
  log(`[D] ${url}\n    chainId=${res.chainId} getLogs(近50区块)=${res.getLogsRecent} getLogs(10万前)=${res.getLogsOld100k} usdcBal=${res.usdcBalance} owner=${res.owner}`);
}
out.rpc = rpcResults;
writeFileSync(join(FIX, '_report2.json'), JSON.stringify(out, null, 2));
log(`\n[完成] → tests/fixtures/contracts/_report2.json`);
