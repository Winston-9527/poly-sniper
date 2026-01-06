# 任务列表：实现 Sentinel 监控模块

## 第一阶段：环境与依赖准备
- [x] 安装 `polymarket-websocket-client` 和 `@polymarket/clob-client` 依赖。 <!-- id: 1 -->
- [x] 配置基础的 TypeScript 项目结构（如果尚未完成）。 <!-- id: 2 -->

## 第二阶段：核心逻辑开发
- [x] 实现 `MarketFilter` 类，支持根据类别过滤市场。 <!-- id: 3 -->
- [x] 实现 `AnomalyDetector` 类，负责价格缓存和百分比计算。 <!-- id: 4 -->
- [x] 实现 WebSocket 客户端集成，连接到 Polymarket 价格流。 <!-- id: 5 -->

## 第三阶段：集成与验证
- [x] 编写集成脚本，启动监控并输出到控制台。 <!-- id: 6 -->
- [x] 验证过滤逻辑：确保 Crypto 和 Sports 市场的更新被忽略。 <!-- id: 7 -->
- [x] 验证异动检测：模拟价格波动触发警报。 <!-- id: 8 -->

## 依赖关系
- 任务 5 依赖于任务 3 和 4。
- 任务 6 依赖于任务 5。
