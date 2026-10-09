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
# 新链路默认影子运行（只记录不发送）；要真正推送才设为 1
TELEGRAM_ENABLED=0

# 区块链与网络配置
# polygon-rpc.com 已停用（tenant disabled），用公共端点
POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com

# (可选) 代理配置 - 如果你的网络环境需要代理才能访问 Polymarket 或 Telegram API
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
```

完整变量（含 P1 新链路的数据库、预算、阈值、限速）见 [`.env.example`](.env.example)。

*   **获取 Telegram Token**: 在 Telegram 中联系 [@BotFather](https://t.me/BotFather) 创建新机器人获取 Token。
*   **获取 Chat ID**: 将你的机器人拉入群组，或直接私聊，通过相关工具或 API 获取 Chat ID。

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

## 🚧 新链路：持续观察钱包画像与仓位变化（P1 影子可用）

`main` 上仍在跑的是「价格异动 → 查可疑钱包」的链路（默认 `PIPELINE=sentinel`，行为不变）。
新增的 **`PIPELINE=ledger`** 链路按 [钱包画像与资金动向改进方案](docs/plans/wallet-profile-capital-flow-plan.md) 的
**P0 + P1** 实现：持续采集 → SQLite 账本 → 持仓变化/退出报告，默认**影子运行**（只记录不发送）。

* 来源契约核验结果与缺口：[`docs/contract-report.md`](docs/contract-report.md)（含脱敏样例 `tests/fixtures/contracts/`）
* 实现说明与验收对照：[`docs/p1-implementation.md`](docs/p1-implementation.md)

```bash
npm test                                        # 37 个用例：契约 / 账本 / 行为 / 报告 / 限速 / 备份恢复
npm run shadow                                  # 影子运行（真实来源、不发 Telegram、明细落 data/shadow-*.json）
node dist/tools/shadow-run.js --market <slug>    # 指定市场
node dist/tools/shadow-run.js --wallet 0x…       # 只看一个钱包
npm run test-push                               # 推送内容测试：只发一条，用真实报告渲染器
npm run probe                                   # 只读契约核验，刷新脱敏样例
```

实测（真实数据）：账本推导份数与来源快照 **1437/1437 完全一致**；候选发现 54 个/市场；缺口与截断全部显式登记。

要点（与旧链路的区别）：

- **持仓过程**而非成交额：快照建立观察起点，之后按份数变化报「加仓/减仓/退出」；减仓 10% 不会被说成清仓。
- **事实/推断/缺失分开**：报告显式标注数据完整度（已核对/部分核对/证据不足）与已知缺口；失败不会变成「没有异常」。
- **优先级与数据质量解耦**，且没有任何「钱包年龄」加分。
- **报警不丢**：持久化队列 + 每分钟限速，溢出合并为摘要而不是丢弃；重启后队列与采集进度恢复。

## 🗺️ 发展路线图 (Roadmap)

下一阶段以**钱包长期画像、持仓变化和资金动向**为重点，支持顺势与反向研究。

完整设计见 [钱包画像与资金动向改进方案](docs/plans/wallet-profile-capital-flow-plan.md)。

- [x] **P0 · 可靠口径**：接口契约核验、失败/空/零分离、构建产物隔离（见 `docs/contract-report.md`）。
- [x] **P1 · 首个可用版本**：SQLite 记录、关注名单、持仓变化与退出报告、持久化报警队列、备份与状态查询。
- [ ] **P2 · 长期画像**：后台历史补全、跨月持仓过程、多时间尺度基线、非成交活动核对。
- [ ] **P3 · 资金动向与复盘**：现金转入/转出与交易回款区分、跨市场同期调仓、决策与后续表现记录。

## 🤝 贡献 (Contributing)

欢迎提交 Issue 或 Pull Request！

## 📄 许可证 (License)

[MIT License](LICENSE)
