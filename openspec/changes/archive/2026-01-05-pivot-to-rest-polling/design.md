# 设计：REST API 轮询架构

## 架构变更
系统将从“事件驱动”模式转变为“定时采样”模式。

### 1. 移除 WebSocket 模块
- 停止使用 `polymarket-websocket-client`。
- 移除 `Sentinel` 类中的 `wsClient` 成员及其相关回调（`onPriceChange`, `onLastTradePrice` 等）。
- 移除 `Sentinel.ts` 中用于 WebSocket 代理的猴子补丁逻辑。

### 2. 强化轮询机制
- **核心接口**：使用 `https://clob.polymarket.com/sampling-simplified-markets`。该接口一次性返回所有活跃市场的价格快照。
- **调度器**：使用 `setInterval` 实现 10 秒一次的触发。
- **数据流**：
    1. 每 10 秒发起一次 GET 请求。
    2. 解析返回的 JSON，提取所有 Token 的 `token_id` 和 `price`。
    3. 将数据批量喂给 `AnomalyDetector` 进行滑动窗口分析。

### 3. 代理支持
- 保留 `undici` 的 `setGlobalDispatcher` 配置，确保 REST 请求在代理环境下正常工作。

## 性能考虑
- **内存**：1000 个市场的滑动窗口数据保持不变，内存占用依然在安全范围内。
- **网络**：每 10 秒一次约 500KB 的数据下载，对现代网络环境无压力。
