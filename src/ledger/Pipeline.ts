/**
 * 流水线：采集 → 持仓过程 → 账本 → 行为事件 → 报告队列（方案 §4）。
 * 原始采集、事实归一化、派生分析、消息发送彼此分离；采集失败不产生「未发现异常」的成功报告。
 */
import { Repos } from '../db/repos.js';
import { Config, RULES_VERSION } from '../config.js';
import { Collector } from './Collector.js';
import { PositionLedger, ActivityRow, LedgerIssue } from './PositionLedger.js';
import { Profiler } from './Profiler.js';
import { AlertOutbox } from '../alerts/Outbox.js';
import { Reports, BehaviorRow, MarketAnomalyRow } from '../report/Reports.js';
import { buildBehavior, ChangeForBehavior, PriorityRules, isReactivation } from './Behaviors.js';
import { MarketScanner, MarketSnapshot, AnomalyRules, detectAnomaly, anomalyRulesFromConfig } from '../market/MarketScanner.js';
import { decToString, fromDb, parseDec, mul, div, decToNumber, Dec } from '../util/decimal.js';
import { nowIso } from '../util/time.js';

export interface ProcessResult {
    wallet: string;
    collected: { activityInserted: number; pages: number; stopped: string; warnings: string[]; error?: string };
    ledger: { applied: number; skippedHistory: number; issues: LedgerIssue[] };
    eventsCreated: number;
    eventIds: number[];
    /** 本轮实际入队的报警数 */
    alertsEnqueued: number;
    /** 记录但未推送的事件数（每轮入队上限 / 低优先级） */
    alertsSuppressed: number;
    gaps: number;
}

export interface CycleReport {
    startedAt: string;
    finishedAt: string;
    /** 市场扫描（首要信号） */
    marketScan: { observed: number; markets: number; stoppedBecause: string } | null;
    marketAnomalies: { created: number; enqueued: number; byKind: Record<string, number> };
    markets: string[];
    discovered: { market: string; added: number; skippedOverBudget: number; byEntry: Record<string, number> }[];
    processed: number;
    events: number;
    queued: number;
    /** 记录但未推送的事件数 */
    suppressed: number;
    flush: { sent: number; failed: number; retried: number; dead: number; merged: number } | null;
    warnings: string[];
}

export class LedgerPipeline {
    readonly collector: Collector;
    readonly ledger: PositionLedger;
    readonly profiler: Profiler;
    readonly reports: Reports;
    private cycles = 0;
    private lastCycleAt: string | null = null;
    /** 本轮已入队的报警数（每轮上限，防一轮打满消息） */
    private cycleEnqueued = 0;
    /** 本轮已入队的市场异动数（独立上限：异动是首要信号，不被钱包事件挤掉） */
    private cycleMarketEnqueued = 0;

    constructor(private deps: {
        repos: Repos; collector: Collector; config: Config; outbox: AlertOutbox;
        scanner?: MarketScanner;
        log: (m: string) => void; now?: () => Date;
    }) {
        this.collector = deps.collector;
        this.ledger = new PositionLedger(deps.repos);
        this.profiler = new Profiler(deps.repos);
        this.reports = new Reports(deps.repos, deps.config);
    }
    private get repos() { return this.deps.repos; }
    private now(): Date { return this.deps.now ? this.deps.now() : new Date(); }

    private priorityRules(): PriorityRules {
        const r = this.deps.config.rules;
        return {
            absoluteNotionalFloor: r.absoluteNotionalFloor,
            reducePctThreshold: r.reducePctThreshold,
            relativeSizeMultiplier: r.relativeSizeMultiplier,
            reactivationHours: r.reactivationHours,
            alertCooldownMinutes: r.alertCooldownMinutes,
            openHighMultiplier: r.positionOpenHighMultiplier,
        };
    }

