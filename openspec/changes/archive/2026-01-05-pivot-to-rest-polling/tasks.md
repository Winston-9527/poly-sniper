# 任务：转向 REST API 轮询架构

## 准备工作
- [x] 确认 `sampling-simplified-markets` 接口在 10s 频率下的稳定性。 <!-- id: 0 -->

## 核心开发
- [x] 清理 `Sentinel.ts` 中的 WebSocket 相关导入、成员变量和初始化逻辑。 <!-- id: 1 -->
- [x] 移除 `Sentinel.ts` 中针对 WebSocket 的代理补丁代码。 <!-- id: 2 -->
- [x] 重构 `startPolling` 方法，使其成为唯一的数据获取入口。 <!-- id: 3 -->
- [x] 将轮询间隔从 2s 调整为 10s。 <!-- id: 4 -->
- [x] 优化 `loadMarkets` 逻辑，确保在纯轮询模式下元数据加载依然正确。 <!-- id: 5 -->

## 验证与测试
- [x] 运行 `monitor-btc` 脚本，验证是否能通过轮询捕获到模拟的价格异动。 <!-- id: 6 -->
- [x] 检查内存占用，确保长时间运行无泄漏。 <!-- id: 7 -->
- [x] 验证代理配置在纯 REST 模式下依然生效。 <!-- id: 8 -->

## 清理
- [x] 从 `package.json` 中移除 `polymarket-websocket-client` 依赖。 <!-- id: 9 -->
- [x] 更新 `openspec/project.md` 中的技术栈描述。 <!-- id: 10 -->
