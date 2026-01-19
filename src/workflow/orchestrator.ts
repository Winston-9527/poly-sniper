import "dotenv/config";
import { AnomalyWebhookPayload, ScoreResult } from "../sentinel/types.js";
import { runWorkflow } from "./langgraphFlow.js";
import { runProfiler } from "./profilerRunner.js";

export interface WorkflowResult {
    llmReport: string;
}

async function fetchAnomalies(mcpBaseUrl: string) {
    const response = await fetch(`${mcpBaseUrl}/mcp/tools/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "list_anomalies", arguments: { limit: 1 } })
    });

    if (!response.ok) {
        throw new Error(`调用 MCP list_anomalies 失败: ${response.status}`);
    }

    const data = await response.json();
    return data.anomalies as AnomalyWebhookPayload[] || [];
}

async function loadWalletProfiles(anomaly: AnomalyWebhookPayload): Promise<ScoreResult[]> {
    if (process.env.WORKFLOW_USE_MOCK_WALLETS === "true") {
        return [
            {
                address: "0xMockWallet",
                totalScore: 88,
                profile: {
                    address: "0xMockWallet",
                    transactionCount: 5,
                    usdcBalance: 12000,
                    marketCount: 1,
                    eventCount: 1,
                    isNew: true
                },
                positionValue: 1250,
                breakdown: {
                    freshness: 30,
                    focus: 30,
                    position: 15,
                    correlation: 0,
                    capital: 10
                },
                details: ["Mock Wallet"]
            }
        ];
    }

    if (process.env.WORKFLOW_USE_MOCK_WALLETS === "false") {
        console.log("[Workflow] 使用真实钱包画像");
    }

    return runProfiler(anomaly);
}

export async function runWorkflowFromMcp(mcpBaseUrl: string): Promise<WorkflowResult> {
    const anomalies = await fetchAnomalies(mcpBaseUrl);
    if (anomalies.length === 0) {
        throw new Error("MCP 返回空异动列表");
    }

    const anomaly = anomalies[0];
    const wallets = await loadWalletProfiles(anomaly);

    const result = await runWorkflow({ anomaly, wallets });
    return {
        llmReport: result.llmReport
    };
}