    /**
     * 处理一个关注对象。skipNetwork=true 时不发网络请求（用于测试与离线重算）。
     */
    async processWallet(address: string, marketConditionId = '', opts: { skipNetwork?: boolean; cold?: boolean } = {}): Promise<ProcessResult> {
        const w = address.toLowerCase();
        const issues: LedgerIssue[] = [];
        const warnings: string[] = [];
        let activityInserted = 0, pages = 0, stopped = 'skipped', error: string | undefined;

        this.repos.ensureWallet(w);
        const walletRow = this.repos.db.get<{ first_seen_at: string }>('SELECT first_seen_at FROM wallets WHERE address=?', w);
        const observationStart = walletRow?.first_seen_at ?? nowIso();

        if (!opts.skipNetwork) {
            const cold = opts.cold ?? this.repos.activityCount(w) === 0;
            const act = await this.collector.collectActivity(w, { cold });
            activityInserted = act.inserted; pages = act.pages; stopped = act.stoppedBecause; error = act.error;
            warnings.push(...act.warnings);
            // 控制关系（只在第一次或事件后取，避免请求放大）
            if (cold) {
                const rel = await this.collector.collectControlRelations(w);
                if (rel.status === 'unknown') warnings.push('控制关系读不出（未知，不等于无关联）');
            }
        }

        // ---- 1. 快照开过程 ----
        let positions: { tokenId: string; conditionId: string; outcome: string | null; size: string | null; price: string | null; value: string | null; redeemable: boolean | null }[] = [];
        if (!opts.skipNetwork) {
            const snap = await this.collector.collectPositions(w);
            positions = snap.positions;
            warnings.push(...snap.outcome.warnings);
            if (snap.outcome.error) error = snap.outcome.error;
        } else {
            positions = this.repos.latestPositionSnapshots(w).map((s) => ({
                tokenId: String(s.token_id), conditionId: String(s.condition_id ?? ''), outcome: (s.outcome as string | null),
                size: s.size as string | null, price: s.price as string | null, value: s.current_value as string | null,
                redeemable: s.redeemable === null ? null : Number(s.redeemable) === 1,
            }));
        }
        // 无论联网与否，都用当前快照开启/续接持仓过程（观察起点，不补造历史成本）
        for (const p of positions) {
            const size = parseDec(p.size);
            if (size === null || size === 0n) continue;
            const opened = this.ledger.openFromSnapshot({
                wallet: w, tokenId: p.tokenId, conditionId: p.conditionId, outcome: p.outcome, size,
                snapshotAt: (this.repos.db.get<{ snapshot_at: string }>(
                    'SELECT MAX(snapshot_at) AS snapshot_at FROM position_snapshots WHERE wallet=? AND token_id=?', w, p.tokenId,
                )?.snapshot_at) ?? nowIso(),
            });
            if (opened.issue) issues.push(opened.issue);
        }

        // ---- 2. 活动入账 ----
        let applied = 0, skippedHistory = 0;
        const changes: { change: ChangeForBehavior; price: Dec | null; sourceNote: string }[] = [];
        for (const row of this.repos.unappliedActivities(w)) {
            const a = row as unknown as ActivityRow;
            // 活动所属的市场/token 先在库里登记：position_episodes 对 markets 有外键，
            // 未登记的市场会让持仓过程建不起来（曾经导致整轮采集失败）。
            if (a.condition_id) {
                this.repos.upsertMarket({ conditionId: a.condition_id });
                if (a.token_id) this.repos.upsertOutcomeToken({ tokenId: a.token_id, conditionId: a.condition_id, outcome: a.outcome ?? null, outcomeIndex: null });
            }
            const epBefore = a.token_id ? this.repos.openEpisodeFor(w, a.token_id) : undefined;
            const laterThanStart = a.event_at >= (epBefore ? String(epBefore.opened_at) : observationStart);
            if (!laterThanStart) {
                // 观察起点之前的历史：只用于画像，不进账本（方案 §6.3：不补造历史买入成本）
                this.repos.markActivityProcessed(a.id, 'pre_observation_history', `早于观察起点（${epBefore ? 'episode ' + epBefore.id : '首次观察'}）`);
                skippedHistory++;
                continue;
            }
            const res = this.ledger.applyActivity(a);
            if (res.issue) issues.push(res.issue);
            if (!res.change) {
                this.repos.markActivityProcessed(a.id, 'skipped', res.issue?.detail ?? '无份数变化');
                continue;
            }
            applied++;
            this.repos.markActivityProcessed(a.id, 'ledger_applied');
            if (res.change.quantified || res.change.kind === 'unexplained') {
                const epId = a.token_id ? Number(this.repos.openEpisodeFor(w, a.token_id)?.id ?? 0) : 0;
                const epRow = epId ? this.repos.episodeById(epId) : undefined;
                const entries = epId ? this.repos.ledgerForEpisode(epId) : [];
                changes.push({
                    change: {
                        wallet: w, conditionId: a.condition_id ?? '', tokenId: a.token_id ?? '', outcome: a.outcome ?? epRow?.outcome as string | null,
                        episodeId: epId, episodeOpenedAt: String(epRow?.opened_at ?? a.event_at), kind: res.change.kind,
                        quantified: res.change.quantified, deltaSize: res.change.deltaSize, sizeBefore: res.change.sizeBefore,
                        sizeAfter: res.change.sizeAfter, cashDelta: res.change.cashDelta, price: parseDec(a.price),
                        reachedZero: res.change.reachedZero, oversold: res.change.oversold, eventAt: a.event_at,
                        ledgerEntryIds: entries.slice(-1).map((x) => Number(x.id)),
                        unsupportedSource: !res.change.quantified && res.change.kind !== 'unexplained' ? true : (res.change.kind === 'unexplained'),
                    },
                    price: parseDec(a.price),
                    sourceNote: `${a.type}${a.side ? ' ' + a.side : ''}`,
                });
            }
        }

        // ---- 3. 对账 ----
        const snapByToken = new Map(positions.map((p) => [p.tokenId, p]));
        for (const [tokenId, p] of snapByToken) {
            const rec = this.ledger.reconcileWithSnapshot({ wallet: w, tokenId, snapshotSize: parseDec(p.size), completeness: 'complete', snapshotAt: nowIso() });
            if (rec.issue) issues.push(rec.issue);
            if (rec.confirmed) this.repos.resolveGap('wallet', `${w}:${tokenId}`, 'unexplained_change');
        }
        // 账本里有过程、但快照里没有该 token：不能判定为 0
        for (const ep of this.repos.db.all<{ token_id: string; last_size: string; status: string }>(
            `SELECT token_id, last_size, status FROM position_episodes WHERE wallet=? AND status='open'`, w,
        )) {
            if (snapByToken.has(ep.token_id)) continue;
            const derived = parseDec(ep.last_size);
            if (derived !== null && derived > 0n) {
                issues.push({ scope: 'wallet', key: `${w}:${ep.token_id}`, reason: 'incomplete_record', detail: `账本推导仍有 ${decToString(derived)} 份，但持仓快照里没有该 token（可能是灰尘仓位或分页截断）：不能判定为 0` });
            }
        }

        // ---- 4. 行为事件 ----
        const rules = this.priorityRules();
        const priceMissing = changes.some((c) => c.price === null);
        const profile = this.profiler.build(w, { windowsDays: this.deps.config.rules.baselineWindowsDays });
        const typical = parseDec(profile.tradeNotional.p50);
        const lastActivityBefore = this.repos.db.get<{ event_at: string }>(
            `SELECT event_at FROM wallet_activities WHERE wallet=? AND event_at < ? ORDER BY event_at DESC LIMIT 1`,
            w, changes.length ? changes[0].change.eventAt : nowIso(),
        );
        let eventsCreated = 0; const eventIds: number[] = []; let queued = 0; let alertsSuppressed = 0;
        const pushRows: BehaviorRow[] = [];
        for (const c of changes.slice().sort((x, y) => Date.parse(x.change.eventAt) - Date.parse(y.change.eventAt))) {
            const notional = c.change.deltaSize !== null && c.price !== null ? mul(c.change.deltaSize < 0n ? -c.change.deltaSize : c.change.deltaSize, c.price) : null;
            const relative = notional !== null && typical !== null && typical !== 0n ? div(notional, typical) : null;
            const ep = c.change.episodeId ? this.repos.episodeById(c.change.episodeId) : undefined;
            const openDays = ep ? (Date.parse(c.change.eventAt) - Date.parse(String(ep.opened_at))) / 86400_000 : 0;
            const priorEvents = this.repos.db.get<{ n: number }>(
                `SELECT COUNT(*) AS n FROM behavior_events WHERE wallet=? AND token_id=? AND event_type IN ('position_reduced','position_exited') AND event_at < ?`,
                w, c.change.tokenId, c.change.eventAt,
            );
            const out = buildBehavior(c.change, {
                rules, ruleVersion: RULES_VERSION, relativeMultiplier: relative,
                firstTimeLongTermChange: openDays >= 90 && (priorEvents?.n ?? 0) === 0 && (c.change.kind === 'trade_sell'),
                priceMissing: c.price === null,
                ledgerEntryIds: c.change.ledgerEntryIds,
                snapshotConfirmedZero: c.change.reachedZero
                    ? (snapByToken.has(c.change.tokenId) ? (parseDec(snapByToken.get(c.change.tokenId)?.size ?? null) === 0n) : false)
                    : undefined,
                extraEvidence: { sourceNote: c.sourceNote, relativeToTypicalP50: relative === null ? null : decToString(relative), typicalP50: profile.tradeNotional.p50, aggregationWindowMinutes: this.deps.config.rules.alertCooldownMinutes },
                observedAt: nowIso(),
            });
            if (!out) continue;
            const inserted = this.repos.insertBehaviorEvent({
                dedupeKey: out.dedupeKey, wallet: out.wallet, conditionId: out.conditionId, tokenId: out.tokenId,
                eventType: out.eventType, magnitude: out.magnitude, evidence: out.evidence, dataQuality: out.dataQuality,
                priority: out.priority, priorityReason: out.priorityReason, ruleVersion: out.ruleVersion,
                eventAt: out.eventAt, observedAt: out.observedAt,
            });
            if (inserted.inserted) { eventsCreated++; eventIds.push(inserted.id); }
            // 沉寂后恢复：单独记一条（消息保留原始顺序）
            if (isReactivation(lastActivityBefore?.event_at ?? null, c.change.eventAt, this.deps.config.rules.reactivationHours)) {
                const react = buildBehavior({ ...c.change, kind: 'unexplained', deltaSize: null, quantified: false, unsupportedSource: false, oversold: false }, {
                    rules, ruleVersion: RULES_VERSION, relativeMultiplier: null, firstTimeLongTermChange: false,
                    priceMissing: false, ledgerEntryIds: [], observedAt: nowIso(),
                });
                if (react) {
                    const r2 = this.repos.insertBehaviorEvent({
                        dedupeKey: `ep${c.change.episodeId}|reactivated|b${Math.floor(Date.parse(c.change.eventAt) / (rules.alertCooldownMinutes * 60_000))}`,
                        wallet: w, conditionId: c.change.conditionId, tokenId: c.change.tokenId, eventType: 'reactivated',
                        magnitude: react.magnitude, evidence: react.evidence, dataQuality: 'verified',
                        priority: 'low', priorityReason: `距上一次活动超过 ${rules.reactivationHours} 小时`, ruleVersion: RULES_VERSION,
                        eventAt: c.change.eventAt, observedAt: react.observedAt,
                    });
                    if (r2.inserted) { eventsCreated++; eventIds.push(r2.id); }
                }
            }
            // 收集本轮要推送的事件（同一钱包合并成一条卡片，避免单个钱包刷屏）
            const row = this.repos.db.get<BehaviorRow>('SELECT * FROM behavior_events WHERE dedupe_key=?', out.dedupeKey);
            if (row) {
                if (out.priority === 'low') alertsSuppressed++;
                else pushRows.push(row);
            }
        }

        // ---- 4b. 推送：市场元数据 + 单钱包聚合卡片 ----
        if (pushRows.length) {
            // 报告必须有市场维度：先补齐市场元数据（每市场一次；有预算才发请求；失败不阻断推送）
            const cids = [...new Set(pushRows.map((r) => r.condition_id).filter((x): x is string => !!x))].slice(0, 3);
            for (const cid of cids) {
                try { await this.deps.collector.ensureMarketMeta(cid); } catch { /* 报告里会写明市场信息缺失 */ }
            }
            if (this.cycleEnqueued >= this.deps.config.push.maxPerCycleAlerts) {
                alertsSuppressed += pushRows.length;
            } else {
                const rep = this.reports.walletCycleReport(pushRows, { shadow: this.deps.config.shadowMode });
                const topPriority = pushRows.some((r) => r.priority === 'high') ? 'high'
                    : (pushRows.some((r) => r.priority === 'medium') ? 'medium' : 'low');
                const first = pushRows[0], last = pushRows[pushRows.length - 1];
                const enq = this.deps.outbox.enqueueReport(`cycle|${w}|${first.id}-${last.id}`, {
                    chatId: this.deps.config.telegram.chatIds[0] ?? '',
                    title: rep.title, body: rep.body, eventId: first.id, wallet: w,
                    conditionId: first.condition_id ?? undefined, priority: topPriority,
                    dataQuality: first.data_quality, digestLines: rep.digestLines,
                });
                if (enq.inserted) { queued++; this.cycleEnqueued++; }
            }
        }

        // ---- 5. 缺口与画像落盘 ----
        for (const i of issues) this.repos.addGap(i.scope, i.key, i.reason, i.detail);
        this.profiler.persist(w, profile, nowIso());
        return {
            wallet: w,
            collected: { activityInserted, pages, stopped, warnings, error },
            ledger: { applied, skippedHistory, issues },
            eventsCreated, eventIds, alertsEnqueued: queued, alertsSuppressed, gaps: this.repos.openGaps(200).filter((g) => String(g.key) === w).length,
        };
    }

