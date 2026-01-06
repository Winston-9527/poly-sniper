# 设计文档：Sentinel 监控模块

## 架构概述
Sentinel 模块作为系统的入口，负责持续监听市场动态。它由以下几个核心组件组成：

1. **MarketSubscriber**: 负责与 Polymarket WebSocket API 建立连接并订阅主题。
2. **MarketFilter**: 根据市场元数据（类别、状态）过滤掉不符合要求的市场。
3. **AnomalyDetector**: 维护内存价格缓存，计算价格变动百分比。
4. **AlertEmitter**: 当检测到异动时，触发输出或后续处理流程。

## 关键决策

### 1. 市场过滤逻辑
用户要求排除 "Crypto" 和 "Sports" 类别。我们将通过查询 Polymarket Gamma API 获取市场的 `group_id` 或 `tags` 来识别类别，并在 WebSocket 订阅阶段或消息处理阶段进行过滤。

### 2. 异动检测算法
- **初始方案**：对比当前价格与上一笔成交价。
- **进阶方案**：使用 5 分钟滑动窗口，对比当前价格与窗口内最早价格。
- **当前实现**：采用绝对变化对比法，即 `abs(current_price - first_price_in_window) >= 0.05`。

### 3. 数据结构
使用 `Map<string, number>` 存储每个市场的最新价格，其中 Key 为 `condition_id` 或 `token_id`。

## 外部依赖
- `polymarket-websocket-client`: 用于实时数据获取。
- `@polymarket/clob-client`: 用于获取初始市场列表和元数据。
