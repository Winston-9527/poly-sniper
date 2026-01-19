# MCPService 项目计划书

## 背景与目标

当前 `poly-sniper` 已能完成 Polymarket 全市场异动监控、钱包画像分析与 Telegram 推送。但在 Agent Workflow 场景中，需要将异动事件“推送”到编排系统，让 LangGraph / LLM 节点进一步分析与处理。第一阶段目标是将 Sentinel 作为实时事件源，将异动事件以 Webhook 形式发送到服务器侧，并提供可验证的模拟测试。

## 范围

### 纳入范围
- Sentinel 异动检测后 Webhook 推送
- Webhook 数据结构标准化（市场 + 异动字段）
- 新增模拟测试脚本，用于验证 Webhook 是否可用
- 在本地通过可验证命令完成测试验收

### 不纳入范围
- MCP 服务实现细节
- LangGraph 端节点编排与 LLM 提示词设计
- 异动后的链上画像结果推送

## 架构概览（第一阶段）

```text
Sentinel (监控脚本)
  └── 发现异动 -> 发送 Telegram
  └── 发现异动 -> POST Webhook 到 LangGraph 服务器
```

## Webhook 事件数据结构

```json
{
  "eventType": "market.anomaly",
  "detectedAt": 1736900000000,
  "anomaly": {
    "marketId": "...",
    "previousPrice": 0.50,
    "currentPrice": 0.56,
    "changePercentage": "+6.00%"
  },
  "market": {
    "marketId": "...",
    "category": "Politics",
    "title": "...",
    "slug": "...",
    "outcome": "Yes",
    "conditionId": "...",
    "liquidity": 12345
  },
  "source": "sentinel"
}
```

## 配置说明

新增环境变量：
- `LANGGRAPH_WEBHOOK_URL`：LangGraph/Workflow 接收 Webhook 的 HTTP 地址

## 开发任务清单（第一阶段）

- [x] 在 Sentinel 中加入 Webhook 推送逻辑
- [x] 补充 Webhook payload 类型定义
- [x] 增加模拟 Webhook 测试脚本
- [x] 运行测试并记录结果

## 测试方式

```bash
LANGGRAPH_WEBHOOK_URL="http://127.0.0.1:9999/webhook" node --loader ts-node/esm src/test-webhook.ts
```

## 验收标准

- 异动发生时控制台打印 Webhook 推送成功日志
- 模拟测试能在本地打印接收数据并返回 200
