import { fetch, ProxyAgent } from "undici";
import { Profiler } from "../sentinel/Profiler.js";
import { AnomalyWebhookPayload, ScoreResult } from "../sentinel/types.js";

export interface WalletRetryResult {
    status: "ok" | "error";
    wallets: ScoreResult[];
    errorMessage?: string;
    attempts: number;
}

let highPriorityCount = 0;
let highPriorityPauseUntil = 0;
const highPriorityMaxPauseMs = Number(process.env.HIGH_PRIORITY_POLLING_PAUSE_MS || 60000);
const highPriorityPauseEnabled = process.env.HIGH_PRIORITY_POLLING_PAUSE_ENABLED === "true";

export function isHighPriorityActive(): boolean {
    return highPriorityCount > 0;
}

export function shouldPausePolling(): boolean {
    if (!highPriorityPauseEnabled) {
        return false;
    }
    if (highPriorityCount === 0) {
        return false;
    }
    return Date.now() < highPriorityPauseUntil;
}

export async function withHighPriority<T>(label: string, action: () => Promise<T>): Promise<T> {
    highPriorityCount += 1;
    if (highPriorityPauseEnabled) {
        highPriorityPauseUntil = Math.max(highPriorityPauseUntil, Date.now() + highPriorityMaxPauseMs);
    }
    console.log(`[Priority] ${label} 开始，高优先级任务数: ${highPriorityCount}`);
    try {
        return await action();
    } finally {
        highPriorityCount = Math.max(0, highPriorityCount - 1);
        console.log(`[Priority] ${label} 结束，高优先级任务数: ${highPriorityCount}`);
    }
}

function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function isLocalProfilerUrl(url: string): boolean {
    try {
        const { hostname } = new URL(url);
        return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    } catch {
        return false;
    }
}

export function shouldUseRemoteProfiler(): boolean {
    const profilerUrl = process.env.PROFILER_API_URL || "";
    return Boolean(profilerUrl) && !isLocalProfilerUrl(profilerUrl);
}

export async function fetchWalletProfilesWithRetry(
    fetcher: () => Promise<ScoreResult[]>,
    maxAttempts: number = Number(process.env.WALLET_PROFILE_RETRY_TIMES || 3),
    retryDelayMs: number = Number(process.env.WALLET_PROFILE_RETRY_DELAY_MS || 1500)
): Promise<WalletRetryResult> {
    let lastError: any;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const wallets = await fetcher();
            if (wallets.length > 0) {
                return {
                    status: "ok",
                    wallets,
                    attempts: attempt
                };
            }

            lastError = new Error("未获取到钱包画像数据");
        } catch (error: any) {
            lastError = error;
        }

        if (attempt < maxAttempts) {
            await delay(retryDelayMs * attempt);
        }
    }

    return {
        status: "error",
        wallets: [],
        attempts: maxAttempts,
        errorMessage: `钱包画像获取失败，请稍后再试。${lastError?.message ? `(${lastError.message})` : ""}`
    };
}

export async function fetchWalletProfilesFromProfiler(
    profiler: Profiler,
    payload: AnomalyWebhookPayload
): Promise<WalletRetryResult> {
    console.log("[Profiler] 使用本地 Profiler 获取画像 (进程内) ");
    return fetchWalletProfilesWithRetry(() => profiler.analyzeMarket(
        payload.anomaly.marketId,
        payload.market.conditionId,
        payload.anomaly.currentPrice
    ));
}

export async function fetchWalletProfilesFromRemote(payload: AnomalyWebhookPayload): Promise<WalletRetryResult> {
    if (!process.env.PROFILER_API_URL) {
        return {
            status: "error",
            wallets: [],
            attempts: 0,
            errorMessage: "未配置 PROFILER_API_URL，无法获取钱包画像"
        };
    }

    const profilerUrl = process.env.PROFILER_API_URL || "";
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
    const isLocalProfiler = isLocalProfilerUrl(profilerUrl);
    const dispatcher = proxyUrl && !isLocalProfiler ? new ProxyAgent(proxyUrl) : undefined;
    console.log(`[Profiler] 使用远程 Profiler: ${profilerUrl}`);
    if (proxyUrl && !isLocalProfiler) {
        console.log(`[Profiler] 远程调用使用代理: ${proxyUrl}`);
    }
    if (proxyUrl && isLocalProfiler) {
        console.log("[Profiler] 本地 Profiler 跳过代理");
    }

    return fetchWalletProfilesWithRetry(async () => {
        const response = await fetch(profilerUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                tokenId: payload.anomaly.marketId,
                conditionId: payload.market.conditionId,
                currentPrice: payload.anomaly.currentPrice
            }),
            dispatcher
        } as any);

        if (!response.ok) {
            throw new Error(`调用 PROFILER_API_URL 失败: ${response.status}`);
        }

        const data = await response.json() as any;
        return data.results as ScoreResult[] || [];
    });
}
