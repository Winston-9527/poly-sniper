# telegram-alerts Specification

## Purpose
TBD - created by archiving change add-telegram-notifications. Update Purpose after archive.
## 需求
### 需求：Telegram 消息推送
系统**必须**能够将检测到的异动警报发送到指定的 Telegram 聊天中。

#### 场景：发送异动警报
- **给定**：系统已配置有效的 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`。
- **当**：`Sentinel` 检测到符合条件的异动（波动 > 5%）时。
- **那么**：系统应构造一条包含以下信息的消息并发送：
    - 警报标题（如 `[!!! 异动警报 !!!]`）
    - 资产名称
    - 波动幅度（如 `+5.20%`）
    - 当前价格
    - 市场链接（指向 Polymarket 官网）

### 需求：市场链接构造
推送的消息**必须**包含可点击的链接，引导用户进入对应的 Polymarket 市场页面。

#### 场景：生成市场链接
- **给定**：已知市场的 `token_id`。
- **当**：准备发送 Telegram 消息时。
- **那么**：系统应使用该市场的 `slug`（从元数据中获取）构造链接：`https://polymarket.com/event/[slug]`。

### 需求：代理支持
Telegram 推送模块**必须**支持通过代理服务器发起请求。

#### 场景：在代理环境下推送
- **给定**：环境变量 `HTTPS_PROXY` 已设置。
- **当**：Telegram 机器人初始化时。
- **那么**：它应配置代理以确保能够访问 Telegram API。

