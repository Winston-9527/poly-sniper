# 项目 上下文

## 目的
Poly-Sniper 是一个 Polymarket 内幕追踪系统。其目标是通过实时监控 Polymarket 市场波动，识别异常交易行为，并对高胜率/内幕钱包进行画像分析，最终实现“发现异动 -> 识别内幕 -> 实时预警 -> 决策跟单”的闭环。

## 技术栈
- **语言**: Node.js (TypeScript)
- **市场接口**: `@polymarket/clob-client` (获取订单簿与执行交易)
- **监控机制**: 基于 REST API 的高频轮询 (10s/次)
- **链上分析**: `ethers.js` (Polygon 链上余额、入金记录、合约交互)
- **外部 API**: 
    - Polymarket Gamma API (获取持仓排名、市场详情)
    - Polygonscan API (辅助查询钱包历史)
- **推送系统**: `node-telegram-bot-api` (Telegram 机器人)

## 项目约定

### 代码风格
- **语言**: 强制使用 TypeScript。
- **命名**: 变量和函数使用 camelCase，类名使用 PascalCase，常量使用 UPPER_SNAKE_CASE。
- **注释**: 关键逻辑必须包含中文注释。
- **格式化**: 遵循 Prettier 默认配置。

### 架构模式
- **模块化**: 
    - `Sentinel`: 负责实时异动监控。
    - `Profiler`: 负责钱包画像与打分。
    - `Messenger`: 负责预警推送。
    - `Executor`: 负责交易执行。
- **异步处理**: 核心逻辑应采用异步非阻塞设计，确保实时性。

### 测试策略
- **单元测试**: 对打分算法和价格异动逻辑进行单元测试。
- **集成测试**: 模拟 API 响应测试模块间的协作。

### Git工作流
- **分支**: `main` 为稳定分支，功能开发在 `feature/` 分支进行。
- **提交信息**: 使用中文描述，格式为 `类型: 描述` (例如 `feat: 增加钱包打分逻辑`)。

## 领域上下文
- **Polymarket**: 基于 Polygon 的去中心化预测市场。
- **内幕交易特征**: 账号新鲜（48小时内）、单一市场重仓、资金规模大、历史胜率极高。
- **USDC**: 市场结算使用的主要稳定币。

## 重要约束
- **API 限制**: Polymarket 对 API 请求有频率限制，需设计请求队列和限流机制。
- **数据延迟**: 链上分析（ethers.js）可能存在延迟，需优化并发查询。
- **误报风险**: 需不断优化打分权重以降低大户随机调仓导致的误报。

## 外部依赖
- Polymarket Gamma API
- Polygonscan API
- Telegram Bot API
- Polygon RPC 节点
