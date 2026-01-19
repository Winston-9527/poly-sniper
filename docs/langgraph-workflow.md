# LangGraph 工作流开发文档

## 目标

提供一个最小可运行的 LangGraph 调用流程，用于在 Agent Workflow 中串联异动检测、钱包信息和大模型分析。该工作流只承担“节点功能”，不包含完整的编排系统。

## 目录结构

- `src/mcp/server.ts`：MCP 节点服务，提供异动 Webhook 接入和工具调用
- `src/workflow/langgraphFlow.ts`：LangGraph 工作流入口
- `src/workflow/orchestrator.ts`：读取 MCP 异动并触发 LLM 分析
- `src/test-langgraph-workflow.ts`：端到端集成测试

## 数据流概览

1. Sentinel 检测到异动后推送至 MCP 的 `/webhook`
2. LangGraph 工作流通过 MCP 的 `list_anomalies` 读取异动
3. LangGraph 调用 LLM 生成分析结论
4. 输出分析文本供下游 Agent 使用

## 关键环境变量

- `LANGGRAPH_WEBHOOK_URL`：Sentinel 异动推送地址（指向 MCP 的 `/webhook`）
- `OPENAI_API_KEY`：LLM API Key（生产必填）
- `OPENAI_MODEL`：LLM 模型名称（默认 `gpt-4o-mini`）
- `OPENAI_BASE_URL`：兼容 OpenAI 的第三方接口地址（如 OpenRouter、Gemini）
- `PROFILER_API_URL`：钱包画像服务地址（真实画像必填）
- `PROFILER_AUTO_START`：是否自动启动 Profiler 服务
- `PROFILER_PORT`：Profiler 服务端口
- `ANKR_API_KEY`：Ankr Web3 API Key（用于 Polygon RPC）
- `WORKFLOW_USE_MOCK_LLM`：测试时启用模拟 LLM
- `WORKFLOW_USE_MOCK_WALLETS`：测试时使用模拟钱包画像

## 本地运行

### 1. 启动 MCP 服务
```bash
MCP_AUTO_START=true MCP_PORT=8788 node --loader ts-node/esm src/mcp/server.ts
```

### 2. 启动 Sentinel（可选）
```bash
LANGGRAPH_WEBHOOK_URL="http://127.0.0.1:8788/webhook" npm run dev
```

### 3. 解析真实市场参数（可选）
```bash
E2E_MARKET_SLUG="<slug>" npm run test:e2e:resolve
# 或者
E2E_MARKET_ID="<tokenId>" npm run test:e2e:resolve
```

### 4. 运行 LangGraph 工作流测试
```bash
npm run test:workflow
```

## 生产部署指引

1. **部署 Profiler 服务**（提供钱包画像）
   ```bash
   PROFILER_AUTO_START=true PROFILER_PORT=8793 node dist/profiler-service.js
   ```

2. **部署 MCP 服务**（建议使用 systemd 或容器保持常驻）
   ```bash
   MCP_AUTO_START=true MCP_PORT=8788 node dist/mcp/server.js
   ```

3. **部署 Sentinel 服务**
   ```bash
   LANGGRAPH_WEBHOOK_URL="http://127.0.0.1:8788/webhook" node dist/index.js
   ```

4. **配置 LLM 环境变量**
   ```bash
   export OPENAI_API_KEY=""
   export OPENAI_MODEL="gpt-4o-mini"
   export OPENAI_BASE_URL=""
   export PROFILER_API_URL="http://127.0.0.1:8793/profile"
   export ANKR_API_KEY=""
   ```

5. **触发分析**
   - LangGraph 编排系统调用 `src/workflow/orchestrator.ts` 的 `runWorkflowFromMcp` 方法
   - 输出的 `llmReport` 可用于 Telegram 或其他下游系统

6. **端到端验证（真实市场）**
   ```bash
   npm run test:e2e:resolve
   E2E_MARKET_ID="<tokenId>" E2E_CONDITION_ID="<conditionId>" npm run test:e2e:prod
   ```

## 注意事项

- LangGraph 工作流仅示例最小链路，钱包画像通过 `PROFILER_API_URL` 获取。
- 若 `OPENAI_API_KEY` 未配置，工作流会抛出错误提示。
- Sentinel 异动处理与 `/check` 指令都会调用 LLM，并使用原始钱包画像进行分析后推送到 Telegram。
- LLM 输入不再包含机器打分与特征摘要，仅提供原始画像字段，并加入流动性/TVL 误报判断提示。
- Telegram 报错 `EFATAL/ECONNRESET` 通常是代理或网络中断导致。
