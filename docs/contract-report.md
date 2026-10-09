# 来源契约核验报告（P0）

生成方式：`node tools/probe-contracts.mjs` 与 `node tools/probe-contracts2.mjs`（只读 GET/POST，不发消息、不写业务库）。
脱敏后的响应样例与逐项结论保存在 `tests/fixtures/contracts/`（`_report.json`、`_report2.json` 及各端点样例），
契约测试 `tests/p0-contracts.test.mjs` 直接读这些样本来验证解析器。

核验时间：2026-10-09（Asia/Shanghai）。契约版本号：`data-api-2026-10-09`（写入 `source_records.contract_version`）。

## 1. 任何一处结论都附带核验方式

| 来源 | 端点 | 实测结论 |
| --- | --- | --- |
| data-api | `/holders?market=<conditionId>&limit=N` | 返回 `[{ token, holders: [...] }]`，holder 字段：`proxyWallet, amount, outcomeIndex, asset, name, pseudonym, bio, verified, profileImage, profileImageOptimized, displayUsernamePublic`。`limit=500` 返回 500 → 上限 ≥500；返回条数小于 limit 时表示该市场只有这么多持仓者。 |
| data-api | `/trades?market=<conditionId>&limit=N&offset=M` | 扁平数组。字段：`proxyWallet, side, asset, conditionId, size, price, timestamp, transactionHash, outcome, outcomeIndex, slug, eventSlug, title, name/pseudonym/bio/…`。`limit=2000` 返回 2000（上限 ≥2000）。按时间**降序**。**没有稳定成交 ID**（无 `id`/`tradeId`/`orderId`）。 |
| data-api | `/trades` 的 maker/taker 覆盖 | 默认只返回 **taker 行**；`takerOnly=false` 会额外带上 maker 行（实测两集合重合 195/500）。→ 钱包级事实用 `/activity`，市场级候选用默认口径并在文档里写明。 |
| data-api | `/trades` 分页稳定性 | 同一市场连续三页的合成键无重叠（0/500），但翻页期间数据在变，因此仍然按合成键去重。 |
| data-api | `/activity?user=<addr>&limit=500&sortBy=TIMESTAMP&sortDirection=ASC\|DESC` | 扁平数组。TRADE 额外带 `side/size/price/usdcSize`。**没有稳定 ID**。25 个钱包共 4 千余条实测类型：`TRADE, SPLIT, REDEEM, YIELD, MAKER_REBATE, TAKER_REBATE`；`MERGE/CONVERSION/REWARD/TRANSFER` 本批未出现，代码里按已知类型保留、未识别的归为 `UNKNOWN:<原值>`。 |
| data-api | `/activity` 的 ASC 语义 | ASC 首页第一条是**最早已取到**的活动，不保证是账户首笔：实测某钱包 ASC 首页首条 2026-01-08，而 DESC 末条已到 2026-05-29，说明该钱包 500 条之后还有更早历史。→ 代码区分「最早已获取活动」与「已到达来源起点」(`collection_state.reached_start`)。 |
| data-api | `/positions?user=<addr>&limit=100&sortBy=CURRENT` | 字段丰富：`asset, conditionId, size, avgPrice, curPrice, currentValue, initialValue, grossInitialValue, cashPnl, realizedPnl, percentPnl, entryFeesUsdc, redeemable, mergeable, negativeRisk, oppositeAsset, oppositeOutcome, totalBought, eventId, eventSlug`。 |
| data-api | `/value?user=<addr>` | `[{ user, value }]`（组合总价值，USDC 口径）。 |
| gamma | `/events`, `/markets` | 91 个字段；`conditionId / clobTokenIds / outcomes / outcomePrices / negRisk / closed / endDate / liquidity / volume24hr` 均在。`clobTokenIds`、`outcomes` 是 JSON **字符串**，需要二次解析。 |
| Polygon RPC | `polygon-bor-rpc.publicnode.com` | `eth_call`/`eth_getCode`/`eth_blockNumber` 可用；`eth_getLogs` **只支持近端区块**，更老的区间报 `Archive requests require a personal token`（1000 区块前即失败）。 |
| Polygon RPC | `polygon.drpc.org` | 近端与 10 万区块前的 `eth_getLogs` 都可用（实测近端 6305 条、10 万前 3314 条）。作为 getLogs 的兜底端点。 |
| Polygon RPC | `polygon-rpc.com` | 已停用（tenant disabled）。`polygon.llamarpc.com`、`1rpc.io/matic` 本机不可达。 |
| 链上 | 代理合约控制关系 | 形态不统一：45 字节极简代理 `owner()`/`getOwners()` 都 revert；124 字节支持 `getOwners()`+`getThreshold()`（实测 3 个签名者、阈值 1）；146 字节额外支持 `owner()`。→ 「读不出」记为未知与缺口，不当作「无关联」。 |
| 链上 | 抵押资产 | `0x2791bca1f2de4661ed88a30c99a7a9449aa84174`（USDC.e），6 位小数；`balanceOf` 实测有值。 |

## 2. 核对出的口径风险（P0 要修掉的）

1. **失败会被当成「没有数据」**：`/holders`、`/trades`、`/activity` 失败时若返回 `[]`，下游会得到「没有异动/没有持仓」的结论。本实现所有方法返回 `Result`（`ok:false` + `kind`），失败一律写 `data_gaps`。
2. **`INSERT OR IGNORE` 会吞掉约束失败**：SQLite 的 `OR IGNORE` 对 `NOT NULL`/外键失败同样静默忽略。因此 `insertActivity` 在「没有既有行却插入 0 行」时直接抛错，采集器另有必需字段检查（`isCompleteActivity`）。
3. **来源没有稳定成交 ID**：只能用合成键（`tx|token|side|size|price|timestamp|wallet`）。同一交易内字段完全相同的多笔用序号后缀区分，并把「合成键局限」登记为缺口。
4. **`/activity` 的 ASC 首页不等于账户首笔**：因此画像里只报「最早已获取」，`reached_start` 才代表到达起点；两者都不等于「账户新」。
5. **`/trades` 默认不含 maker 行**：市场级候选若只用默认口径，会漏掉只做 maker 的地址。P1 用 `/activity` 做钱包级事实来源，`/trades` 只用于市场候选发现，并在报告里注明口径。
6. **`/positions` 会省略灰尘仓位**：`/positions` 返回的是有意义的持仓；账本推导出仍有份数、但快照里没有该 token 时，只能记「未知」，不能判定为 0。

## 3. 未解决 / 未覆盖的缺口（诚实清单）

- `MERGE` / `CONVERSION` / `TRANSFER` / `REWARD` 这批类型本批样例没出现，字段按已有类型推断；实现里归为「已知但份数不可量化」或 `UNKNOWN:<原值>`，均进 `unexplained` 并登记缺口。
- getLogs 的 archive 能力依赖公共端点（drpc）；公共端点限流/下线时资金路径证据会失效，届时只报缺口。
- 没有 maker/taker 的「下单人」字段，无法把同一订单的 maker 与 taker 归并到同一订单号；聚合口径是「同向、同 token、配置窗口内」。
- `usdcSize` 的符号实践中由 `side` 决定，代码对 BUY 记现金流出、SELL 记流入；赎回/拆分等现金口径按来源原值记录。