    /** 一轮完整流程：发现 → 处理到期对象 → 降级策略 → 投递 */
    async runCycle(opts: { markets?: string[]; maxMarkets?: number; flush?: boolean; discovery?: boolean } = {}): Promise<CycleReport> {
        const started = nowIso();
        const warnings: string[] = [];
        const cfg = this.deps.config;
        this.deps.outbox.recover();
        this.cycleEnqueued = 0;
        this.cycleMarketEnqueued = 0;
        // ---- 首要信号：市场扫描与异动判定（先于钱包处理）----
        const market = await this.runMarketScan();
        const discovered: CycleReport['discovered'] = [];
        const markets: string[] = [...(opts.markets ?? [])];
        for (const m of this.repos.listWatchedMarkets()) {
            const cid = String(m.condition_id);
            if (!markets.includes(cid)) markets.push(cid);
        }

        if (opts.discovery !== false && !markets.length) {
            const top = await this.deps.collector.topMarkets(opts.maxMarkets ?? 3);
            if (!top.ok) warnings.push(`发现热门市场失败：${top.error}`);
            else markets.push(...top.markets);
        }

        for (const m of markets.slice(0, opts.maxMarkets ?? 5)) {
            const obs = await this.collector.observeMarket(m);
            if (!obs.ok) { warnings.push(`市场 ${m} 观察失败：${obs.error}`); continue; }
            const d = await this.collector.discoverFromMarket(m);
            discovered.push({ market: m, added: d.added, skippedOverBudget: d.skippedOverBudget, byEntry: d.byEntry });
            if (d.skippedOverBudget > 0) warnings.push(`市场 ${m} 有 ${d.skippedOverBudget} 个候选因预算未纳入（已记缺口）`);
        }

        const due = this.repos.dueWatch(nowIso(), cfg.budgets.walletsPerCycle);
        let processed = 0, events = 0, queued = 0, suppressed = 0;
        for (const row of due) {
            const address = String(row.address), market = String(row.market_condition_id ?? '');
            const res = await this.processWallet(address, market);
            processed++;
            events += res.eventsCreated;
            queued += res.alertsEnqueued;
            suppressed += res.alertsSuppressed;
            warnings.push(...res.collected.warnings.map((x) => `${address.slice(0, 8)}…: ${x}`));
            const tier = Number(row.priority_tier);
            this.repos.setWatchState(address, market, {
                state: tier === 3 ? 'lowfreq' : 'watching',
                lastCollectAt: nowIso(),
                nextCollectAt: this.collector.nextCollectAt(tier),
            });
        }
        this.collector.applyTierPolicy();
        const flush = opts.flush === false ? null : await this.deps.outbox.flush();
        this.cycles++;
        this.lastCycleAt = nowIso();
        return { startedAt: started, finishedAt: nowIso(), marketScan: market.scan, marketAnomalies: market.anomalies, markets, discovered, processed, events, queued, suppressed, flush, warnings };
    }

