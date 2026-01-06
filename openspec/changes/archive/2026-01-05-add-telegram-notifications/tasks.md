# 任务列表：实现 Telegram 推送

## 准备工作
- [x] 安装依赖：`npm install node-telegram-bot-api` 和 `@types/node-telegram-bot-api`。 <!-- id: 0 -->

## 核心开发
- [x] 扩展 `MarketMetadata` 类型，增加 `slug` 字段。 <!-- id: 1 -->
- [x] 修改 `Sentinel` 的元数据加载逻辑，从 Gamma API 中提取 `slug`。 <!-- id: 2 -->
- [x] 实现 `TelegramMessenger` 类，负责初始化机器人和发送格式化消息。 <!-- id: 3 -->
- [x] 在 `Sentinel` 中集成 `TelegramMessenger`，在检测 to 异动时触发推送。 <!-- id: 4 -->

## 验证与测试
- [x] 创建 `src/test-telegram.ts` 脚本，模拟异动并测试 Telegram 推送功能。 <!-- id: 5 -->
- [x] 验证在设置 `HTTPS_PROXY` 的情况下，推送是否依然正常工作。 <!-- id: 6 -->
