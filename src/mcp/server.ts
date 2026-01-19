import "dotenv/config";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { recordAnomaly, listRecentAnomalies } from "./anomalyStore.js";
import { AnomalyWebhookPayload } from "../sentinel/types.js";

function sendJson(res: ServerResponse, status: number, payload: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
}

function parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on("end", () => {
            if (!body) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function validatePayload(payload: any): payload is AnomalyWebhookPayload {
    return payload
        && payload.eventType === "market.anomaly"
        && payload.anomaly
        && payload.market
        && typeof payload.anomaly.marketId === "string"
        && typeof payload.market.marketId === "string";
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse) {
    try {
        const payload = await parseBody(req);
        if (!validatePayload(payload)) {
            sendJson(res, 400, { error: "无效的 Webhook payload" });
            return;
        }
        recordAnomaly(payload);
        sendJson(res, 200, { ok: true });
    } catch (error: any) {
        sendJson(res, 500, { error: error.message || "Webhook 处理失败" });
    }
}

async function handleToolCall(req: IncomingMessage, res: ServerResponse) {
    const requestBody = await parseBody(req);
    const { name, arguments: args } = requestBody || {};

    if (!name) {
        sendJson(res, 400, { error: "缺少 tool name" });
        return;
    }

    if (name === "list_anomalies") {
        const limit = typeof args?.limit === "number" ? args.limit : 20;
        sendJson(res, 200, { anomalies: listRecentAnomalies(limit) });
        return;
    }

    if (name === "analyze_market") {
        sendJson(res, 501, { error: "当前节点仅提供异动查询，画像分析由 LangGraph 侧执行" });
        return;
    }

    sendJson(res, 404, { error: "未知工具" });
}

async function handleToolList(_req: IncomingMessage, res: ServerResponse) {
    sendJson(res, 200, {
        tools: [
            {
                name: "list_anomalies",
                description: "列出最近的市场异动事件",
                inputSchema: {
                    type: "object",
                    properties: {
                        limit: { type: "number", description: "返回条数，默认 20" }
                    }
                }
            },
            {
                name: "analyze_market",
                description: "预留的分析工具（当前由 LangGraph 侧实现）",
                inputSchema: {
                    type: "object",
                    properties: {
                        tokenId: { type: "string", description: "市场 Token ID" }
                    },
                    required: ["tokenId"]
                }
            }
        ]
    });
}

export async function startMcpServer(port: number = 8788) {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        if (!req.url) {
            sendJson(res, 404, { error: "缺少路径" });
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

        if (req.method === "POST" && url.pathname === "/webhook") {
            await handleWebhook(req, res);
            return;
        }

        if (req.method === "POST" && url.pathname === "/mcp/tools/call") {
            await handleToolCall(req, res);
            return;
        }

        if (req.method === "GET" && url.pathname === "/mcp/tools/list") {
            await handleToolList(req, res);
            return;
        }

        sendJson(res, 404, { error: "未找到路径" });
    });

    await new Promise<void>(resolve => {
        server.listen(port, () => {
            console.log(`[MCP] 服务器已启动: http://127.0.0.1:${port}`);
            resolve();
        });
    });

    return server;
}

if (process.env.MCP_AUTO_START === "true") {
    const port = process.env.MCP_PORT ? Number(process.env.MCP_PORT) : 8788;
    startMcpServer(port).catch(error => {
        console.error("[MCP] 启动失败:", error);
        process.exit(1);
    });
}
