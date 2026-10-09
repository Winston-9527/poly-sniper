# P1 实现说明：可靠记录与可观察的仓位变化（首个可用版本）

对应 Pull #2 方案（`docs/plans/wallet-profile-capital-flow-plan.md`）的 **P0 + P1**。
本文件说明实现了什么、怎么运行、以及每条验收项由哪个测试或哪次实测覆盖。**P2/P3 未实现**。

## 1. 模块地图

```
src/config.ts                 配置与阈值（全部可配、带版本号 RULES_VERSION）
src/util/decimal.ts           精确十进制（BigInt 缩放整数，金额/份数不用二进制浮点）
src/util/time.ts              event_at / observed_at / computed_at 口径；展示用东八区
src/db/schema.sql             全部表结构（P1 首次迁移）
src/db/Database.ts            WAL + 外键 + busy_timeout + 短事务 + VACUUM INTO 一致性备份
src/db/repos.ts               仓储层（幂等写入、去重键、缺口、队列）
src/sources/http.ts           统一 Result 的 HTTP 层 + 全局请求预算（绝不把失败当空）
src/sources/contracts.ts      运行期契约校验 + 契约版本 + 合成键
src/sources/DataApi.ts        /holders /trades /activity /positions /value
src/sources/Chain.ts          代理控制关系（owner/getOwners/getThreshold）、USDC.e 余额、Transfer 日志（多 RPC 兜底）
src/ledger/Collector.ts       冷启动 + 增量采集（重叠窗口）、候选发现（显著成交 / 重点持有人）、预算与缺口
src/ledger/PositionLedger.ts  持仓过程（episode）+ 账本条目 + 对账 + 按 token 自身价格估值
src/ledger/Behaviors.ts       行为识别与可解释优先级（纯函数，可确定性测试）
src/ledger/Profiler.ts        画像：覆盖区间、交易规模基线（排除当前待评估行为）、组合、关系、缺口
src/ledger/GroupAggregation.ts 观察组内部转账单列、公共来源排除、同批资金证据
src/ledger/Pipeline.ts        串起：采集 → 快照开过程 → 入账 → 对账 → 行为 → 报告入队 → 画像落盘
src/alerts/Outbox.ts          持久化报警队列（pending/sending/sent/retry/dead/merged）+ 限速合并摘要
src/report/Reports.ts         行为报告 / 钱包报告 / 市场报告 / 状态报告（HTML，只转义动态内容）
src/bot/Bot.ts                /status /wallet /check /watch /unwatch /watchlist（白名单访问控制）
src/index.ts                  入口：PIPELINE=sentinel（默认，现有生产）| ledger（新链路）
src/tools/shadow-run.ts       影子运行：真实来源 + 不发 Telegram + 明细落盘
tools/probe-contracts*.mjs    P0 契约核验（只读）
```

## 2. 怎么运行

```bash
npm install          # 已含依赖
npm run build        # tsc + 复制 schema.sql 到 dist（保证 dist 由 src 生成）
npm test             # 37 个用例：契约 / 账本 / 行为 / 报告 / 限速 / 备份恢复
npm run shadow                                  # 影子运行：自动取热门市场
node dist/tools/shadow-run.js --market <slug|conditionId>
node dist/tools/shadow-run.js --wallet 0x…      # 只看一个钱包
node dist/tools/shadow-run.js --no-network      # 离线重算（不发请求）
npm run probe                                   # 只读契约核验，刷新脱敏样例
```

新链路默认**不接管生产**：`PIPELINE=sentinel` 仍是现有异动链路；`PIPELINE=ledger` 才启用新链路，
且 `SHADOW_MODE=1` 时只记录不发送（发送器写入 `telegram_message_id='shadow'`，便于切生产时重新入队）。

## 3. 验收对照

### P0（核实数据与修正误导性行为）

| 验收项 | 证据 |
| --- | --- |
| 真实来源的小规模只读样本可正确解析 | `tools/probe-contracts*.mjs` 真实跑通；`tests/p0-contracts.test.mjs` 用脱敏样例验证解析器 |
| 失败/空/零值分离 | `Result`（`ok:false`+`kind`）贯穿全链路；`tests/p0-contracts.test.mjs`「来源返回空数组 ≠ 失败」；`isCompleteActivity` + `INSERT OR IGNORE` 静默失败检测 |
| 已知错误场景有回归覆盖 | 契约违反抛 `ContractError`；未知年龄不再有任何加分项（`tests/p1-ledger.test.mjs` 场景 7b）；双边估值按各自 token 价格（场景 5） |
| 隔离已提交编译产物 | 删除 `src/sentinel/*.js`，`.gitignore` 已含 `src/**/*.js`；`npm run build` 由 `tsc` 生成 `dist/` |
| 测试入口在服务器实际 Node 版本上验证 | `node -v` = v26.8.2；`npm test` 通过（`node --test`，无额外运行器依赖） |
| 不引入新的盈利/内幕评分承诺 | 报告只输出行为、优先级（高/中/低）与数据质量；无「内幕概率」，`pnl.available=false` 且写明原因 |

### P1（可靠记录与可观察的仓位变化）