    /**
     * 市场扫描 + 异动判定 + 入队（首要信号）。
     * 价格异动优先入队；被判为异动的 token 再用 CLOB 补精确盘口（少量请求）。
     */
    private async runMarketScan(): Promise<{ scan: { observed: number; markets: number; stoppedBecause: string } | null; anomalies: { created: number; enqueued: number; byKind: Record<string, number> } }> {
        const cfg = this.deps.config;
        const result = { created: 0, enqueued: 0, byKind: {} as Record<string, number> };
        if (!this.deps.scanner) return { scan: null, anomalies: result };
        const scan = await this.deps.scanner.scan({ pages: cfg.rules.marketScanPages });
        const rules: AnomalyRules = anomalyRulesFromConfig(cfg);
        const snapshots: MarketSnapshot[] = (scan as { snapshots?: MarketSnapshot[] }).snapshots ?? [];
        let enriched = 0;
        for (const cur of snapshots) {
            if (!cur.tokenId || cur.price === null) continue;
            const prev = this.deps.scanner.previousSnapshot(cur.tokenId, cur.observedAt);
            const { candidates } = detectAnomaly(prev, cur, rules);
            for (const cand of candidates) {
                if (cand.priority === 'low') { result.byKind[cand.kind] = (result.byKind[cand.kind] ?? 0); continue; }
                // 高优先级价格异动：补精确盘口（每次最多 3 个 token，避免请求放大）
                let snap = cur;
                if (cand.priority === 'high' && enriched < 3) {
                    enriched++;
                    const book = await this.deps.scanner.enrichBook(cur.tokenId);
                    if (book.ok) snap = { ...cur, bestBid: book.bestBid ? parseDec(book.bestBid) : cur.bestBid, bestAsk: book.bestAsk ? parseDec(book.bestAsk) : cur.bestAsk, spread: book.spread ? parseDec(book.spread) : cur.spread };
                }
                const rec = this.deps.scanner.recordAnomaly(cand, snap);
                result.byKind[cand.kind] = (result.byKind[cand.kind] ?? 0) + 1;
                if (rec.inserted) result.created++;
                // 入队（市场异动优先，且有自己的每轮上限，不与钱包事件互相挤占）
                const row = this.repos.db.get<MarketAnomalyRow & Record<string, unknown>>('SELECT * FROM market_anomalies WHERE id=?', rec.id);
                if (row && this.cycleMarketEnqueued < cfg.push.maxMarketPerCycle) {
                    const movers = this.deps.scanner.recentMovers(cand.conditionId, 3);
                    const rep = this.reports.marketAnomalyReport(row as unknown as MarketAnomalyRow, { movers, shadow: cfg.shadowMode });
                    const enq = this.deps.outbox.enqueue(`alert:${cand.dedupeKey}`, {
                        chatId: cfg.telegram.chatIds[0] ?? '', title: rep.title, body: rep.body,
                        wallet: '', conditionId: cand.conditionId, priority: cand.priority, dataQuality: cand.dataQuality,
                    });
                    if (enq.inserted) { result.enqueued++; this.cycleMarketEnqueued++; }
                }
            }
        }
        return { scan: { observed: scan.observed, markets: scan.markets, stoppedBecause: scan.stoppedBecause }, anomalies: result };
    }

    stats(): { cycles: number; lastCycleAt: string | null } { return { cycles: this.cycles, lastCycleAt: this.lastCycleAt }; }
}
