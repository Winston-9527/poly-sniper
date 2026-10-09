# Poly-sniper

<div align="center">
  <img src="visual-asset/logo.png" alt="Poly-sniper Logo" width="200"/>
</div>

Poly-sniper 是一个针对 Polymarket 的全市场追踪与异动监测分析工具。它能够实时监控市场动态，发现资金异动，并提供深入的钱包分析功能，旨在帮助用户捕捉市场机会并识别潜在的内幕交易行为。

## 🚀 主要功能 (Features)

1.  **全市场追踪 (Total Market Tracking)**
    *   实时追踪和监控 Polymarket 上的所有预测市场，不错过任何重要动态。

2.  **市场异动自动报警 (Anomaly Detection & Alerts)**
    *   通过智能算法监测市场资金流向和赔率变化。
    *   当检测到异常波动或大额资金介入时，系统会自动触发报警，并立即进行初步的画像分析。

    ![市场异动自动报警示例](visual-asset/auto.png)
    *^ 系统自动捕捉异动并推送包含价格变动、市场链接及初步分析的警报。*

3.  **可疑内幕钱包分析 (Suspicious Wallet Analysis)**
    *   **自动分析**: 针对捕捉到的异动事件，自动关联并分析相关参与钱包的交易历史和行为模式。
    *   **手动分析 (`/check`)**: 支持通过指令手动查询特定钱包或市场，深度挖掘潜在的内幕交易线索。

    ![手动分析指令示例](visual-asset/mannually.png)
    *^ 用户可随时发送 `/check` 指令对特定市场进行深度扫描，获取嫌疑钱包评分与特征。*

4.  **Telegram 自动推送 (Telegram Notification)**
    *   集成 Telegram Bot， 将市场异动警报、分析报告实时推送到你的 Telegram 频道或群组，让你随时随地掌握第一手信息。

## 🛠 环境配置 (Configuration)

### 1. 环境依赖 (Prerequisites)

