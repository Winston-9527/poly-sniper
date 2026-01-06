# 任务列表：实现 Profiler 模块

## 基础架构
- [ ] 定义 `Profiler` 相关的接口类型（`Holder`, `Profile`, `ScoreResult`）。 <!-- id: 0 -->
- [ ] 实现 `GammaClient` 用于获取市场持仓排名。 <!-- id: 1 -->
- [ ] 配置 Polygon RPC 节点支持（环境变量 `POLYGON_RPC_URL`）。 <!-- id: 2 -->

## 链上分析逻辑
- [ ] 实现 `ChainAnalyzer.getAccountAge`：查询钱包首笔交易时间。 <!-- id: 3 -->
- [ ] 实现 `ChainAnalyzer.getUsdcBalance`：查询钱包 USDC 余额。 <!-- id: 4 -->
- [ ] 实现基础的缓存机制，避免重复查询相同钱包。 <!-- id: 5 -->

## 打分引擎
- [ ] 实现 `Scorer` 类，根据设计文档中的维度计算总分。 <!-- id: 6 -->
- [ ] 编写单元测试验证打分逻辑的准确性。 <!-- id: 7 -->

## 系统集成
- [ ] 在 `Sentinel` 中集成 `Profiler` 调用。 <!-- id: 8 -->
- [ ] 更新 `TelegramMessenger`，支持展示内幕分析结果。 <!-- id: 9 -->
- [ ] 使用用户提供的测试市场（Infinex Public Sale）进行端到端验证。 <!-- id: 10 -->
