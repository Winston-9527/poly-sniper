/**
 * 组装依赖（供 index.ts、影子运行、工具脚本共用）。
 * 这里只做装配，不做业务判断。
 */
import { Config, loadConfig } from './config.js';
import { openDb, Db } from './db/Database.js';
import { Repos } from './db/repos.js';
import { HttpClient, RequestBudget } from './sources/http.js';
import { DataApiClient } from './sources/DataApi.js';
import { ChainSource } from './sources/Chain.js';
import { Collector } from './ledger/Collector.js';
import { LedgerPipeline } from './ledger/Pipeline.js';
import { AlertOutbox } from './alerts/Outbox.js';
import { Reports } from './report/Reports.js';
import { LedgerBot } from './bot/Bot.js';

export interface App {
    config: Config; db: Db; repos: Repos; http: HttpClient; budget: RequestBudget;
    dataApi: DataApiClient; chain: ChainSource; collector: Collector; outbox: AlertOutbox;
    reports: Reports; pipeline: LedgerPipeline; bot: LedgerBot;
    log: (m: string) => void;
    close(): void;
}

export function createApp(overrides: { config?: Partial<Config>; dbPath?: string; now?: () => Date; silent?: boolean } = {}): App {
    const base = loadConfig();
    const config: Config = { ...base, ...overrides.config } as Config;
    const db = openDb(overrides.dbPath ?? config.dbPath);
    const repos = new Repos(db);
    const budget = new RequestBudget(config.budgets.requestsPerCycle);
    const log = overrides.silent ? () => { } : (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
    const http = new HttpClient({
        proxyUrl: config.proxyUrl, budget, spacingMs: config.budgets.requestSpacingMs,
        timeoutMs: 25000, retries: 2, logger: log,
    });
    const dataApi = new DataApiClient(http);
    const chain = new ChainSource(http);
    const collector = new Collector({ repos, dataApi, chain, config, budget, log });
    const reports = new Reports(repos, config);
    const outbox = new AlertOutbox(repos, config, async () => ({ ok: false, error: '未接入发送器' }), log);
    const pipeline = new LedgerPipeline({ repos, collector, config, outbox, log, now: overrides.now });
    const bot = new LedgerBot({ config, repos, reports, pipeline, outbox, dataApi, log });
    outbox.setSender(bot.sender);
    return {
        config, db, repos, http, budget, dataApi, chain, collector, outbox, reports, pipeline, bot, log,
        close: () => db.close(),
    };
}