*   [Node.js](https://nodejs.org/) (建议 v18 或更高版本)
*   npm (Node.js 自带)

### 2. 安装 (Installation)

```bash
git clone https://github.com/Winston-9527/poly-sniper.git
cd poly-sniper
npm install
```

### 3. 每个环境需要配置变量 (.env)

在项目根目录下创建一个 `.env` 文件，并填入以下配置信息：

```env
# Telegram Bot 配置 (用于接收报警推送)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id

# 区块链与网络配置
# Polygon RPC 节点地址 (用于链上数据分析)
# 注意：polygon-rpc.com 已停用（返回 403 tenant disabled），换用公共节点
POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com
# 或者使用通用的 RPC_URL
RPC_URL=https://polygon-bor-rpc.publicnode.com

# (可选) 代理配置 - 如果你的网络环境需要代理才能访问 Polymarket 或 Telegram API
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897

# ---- 市场过滤 / 监控面（详见 MarketFilter 注释）----
MIN_LIQUIDITY=25000           # 流动性硬门槛
MIN_VOLUME_24H=1000           # 24h 成交量硬门槛
MAX_ALERTS_PER_MIN=6          # 每分钟推送上限（安全网）
POLL_PAGES_PER_CYCLE=5        # 每轮扫多少页喂价市场
MAX_MARKET_PAGES=700          # 全量元数据加载的页数上限

# ---- 候选池 / 画像（详见 TradeScanner / Profiler 注释）----
TRADE_WINDOW_HOURS=72         # 成交流回看窗口
TRADE_SCAN_PAGES=4            # /trades 最多翻几页（每页 500 笔）
CANDIDATE_TOP_K=25            # 粗筛后进入链上深挖的钱包数上限
PROFILE_CONCURRENCY=4         # 深挖并发
SCORE_THRESHOLD=60            # 推送阈值（0~100 分制）
FUNDING_SCAN_CHUNKS=0         # 兜底注资日志扫描的块数（0=关闭；每块 10000 区块）
FUNDER_DENYLIST=              # 追加的交易所/桥地址（逗号分隔）
WALLET_CACHE_PATH=./data/wallet-cache.json   # 钱包/同源键长期缓存
```

*   **获取 Telegram Token**: 在 Telegram 中联系 [@BotFather](https://t.me/BotFather) 创建新机器人获取 Token。
*   **获取 Chat ID**: 将你的机器人拉入群组，或直接私聊，通过相关工具或 API 获取 Chat ID。

### 4. 候选池口径与评分（v2）

异动警报触发后，画像分析的主流程（`src/sentinel/`）是：

1. **候选池 = 成交流，不是持仓快照**（`TradeScanner`）。
   拉该市场近 `TRADE_WINDOW_HOURS` 的 `/trades`（含 Yes/No 双边），一次 500 笔，
   拿到所有真的动过手的钱包。旧实现用 `/holders` 前 20 名，在 ≥1000 持仓者的大市场里
   覆盖率只有 2~4%，而且提前埋伏 / 异动中跑掉的人根本不在快照里。
2. **本地粗筛 top-K**（`coarseScore`，0~100，零额外请求）：
   同向成交额占比 20 + 池内相对规模 20 + 进场时点 25（贴着异动之前最高）+ 出手形态 10；
   双边下注（反向额 ≥ 同向额）按 0.4 折。只把 top-K 送去做链上深挖。
3. **链上深挖**（`ChainAnalyzer`）：
   - 真实首笔活动时间（`/activity?sortBy=TIMESTAMP&sortDirection=ASC` 的第一条）；
   - **同源聚类键**：优先读代理合约的 `owner()` / `getOwners()` 拿到签名者 EOA
     （Polymarket 两代代理钱包都实测可用），一次 `eth_call`；
     读不到时（默认关闭，`FUNDING_SCAN_CHUNKS>0` 才走）兜底扫 USDC 入金日志（`eth_getLogs`，topic2=收款人）取最早入金的 `tx.from`；
     实测 owner 覆盖率 74.5%（某 NFL 市场 647 个成交钱包里 482 个可读，且互不相同），
     剩余 25.5% 是 92 字节的老一代代理，两种 getter 都不支持。
   - 结果落盘到 `WALLET_CACHE_PATH`，并维护 `clusterKey → 钱包列表` 全局索引，
     同源簇因此能跨警报累积。
4. **评分（0~100）与推送阈值**（`Scorer`，`SCORE_THRESHOLD`，默认 60）：

| 维度 | 权重 | 说明 |
|---|---|---|
| 成交行为 tradeSignal | 30 | 直接由粗筛分 ×0.3 得来，保证「排序依据」与「报告分数」同源 |
| 新鲜度 freshness | 20 | 只认真实首笔活动时间，未知一律 0 分（旧版会给「合约 nonce 恒为 0」白送分） |
| 专注度 focus | 15 | 早期活动里的唯一事件数 = 1 / ≤3 |
| 同源资金 correlation | 15 | 同一 owner EOA（或同一注资地址）下有 ≥2 个钱包 |
| 本市场仓位 position | 10 | 持仓快照（1 次请求）优先，拿不到用窗口内同向成交额 |
| 资金储备 capital | 10 | 钱包 USDC 余额 |

### 5. 体检工具（覆盖率实测）

```bash
npm run build
# 对比旧口径（/holders 前 20）与新口径（成交流池）的覆盖率 + 粗筛排名
node dist/tools/scan-candidates.js --slug <polymarket-event-slug> --direction UP
# 加 --deep 跑完整链路（含 owner / 注资聚类与打分）
node dist/tools/scan-candidates.js --condition 0x... --token 123... --direction UP --topk 8 --deep
```

### 6. 测试

```bash
npm test        # tsc + node --test tests/（粗筛打分 / 评分器 / 成交方向判定）
```

## 🚀 使用指南 (Usage)

### 启动监控 (Start Monitoring)

**开发模式:**
```bash
npm run dev
```

**生产模式:**
1. 编译代码:
    ```bash
    npm run build
    ```
2. 启动:
    ```bash
    npm start
    ```

### 常用指令

在 Telegram 中与机器人交互 (需确保服务已启动):
*   `/check <参数>`: 手动触发对特定目标的分析 (具体参数格式请参考内部文档或代码)。

## 🗺️ 发展路线图 (Roadmap)

我们致力于持续优化 Poly-sniper 的智能化程度：

- [ ] **大模型深度分析**: 接入 LLM (大语言模型) 辅助钱包行为分析，提供更自然、更深度的内幕交易嫌疑报告。
- [ ] **智能阈值优化**: 根据市场资金沉淀量 (Volume/Liquidity) 动态调整异动报警的权重和阈值，减少误报，提高信号准确度。

## 🤝 贡献 (Contributing)

欢迎提交 Issue 或 Pull Request！

## 📄 许可证 (License)

[MIT License](LICENSE)
