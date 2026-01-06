# 提案：实现实时异动监控模块 (Sentinel)

## 目标
实现 Poly-Sniper 项目的第一个核心模块：实时异动监控 (The Sentinel)。该模块将订阅 Polymarket 的实时价格流，过滤掉高波动的非内幕相关市场（加密货币和体育），并识别价格波动超过 5% 的异常情况。

## 范围
- 接入 Polymarket WebSocket 客户端。
- 实现市场过滤逻辑（排除 Crypto 和 Sports 类别）。
- 实现价格异动检测算法（滑动窗口或对比上一价格）。
- 实时输出异动信息。
- **注意**：由于 CLOB API 频繁返回 502 错误，市场元数据加载已切换为使用 Gamma API。

## 预期的变更
- 创建 `openspec/specs/sentinel-monitoring/spec.md` 定义监控规范。
- 在 `src/sentinel` 目录下实现核心逻辑。
- 配置必要的环境变量和依赖。

## 风险与考虑
- **API 限制**：WebSocket 连接的稳定性及 Polymarket 的频率限制.
- **数据量**：活跃市场数量较多时，内存中维护价格表的开销。
- **误报**：2% 的阈值可能需要根据实际运行情况进行微调。