| 验收项 | 证据 |
| --- | --- |
| 不依赖完整历史成本也能准确说明上线后的份数变化 | `position_episodes.baseline_complete=0`；测试「P1 验收：不依赖完整历史成本…」（30000 → 60000） |
| 老钱包不被年龄门槛排除 | 优先级函数没有任何年龄输入；测试场景 1（2019 年的钱包）与场景 7b |
| 重复采集不重复入账 | 活动/账本/事件各有唯一去重键；测试「重复采集不重复入账、不重复报警」与「采集器幂等」 |
| 限速后仍可投递或有明确合并记录 | 溢出条目 `status='merged'` 并写进摘要；测试场景 14 |
| 服务重启恢复 | `collection_state` 与队列同库持久化；`resetStuckSending` 处理崩溃残留（显式标注可能重复投递一次） |
| 定期备份 | `VACUUM INTO` 一致性备份（`BACKUP_DIR`，默认每 96 轮）；测试场景 15 恢复到备份并核对快照/进度/事件/待发送 |
| 原生产服务切换前影子运行核对 | `npm run shadow`（真实来源、不发 Telegram、明细落 `data/shadow-*.json`） |
| 旧 JSON/CSV 仅作带来源标记的导入参考 | 旧 `data/wallet-cache.json`、`data/markets.csv` 未参与新链路；新库不导入它们（如需导入，走 `source_records` 并标注来源） |

### 方案 §12「必须覆盖的验收场景」→ 测试

| 场景 | 测试 |
| --- | --- |
| 老钱包突然大额买入 | `场景1：老钱包突然大额买入…` |
| 长期 100,000 份卖出 10,000 份 | `场景2：…减仓 10%，不能称清仓` |
| 10,000 份全部卖出且快照确认归零 | `场景3：…本地址退出，且成交额不作为当前仓位`；未确认归零另测 `场景3b` |
| 0.2 买入后 0.4 卖出同样份数 | `场景4：…不因卖出金额更大判对冲` |
| Yes=0.9 仅持有 20,000 份 No | `场景5：…按 No 自己的价格估值` |
| 买卖同时出现 / 订单拆成多笔 | `场景6：…保留顺序与聚合口径` |
| 历史缺失、查询失败、首次在本机出现 | `场景7` 与 `场景7b` |
| 最早 200 条只涉及一个事件、历史已截断 | `场景8：…不判定其终身只关注一个事件` |
| 最近两天无交易、数月前已有大仓位 | `场景9：…保留存量观察，不被静默归档` |
| API 页数用尽、请求中断或记录延迟 | `场景10：…记录实际覆盖与缺口` |
| 同一交易多条日志、跨来源重复记录 | `场景11…` + `同一交易多条日志 / 跨来源重复` |
| 转账/拆分/合并/赎回造成份数变化 | `场景12：…不支持时报告待解释差异` |
| 同一观察组内部转账、多签共享一个签名者 | `场景13：…` |
| 达到报警限速后服务重启 | `场景14：…` |
| 数据库备份后恢复 | `场景15：…` |

## 4. 明确未做（P2/P3，以及本版的取舍）

- **历史补全（P2）**：没有可核验的历史来源就不宣称补全。`collection_state.reached_start=0` 时画像只给下界，
  `BACKFILL_ENABLED` 默认关闭，且只做同一端点的向前翻页（受预算与页数上限约束）。
- **跨月持仓过程串联、多时间尺度基线（P2）**：只实现了配置窗口内的交易规模基线；跨月过程要等 P2。
- **资金账本的完整货币视图（P3）**：现金侧只记录可核验的成交/赎回/奖励金额与 USDC.e 余额快照，
  转账/桥/CEX 的完整资金路径需要 P3（并依赖 archive RPC 的可得性）。
- **历史 PnL / 胜率（P3）**：成本不完整时一律不出（`pnl.available=false`）。
- **用户的顺势/反向/放弃记录（P3）**：`decisions`/`followups` 表已建，命令与自动跟进未接。
- `/wallet`、`/check` 只读渲染；`/watch` 支持钱包与市场；命令在白名单校验后才响应。
- 优先级阈值是**可配置假设**（`RULES_VERSION=p1-rules-2`），需要影子运行后再调；本版没有用它宣称任何收益。

## 5. 实测证据（2026-10-09，真实来源，非构造数据）

`node dist/tools/shadow-run.js`（真实采集、不发 Telegram）：

| 指标 | 实测值 |
| --- | --- |
| 候选发现（单市场一轮） | 新增关注 54 个 = 显著成交 14 + 重点持有人 40；因预算跳过 0 |
| 采集游标 | 30 个；失败 0；历史未到起点（截断）27 个 —— 全部如实标注 |
| **账本推导 vs 来源快照** | **1437 / 1437 个 token 完全一致（100.0%），未解释差异 0** |
| 已采集活动类型 | TRADE×34090、REDEEM×2231、YIELD×1062、REWARD×606、MAKER_REBATE×355、MERGE×135、TAKER_REBATE×100、CONVERSION×64、SPLIT×51、REFERRAL_REWARD×2 |
| 控制关系 | 124 字节代理可读出 1~3 个签名者与阈值；45 字节代理两种 getter 都不支持 → 登记为「未知」缺口，不当作无关联 |
| 缺口清单 | 历史截断、合成键冲突、45 字节代理读不出 owner 三类，全部可见 |

`MERGE/CONVERSION/REWARD/REFERRAL_REWARD` 在真实数据里都出现了，本版把它们按「已知但份数不可单独归因」处理（进 `unexplained` + 缺口），不会被伪造成买卖。

### 推送内容测试（不影响生产）

```bash
npm run test-push                 # 有真实事件就发真实事件，否则发构造样例；只发一条
node dist/tools/test-push.js --kind sample       # 强制样例（无需真实数据）
node dist/tools/test-push.js --kind wallet --wallet 0x…
node dist/tools/test-push.js --dry               # 只渲染不发送
```

工具只发**一条**消息、不入队、不循环、不改生产状态；报告超过 Telegram 单条上限时按行切分顺序发送。
真正启用推送需要：`.env` 里 `PIPELINE=ledger`、`SHADOW_MODE=0`、`TELEGRAM_ENABLED=1`，然后重启服务。

