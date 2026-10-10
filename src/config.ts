/**
 * 运行配置。所有阈值都是「可配置假设」，带版本号（方案 §7.3）：
 * 阈值先作为可配置假设，保存版本，经过影子运行后调整。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadDotEnv(path = resolve(process.cwd(), '.env')): Record<string, string> {
    if (!existsSync(path)) return {};
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (/^\s*#/.test(line)) continue;
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    return out;
}
const dotenv = loadDotEnv();
function envStr(key: string, def = ''): string { return process.env[key] ?? dotenv[key] ?? def; }
function envNum(key: string, def: number): number { const v = Number(envStr(key, String(def))); return Number.isFinite(v) ? v : def; }
function envBool(key: string, def: boolean): boolean {
    const v = envStr(key, def ? '1' : '0').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}
function envList(key: string): string[] {
    return envStr(key, '').split(',').map((s) => s.trim()).filter(Boolean);
}

export const RULES_VERSION = 'p1-rules-2';
export const ALGORITHM_VERSION = 'p1-1';
/** 契约版本：来源字段/口径变动时递增，落库到 source_records.contract_version */
export const CONTRACT_VERSION = 'data-api-2026-10-09';

export interface Config {
    dbPath: string;
    backupDir: string;
    proxyUrl?: string;
    telegram: { token: string; chatIds: string[]; enabled: boolean };
    shadowMode: boolean;
    budgets: {
        /** 每轮全局 HTTP 请求预算（所有来源共享） */
        requestsPerCycle: number;
        /** 每轮每入口最多纳入多少个新候选 */
        newCandidatesPerCycle: number;
        /** 单钱包单次增量采集最多翻几页 */
        activityPagesPerPull: number;
        /** 单钱包单次完整补全最多翻几页 */
        backfillMaxPages: number;
        /** 每轮最多处理多少个到期关注对象 */
        walletsPerCycle: number;
        /** 每个来源请求并发数 */
        concurrency: number;
        /** 页面间隔（毫秒），礼貌抓取 */
        requestSpacingMs: number;
    };
    rules: {
        /** 显著成交入口：单笔成交名义金额下限（USDC） */
        significantTradeNotional: number;
        /** 显著成交入口：同向累计金额下限 */
        significantTradeSum: number;
        /** 显著成交入口：在窗口内观察多少小时内的成交 */
        tradeWindowHours: number;
        /** 重要存量持有人入口：取持仓排名前 N */
        holderTopN: number;
        /** 存量持有人最低持仓份数（过滤灰尘） */
        holderMinSize: number;
        /** 减仓：变动比例下限（相对自身持仓），如 0.15 = 15% */
        reducePctThreshold: number;
        /** 显著变化：相对该钱包历史典型规模的倍数下限 */
        relativeSizeMultiplier: number;
        /** 绝对规模下限（名义 USDC），低于此不进入高优先级 */
        absoluteNotionalFloor: number;
        /** 新出现持仓：达到「绝对下限 × 该倍数」判高优先级 */
        positionOpenHighMultiplier: number;
        /** 钱包关注等级：关注后多久采一次（分钟） */
        collectIntervalMinutes: { manual: number; majorHolder: number; lowfreq: number };
        /** 沉寂后恢复：静默至少多少小时 */
        reactivationHours: number;
        /** 画像基线窗口（天） */
        baselineWindowsDays: number[];
        /** 增量重叠读取窗口（小时）：处理延迟数据 */
        incrementalOverlapHours: number;
        /** 单条告警冷却（分钟）：同一钱包/市场/行为过程 */
        alertCooldownMinutes: number;
        // ---- 市场异动（首要信号）----
        /** 价格异动阈值（概率差）：0.05 = 5 个百分点 */
        marketPriceMove: number;
        marketPriceMoveHigh: number;
        /** 异动观察窗口（分钟） */
        marketWindowMinutes: number;
        /** 盘口走阔：spread/中间价 */
        marketSpreadRatio: number;
        marketSpreadRatioHigh: number;
        /** 价差相对上一条的放大倍数（判定「变宽」而不是「本来宽」） */
        marketSpreadGrowth: number;
        /** 中间价下限（分币市场不判相对价差）与绝对价差下限 */
        marketMinMidPrice: number;
        marketMinAbsSpread: number;
        /** 成交量突增倍数 */
        marketVolumeSurge: number;
        marketVolumeSurgeHigh: number;
        /** 最低 24h 成交量 / 流动性（过滤死市场） */
        marketMinVolume24h: number;
        marketMinLiquidity: number;
        /** 每轮扫描多少页活跃市场（每页 500 个市场） */
        marketScanPages: number;
    };
    push: { maxPerMinute: number; maxPerDay: number; maxHighPerDay: number; maxPerCycleAlerts: number; maxMarketPerCycle: number; maxAttempts: number; retryBackoffSeconds: number[] };
    /** 历史补全：只有在实现了可核验的补充来源后才打开 */
    backfill: { enabled: boolean };
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(): Config {
    const home = process.env.HOME || '';
    return {
        dbPath: resolve(envStr('DB_PATH', `${home}/Projects/poly-sniper/data/poly-sniper.sqlite`)),
        backupDir: resolve(envStr('BACKUP_DIR', `${home}/Projects/poly-sniper/data/backups`)),
        proxyUrl: envStr('https_proxy') || envStr('HTTPS_PROXY') || envStr('http_proxy') || envStr('HTTP_PROXY') || undefined,
        telegram: {
            token: envStr('TELEGRAM_BOT_TOKEN'),
            chatIds: envList('TELEGRAM_CHAT_ID'),
            enabled: envBool('TELEGRAM_ENABLED', false),
        },
        // 影子模式默认打开：新采集器先影子运行核对样本，再启用推送（方案 §13）
        shadowMode: envBool('SHADOW_MODE', true),
        budgets: {
            requestsPerCycle: envNum('REQUESTS_PER_CYCLE', 220),
            newCandidatesPerCycle: envNum('NEW_CANDIDATES_PER_CYCLE', 40),
            activityPagesPerPull: envNum('ACTIVITY_PAGES_PER_PULL', 2),
            backfillMaxPages: envNum('BACKFILL_MAX_PAGES', 8),
            walletsPerCycle: envNum('WALLETS_PER_CYCLE', 60),
            concurrency: envNum('COLLECT_CONCURRENCY', 3),
            requestSpacingMs: envNum('REQUEST_SPACING_MS', 120),
        },
        rules: {
            significantTradeNotional: envNum('SIGNIFICANT_TRADE_NOTIONAL', 5000),
            significantTradeSum: envNum('SIGNIFICANT_TRADE_SUM', 25000),
            tradeWindowHours: envNum('TRADE_WINDOW_HOURS', 72),
            holderTopN: envNum('HOLDER_TOP_N', 20),
            holderMinSize: envNum('HOLDER_MIN_SIZE', 10000),
            reducePctThreshold: envNum('REDUCE_PCT_THRESHOLD', 0.15),
            relativeSizeMultiplier: envNum('RELATIVE_SIZE_MULTIPLIER', 3),
            absoluteNotionalFloor: envNum('ABSOLUTE_NOTIONAL_FLOOR', 10000),
            positionOpenHighMultiplier: envNum('POSITION_OPEN_HIGH_MULTIPLIER', 3),
            collectIntervalMinutes: {
                manual: envNum('COLLECT_INTERVAL_MANUAL_MIN', 15),
                majorHolder: envNum('COLLECT_INTERVAL_HOLDER_MIN', 60),
                lowfreq: envNum('COLLECT_INTERVAL_LOWFREQ_MIN', 720),
            },
            reactivationHours: envNum('REACTIVATION_HOURS', 24 * 30),
            baselineWindowsDays: envList('BASELINE_WINDOWS_DAYS').map(Number).filter((n) => n > 0).length
                ? envList('BASELINE_WINDOWS_DAYS').map(Number).filter((n) => n > 0) : [30, 90],
            incrementalOverlapHours: envNum('INCREMENTAL_OVERLAP_HOURS', 3),
            alertCooldownMinutes: envNum('ALERT_COOLDOWN_MINUTES', 30),
            // ---- 市场异动（首要信号）----
            marketPriceMove: envNum('MARKET_PRICE_MOVE', 0.05),
            marketPriceMoveHigh: envNum('MARKET_PRICE_MOVE_HIGH', 0.10),
            marketWindowMinutes: envNum('MARKET_WINDOW_MINUTES', 15),
            marketSpreadRatio: envNum('MARKET_SPREAD_RATIO', 0.10),
            marketSpreadRatioHigh: envNum('MARKET_SPREAD_RATIO_HIGH', 0.25),
            marketSpreadGrowth: envNum('MARKET_SPREAD_GROWTH', 1.5),
            marketMinMidPrice: envNum('MARKET_MIN_MID_PRICE', 0.05),
            marketMinAbsSpread: envNum('MARKET_MIN_ABS_SPREAD', 0.01),
            marketVolumeSurge: envNum('MARKET_VOLUME_SURGE', 3),
            marketVolumeSurgeHigh: envNum('MARKET_VOLUME_SURGE_HIGH', 8),
            marketMinVolume24h: envNum('MARKET_MIN_VOLUME_24H', 5000),
            marketMinLiquidity: envNum('MARKET_MIN_LIQUIDITY', 5000),
            marketScanPages: envNum('MARKET_SCAN_PAGES', 3),
        },
        push: {
            maxPerMinute: envNum('MAX_ALERTS_PER_MIN', 6),
            // 日上限是防刷屏的硬闸：超过后不再即时推送，全部并入当日摘要，次日只发一条汇总
            maxPerDay: envNum('MAX_ALERTS_PER_DAY', 24),
            // 高优先级独立预算：high 不被普通日上限挤掉，但仍有自己的硬顶（默认 20 条/天）
            maxHighPerDay: envNum('MAX_HIGH_PER_DAY', 20),
            // 每轮最多入队几条（优先高优先级），其余事件照常记录但不推送
            maxPerCycleAlerts: envNum('MAX_ALERTS_PER_CYCLE', 4),
            // 每轮最多入队几条市场异动（首要信号，独立于钱包事件上限）
            maxMarketPerCycle: envNum('MAX_MARKET_ALERTS_PER_CYCLE', 6),
            maxAttempts: envNum('PUSH_MAX_ATTEMPTS', 5),
            retryBackoffSeconds: [30, 120, 600, 1800, 7200],
        },
        backfill: { enabled: envBool('BACKFILL_ENABLED', false) },
        logLevel: (envStr('LOG_LEVEL', 'info') as Config['logLevel']),
    };
}
