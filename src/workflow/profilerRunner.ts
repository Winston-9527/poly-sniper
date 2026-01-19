import "dotenv/config";
import { fetch, ProxyAgent } from "undici";
import { AnomalyWebhookPayload, ScoreResult } from "../sentinel/types.js";
import { isLocalProfilerUrl } from "./analysisRunner.js";

export async function runProfiler(anomaly: AnomalyWebhookPayload): Promise<ScoreResult[]> {
    if (process.env.PROFILER_API_URL) {
        const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
        const profilerUrl = process.env.PROFILER_API_URL;
        const isLocalProfiler = isLocalProfilerUrl(profilerUrl);
        const dispatcher = proxyUrl && !isLocalProfiler ? new ProxyAgent(proxyUrl) : undefined;
        const response = await fetch(profilerUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                tokenId: anomaly.market.marketId,
                conditionId: anomaly.market.conditionId,
                currentPrice: anomaly.anomaly.currentPrice
            }),
            dispatcher
        } as any);

        if (!response.ok) {
            throw new Error(`调用 PROFILER_API_URL 失败: ${response.status}`);
        }

        const data = await response.json() as any;
        return data.results as ScoreResult[] || [];
    }

    throw new Error("未配置 PROFILER_API_URL，无法在 ESM 模式下调用 Profiler");
}
