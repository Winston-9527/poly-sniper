# 设计文档：Telegram 推送模块 (Messenger)

## 架构概述
推送模块将作为 `Sentinel` 的下游组件。当 `Sentinel` 检测到异动时，将调用 `Messenger` 发送通知。

## 关键决策

### 1. 模块解耦
`Sentinel` 不应直接依赖 Telegram SDK。我们将定义一个通用的 `AlertEmitter` 接口或使用事件机制，使得未来可以轻松扩展其他推送渠道（如 Discord, Slack）。

### 2. 消息格式化
Telegram 支持 MarkdownV2 或 HTML 格式。我们将使用 Markdown 格式来美化输出，包括：
- 加粗资产名称。
- 使用代码块展示价格和幅度。
- 提供超链接形式的市场地址。

### 3. 市场链接生成
Polymarket 的市场链接通常遵循 `https://polymarket.com/event/[slug]` 或 `https://polymarket.com/market/[slug]`。由于我们目前持有 `token_id`，需要通过 Gamma API 获取市场的 `slug` 来构造链接。

## 外部依赖
- `node-telegram-bot-api`: 用于与 Telegram Bot API 交互。
- `https-proxy-agent`: 用于在需要时通过代理连接 Telegram。
