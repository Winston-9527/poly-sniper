import "dotenv/config";
import { Annotation, StateGraph, END, START } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { AnomalyWebhookPayload, ScoreResult } from "../sentinel/types.js";
import { WorkflowState } from "./types.js";

export interface WorkflowInput {
    anomaly: AnomalyWebhookPayload;
    wallets: ScoreResult[];
}

export interface WorkflowOutput {
    llmReport: string;
    status: "ok" | "error";
    errorMessage?: string;
}

const StateAnnotation = Annotation.Root({
    anomaly: Annotation<AnomalyWebhookPayload | undefined>,
    wallets: Annotation<ScoreResult[]>,
    llmReport: Annotation<string | undefined>
});

const DEFAULT_STATE: WorkflowState = {
    anomaly: undefined,
    wallets: [],
    llmReport: undefined
};

function ensureApiKey() {
    const apiKey = process.env.OPENAI_API_KEY || "";
    if (!apiKey) {
        throw new Error("缺少 OPENAI_API_KEY，请在环境变量中配置");
    }
    return apiKey;
}

async function buildPrompt(state: WorkflowState): Promise<string> {
    const anomaly = state.anomaly;
    if (!anomaly) {
        return "未提供异动信息";
    }

    const walletSummary = state.wallets && state.wallets.length > 0
        ? state.wallets
            .slice(0, 10)
            .map((wallet, index) => {
                const profile = wallet.profile;
                const funding = profile.fundingAddress || "未知";
                const firstSeen = profile.firstSeenTimestamp
                    ? new Date(profile.firstSeenTimestamp * 1000).toLocaleString()
                    : "未知";
                const balance = Number.isFinite(profile.usdcBalance) ? profile.usdcBalance.toFixed(2) : "0.00";
                const positionValue = Number.isFinite(wallet.positionValue) ? wallet.positionValue.toFixed(2) : "0.00";
                const eventCount = profile.eventCount ?? profile.marketCount;
                return `${index + 1}. 地址 ${wallet.address} | 持仓价值 ${positionValue} | 交易数 ${profile.transactionCount} | 参与市场 ${profile.marketCount} | 事件数 ${eventCount} | USDC余额 ${balance} | 资金来源 ${funding} | 首次活动 ${firstSeen}`;
            })
            .join("\n")
        : "未发现持仓钱包";

    const liquidity = anomaly.market.liquidity ?? 0;
    const tvl = anomaly.market.tvl ?? liquidity;
    const volume = anomaly.market.volume ?? 0;

    return `你是 Polymarket 内幕交易分析助手。请基于原始钱包画像数据与市场异动信息做判断，不要依赖任何机器打分。

市场：${anomaly.market.title}
分类：${anomaly.market.category}
流动性：${liquidity}
TVL/成交量：${tvl}
累计成交额：${volume}
价格变化：${anomaly.anomaly.previousPrice.toFixed(4)} -> ${anomaly.anomaly.currentPrice.toFixed(4)} (${anomaly.anomaly.changePercentage})
时间：${new Date(anomaly.detectedAt).toLocaleString()}

分析要点：
- 若流动性很低，小额市价单即可造成明显波动，需避免误判。
- 若流动性很高，3%-5% 的价格异动通常更显著，需重点排查。
- 典型内幕钱包特征：新钱包、大额入金、重仓单一市场或同类市场、资金来源异常（如混币/大额来源）。

钱包原始画像：
${walletSummary}

输出要求：
1. 给出是否存在内幕嫌疑的判断（高/中/低）
2. 用 3-5 条要点说明原因（包含流动性/TVL影响）
3. 最后给出一句风险提示
`;
}

async function runLlm(state: WorkflowState) {
    if (process.env.WORKFLOW_USE_MOCK_LLM === "true") {
        return {
            llmReport: "[Mock] 内幕嫌疑：中\n- 低流动性市场易被小额冲击\n- 钱包多为新地址且交易次数偏低\n- 需结合资金来源与单一市场集中度确认\n风险提示：注意低流动性导致的误判"
        };
    }

    if (process.env.WORKFLOW_USE_MOCK_LLM === "false") {
        console.log("[Workflow] 使用真实 LLM 进行分析");
    }

    ensureApiKey();
    const baseURL = process.env.OPENAI_BASE_URL || "";
    const model = new ChatOpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.2,
        configuration: baseURL ? { baseURL } : undefined
    });

    const prompt = await buildPrompt(state);
    const response = await model.invoke(prompt);

    return {
        llmReport: response.content.toString()
    };
}

export function buildLangGraphWorkflow() {
    const graph = new StateGraph(StateAnnotation)
        .addNode("llm", runLlm)
        .addEdge(START, "llm")
        .addEdge("llm", END);

    return graph.compile();
}

export async function runWorkflow(input: WorkflowInput): Promise<WorkflowOutput> {
    const workflow = buildLangGraphWorkflow();
    const result = await workflow.invoke({
        ...DEFAULT_STATE,
        anomaly: input.anomaly,
        wallets: input.wallets
    });

    return {
        llmReport: result.llmReport || "",
        status: "ok"
    };
}

export async function runWorkflowFromInputs(anomaly: AnomalyWebhookPayload, wallets: ScoreResult[]): Promise<WorkflowOutput> {
    return runWorkflow({ anomaly, wallets });
}

export function buildErrorWorkflowResult(message: string): WorkflowOutput {
    return {
        llmReport: message,
        status: "error",
        errorMessage: message
    };
}
