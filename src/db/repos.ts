/**
 * 仓储层：所有 SQL 集中在这里，业务层只调用方法。
 * 幂等性由唯一键 + INSERT OR IGNORE 保证（方案 §6.2）。
 */
import { Db, Row } from './Database.js';
import { nowIso } from '../util/time.js';

export interface SourceRecordInput {
    source: string;
    sourceKey: string;
    syntheticKey?: boolean;
    wallet?: string | null;
    conditionId?: string | null;
    payload: string;
    eventAt?: string | null;
    observedAt?: string;
    contractVersion: string;
}

export interface ActivityInput {
    sourceRecordId: number;
    activityKey: string;
    syntheticKey: boolean;
    wallet: string;
    type: string;
    sourceType?: 'verified' | 'unsupported';
    conditionId?: string | null;
    tokenId?: string | null;
    outcomeIndex?: number | null;
    outcome?: string | null;
    side?: string | null;
    size?: string | null;
    price?: string | null;
    usdcSize?: string | null;
    eventAt: string;
    observedAt: string;
    txHash?: string | null;
    marketSlug?: string | null;
    eventSlug?: string | null;
}

export interface EpisodeInput {
    wallet: string;
    conditionId: string;
    tokenId: string;
    outcome?: string | null;
    openedAt: string;
    openedReason: 'snapshot' | 'first_observed_change';
    initialSize: string;
    baselineComplete: boolean;
}

export interface LedgerInput {
    episodeId: number;
    wallet: string;
    tokenId: string;
    kind: string;
    deltaSize: string;
    cashDelta?: string | null;
    sourceRecordId?: number | null;
    sourceType: 'verified' | 'derived' | 'unexplained';
    eventAt: string;
    observedAt: string;
    note?: string | null;
    dedupeKey: string;
}

export interface BehaviorEventInput {
    dedupeKey: string;
    wallet: string;
    conditionId?: string | null;
    tokenId?: string | null;
    eventType: string;
    magnitude?: string | null;
    evidence: string;
    dataQuality: 'verified' | 'partial' | 'incomplete';
    priority: 'high' | 'medium' | 'low';
    priorityReason: string;
    ruleVersion: string;
    eventAt: string;
    observedAt: string;
}

export class Repos {
    constructor(readonly db: Db) { }

    // ---------- 市场与 token ----------
    upsertMarket(m: { conditionId: string; slug?: string; eventSlug?: string; question?: string; negRisk?: boolean | null; closed?: boolean | null; endDate?: string }): void {
        const now = nowIso();
        this.db.run(
            `INSERT INTO markets(condition_id, slug, event_slug, question, neg_risk, closed, end_date, first_seen_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)
             ON CONFLICT(condition_id) DO UPDATE SET
               slug=COALESCE(excluded.slug, markets.slug),
               event_slug=COALESCE(excluded.event_slug, markets.event_slug),
               question=COALESCE(excluded.question, markets.question),
               neg_risk=COALESCE(excluded.neg_risk, markets.neg_risk),
               closed=COALESCE(excluded.closed, markets.closed),
               end_date=COALESCE(excluded.end_date, markets.end_date),
               updated_at=excluded.updated_at`,
            m.conditionId, m.slug ?? null, m.eventSlug ?? null, m.question ?? null,
            m.negRisk === null || m.negRisk === undefined ? null : (m.negRisk ? 1 : 0),
            m.closed === null || m.closed === undefined ? null : (m.closed ? 1 : 0),
            m.endDate ?? null, now, now,
        );
    }

    upsertOutcomeToken(t: { tokenId: string; conditionId: string; outcome?: string | null; outcomeIndex?: number | null }): void {
        const now = nowIso();
        this.db.run(
            `INSERT INTO outcome_tokens(token_id, condition_id, outcome, outcome_index, first_seen_at, updated_at)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT(token_id) DO UPDATE SET outcome=COALESCE(excluded.outcome, outcome_tokens.outcome),
               outcome_index=COALESCE(excluded.outcome_index, outcome_tokens.outcome_index), updated_at=excluded.updated_at`,
            t.tokenId, t.conditionId, t.outcome ?? null, t.outcomeIndex ?? null, now, now,
        );
    }

    market(conditionId: string): { question: string | null; slug: string | null; event_slug: string | null; neg_risk: number | null } | undefined {
        return this.db.get('SELECT question, slug, event_slug, neg_risk FROM markets WHERE condition_id=?', conditionId);
    }

    token(tokenId: string): { condition_id: string; outcome: string | null; outcome_index: number | null } | undefined {
        return this.db.get('SELECT condition_id, outcome, outcome_index FROM outcome_tokens WHERE token_id=?', tokenId);
    }

    // ---------- 钱包与关注名单 ----------
    ensureWallet(address: string, now = nowIso()): void {
        this.db.run(
            `INSERT INTO wallets(address, first_seen_at, last_seen_at) VALUES (?,?,?)
             ON CONFLICT(address) DO UPDATE SET last_seen_at=excluded.last_seen_at`,
            address.toLowerCase(), now, now,
        );
    }

    /** 加入关注名单（幂等）；不会因为再次命中而覆盖用户手动关注 */
    watch(address: string, opts: { marketConditionId?: string; source: string; tier: number; reason: string; nextCollectAt?: string | null; now?: string }): void {
        const now = opts.now ?? nowIso();
        const market = opts.marketConditionId ?? '';
        this.ensureWallet(address, now);
        this.db.run(
            `INSERT INTO watchlist(address, market_condition_id, source, priority_tier, state, reason, added_at, next_collect_at)
             VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT(address, market_condition_id) DO UPDATE SET
               priority_tier=MIN(watchlist.priority_tier, excluded.priority_tier),
               source=CASE WHEN watchlist.source='manual' THEN watchlist.source
                           WHEN excluded.source='manual' THEN excluded.source
                           ELSE watchlist.source END,
               reason=CASE WHEN watchlist.source='manual' THEN watchlist.reason
                           WHEN excluded.source='manual' THEN excluded.reason
                           ELSE watchlist.reason END,
               withdrawn_at=NULL,
               next_collect_at=COALESCE(watchlist.next_collect_at, excluded.next_collect_at)`,
            address.toLowerCase(), market, opts.source, opts.tier, opts.tier === 1 ? 'watching' : 'discovered', opts.reason, now, opts.nextCollectAt ?? now,
        );
    }

    /** 用户取消关注：只归档，不删除历史 */
    unwatch(address: string, marketConditionId = '', now = nowIso()): number {
        return this.db.run(
            `UPDATE watchlist SET withdrawn_at=?, state='archived' WHERE address=? AND market_condition_id=? AND withdrawn_at IS NULL`,
            now, address.toLowerCase(), marketConditionId,
        ).changes;
    }

    watchlist(onlyActive = true): Row[] {
        return this.db.all(
            `SELECT * FROM watchlist ${onlyActive ? 'WHERE withdrawn_at IS NULL' : ''} ORDER BY priority_tier, added_at`,
        );
    }

    /** 到期的关注对象：手动关注优先，再按 tier 与到期时间 */
    dueWatch(now: string, limit: number): Row[] {
        return this.db.all(
            `SELECT w.*, (SELECT COUNT(*) FROM wallet_activities a WHERE a.wallet=w.address) AS activity_count
             FROM watchlist w
             WHERE w.withdrawn_at IS NULL AND (w.next_collect_at IS NULL OR w.next_collect_at <= ?)
             ORDER BY w.priority_tier ASC, (w.next_collect_at IS NULL) DESC, w.next_collect_at ASC
             LIMIT ?`,
            now, limit,
        );
    }

    setWatchState(address: string, marketConditionId: string, patch: { state?: string; tier?: number; lastCollectAt?: string | null; nextCollectAt?: string | null }): void {
        const cur = this.db.get<Row>('SELECT * FROM watchlist WHERE address=? AND market_condition_id=?', address.toLowerCase(), marketConditionId);
        if (!cur) return;
        this.db.run(
            `UPDATE watchlist SET state=?, priority_tier=?, last_collect_at=?, next_collect_at=? WHERE address=? AND market_condition_id=?`,
            patch.state ?? String(cur.state), patch.tier ?? Number(cur.priority_tier),
            patch.lastCollectAt ?? (cur.last_collect_at as string | null), patch.nextCollectAt ?? (cur.next_collect_at as string | null),
            address.toLowerCase(), marketConditionId,
        );
    }

    // ---------- 原始记录 ----------
    /** 原始记录幂等插入；返回 id（已存在则返回既有 id） */
    insertSourceRecord(r: SourceRecordInput): number {
        const now = r.observedAt ?? nowIso();
        this.db.run(
            `INSERT OR IGNORE INTO source_records(source, source_key, synthetic_key, wallet, market_condition_id, payload, event_at, observed_at, contract_version)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            r.source, r.sourceKey, r.syntheticKey ? 1 : 0, r.wallet ?? null, r.conditionId ?? null,
            r.payload, r.eventAt ?? null, now, r.contractVersion,
        );
        const row = this.db.get<{ id: number }>('SELECT id FROM source_records WHERE source=? AND source_key=?', r.source, r.sourceKey);
        if (!row) throw new Error(`source_records 插入失败: ${r.source}/${r.sourceKey}`);
        return row.id;
    }

    // ---------- 活动 ----------
    /** 幂等插入活动；返回 {inserted, id} */
    insertActivity(a: ActivityInput): { inserted: boolean; id: number } {
        const res = this.db.run(
            `INSERT OR IGNORE INTO wallet_activities(source_record_id, activity_key, synthetic_key, wallet, type, source_type, condition_id, token_id,
               outcome_index, outcome, side, size, price, usdc_size, event_at, observed_at, tx_hash, market_slug, event_slug)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            a.sourceRecordId, a.activityKey, a.syntheticKey ? 1 : 0, a.wallet, a.type, a.sourceType ?? 'verified',
            a.conditionId ?? null, a.tokenId ?? null, a.outcomeIndex ?? null, a.outcome ?? null, a.side ?? null,
            a.size ?? null, a.price ?? null, a.usdcSize ?? null, a.eventAt, a.observedAt,
            a.txHash ?? null, a.marketSlug ?? null, a.eventSlug ?? null,
        );
        if (res.changes === 0) {
            const row = this.db.get<{ id: number }>('SELECT id FROM wallet_activities WHERE activity_key=?', a.activityKey);
            // INSERT OR IGNORE 也会忽略 NOT NULL/外键等约束失败。找不到既有行说明不是「重复」，
            // 而是静默丢数据 —— 必须报错，不能当作已入库（方案 §11 P0：失败不能冒充正常结果）。
            if (!row) throw new Error(`wallet_activities 插入被忽略且无既有行（约束失败？）: ${a.activityKey}`);
            return { inserted: false, id: row.id };
        }
        return { inserted: true, id: res.lastInsertRowid };
    }

    activitiesFor(wallet: string, sinceIso?: string): Row[] {
        return sinceIso
            ? this.db.all('SELECT * FROM wallet_activities WHERE wallet=? AND event_at>=? ORDER BY event_at ASC', wallet.toLowerCase(), sinceIso)
            : this.db.all('SELECT * FROM wallet_activities WHERE wallet=? ORDER BY event_at ASC', wallet.toLowerCase());
    }

    /** 尚未进入账本的活动（幂等重放的基础：已入账的不会重复入账） */
    unappliedActivities(wallet: string, sinceIso?: string): Row[] {
        return this.db.all(
            `SELECT a.* FROM wallet_activities a
             WHERE a.wallet=? ${sinceIso ? 'AND a.event_at >= ?' : ''}
               AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.dedupe_key = 'act:' || a.id)
               AND NOT EXISTS (SELECT 1 FROM activity_processing p WHERE p.activity_id = a.id)
             ORDER BY a.event_at ASC, a.id ASC`,
            ...(sinceIso ? [wallet.toLowerCase(), sinceIso] : [wallet.toLowerCase()]),
        );
    }

    /** 标记活动已处理（入账 / 判为观察起点之前的历史 / 跳过并说明原因） */
    markActivityProcessed(activityId: number, decision: 'ledger_applied' | 'pre_observation_history' | 'skipped', reason: string | null = null, now = nowIso()): void {
        this.db.run('INSERT OR REPLACE INTO activity_processing(activity_id, decision, reason, decided_at) VALUES (?,?,?,?)', activityId, decision, reason, now);
    }

    activityProcessingStats(wallet: string): Record<string, number> {
        const rows = this.db.all<{ decision: string; n: number }>(
            `SELECT p.decision AS decision, COUNT(*) AS n FROM activity_processing p
             JOIN wallet_activities a ON a.id = p.activity_id WHERE a.wallet=? GROUP BY p.decision`, wallet.toLowerCase(),
        );
        return Object.fromEntries(rows.map((r) => [r.decision, r.n]));
    }

    activityCount(wallet: string): number {
        const r = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM wallet_activities WHERE wallet=?', wallet.toLowerCase());
        return r?.n ?? 0;
    }

    // ---------- 快照 ----------
    insertPositionSnapshot(s: { sourceRecordId?: number | null; wallet: string; tokenId: string; conditionId?: string | null; outcome?: string | null; size?: string | null; currentValue?: string | null; price?: string | null; avgPrice?: string | null; redeemable?: boolean | null; completeness: 'complete' | 'partial' | 'failed'; snapshotAt: string }): void {
        this.db.run(
            `INSERT OR REPLACE INTO position_snapshots(source_record_id, wallet, token_id, condition_id, outcome, size, current_value, price, avg_price, redeemable, completeness, snapshot_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            s.sourceRecordId ?? null, s.wallet.toLowerCase(), s.tokenId, s.conditionId ?? null, s.outcome ?? null,
            s.size ?? null, s.currentValue ?? null, s.price ?? null, s.avgPrice ?? null,
            s.redeemable === null || s.redeemable === undefined ? null : (s.redeemable ? 1 : 0), s.completeness, s.snapshotAt,
        );
    }

    /** 每个 token 的最新快照（方案 §6.3：定期获取新快照，与账本推导对比） */
    latestPositionSnapshots(wallet: string): Row[] {
        return this.db.all(
            `SELECT * FROM position_snapshots p WHERE p.wallet=? AND p.snapshot_at = (
                SELECT MAX(snapshot_at) FROM position_snapshots q WHERE q.wallet=p.wallet AND q.token_id=p.token_id)`,
            wallet.toLowerCase(),
        );
    }

    insertBalanceSnapshot(s: { wallet: string; asset: string; amount: string | null; completeness: 'complete' | 'partial' | 'failed'; blockNumber?: string | null; snapshotAt: string }): void {
        this.db.run(
            `INSERT OR REPLACE INTO balance_snapshots(wallet, asset, amount, completeness, block_number, snapshot_at) VALUES (?,?,?,?,?,?)`,
            s.wallet.toLowerCase(), s.asset, s.amount, s.completeness, s.blockNumber ?? null, s.snapshotAt,
        );
    }

    latestBalance(wallet: string, asset: string): Row | undefined {
        return this.db.get('SELECT * FROM balance_snapshots WHERE wallet=? AND asset=? ORDER BY snapshot_at DESC LIMIT 1', wallet.toLowerCase(), asset);
    }

    // ---------- 持仓过程与账本 ----------
    openEpisode(e: EpisodeInput): number {
        const now = nowIso();
        this.db.run(
            `INSERT OR IGNORE INTO position_episodes(wallet, condition_id, token_id, outcome, opened_at, opened_reason, initial_size, baseline_complete, last_size, status, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?, 'open', ?)`,
            e.wallet.toLowerCase(), e.conditionId, e.tokenId, e.outcome ?? null, e.openedAt, e.openedReason,
            e.initialSize, e.baselineComplete ? 1 : 0, e.initialSize, now,
        );
        const row = this.db.get<{ id: number }>('SELECT id FROM position_episodes WHERE wallet=? AND token_id=? AND opened_at=?', e.wallet.toLowerCase(), e.tokenId, e.openedAt);
        if (!row) throw new Error('position_episodes 插入失败');
        return row.id;
    }

    openEpisodeFor(wallet: string, tokenId: string): Row | undefined {
        return this.db.get(`SELECT * FROM position_episodes WHERE wallet=? AND token_id=? AND status='open' ORDER BY opened_at DESC LIMIT 1`, wallet.toLowerCase(), tokenId);
    }

    episodeById(id: number): Row | undefined { return this.db.get('SELECT * FROM position_episodes WHERE id=?', id); }

    updateEpisode(id: number, patch: { lastSize?: string; status?: string; closedAt?: string | null; closedReason?: string | null }): void {
        const cur = this.episodeById(id);
        if (!cur) return;
        this.db.run(
            'UPDATE position_episodes SET last_size=?, status=?, closed_at=?, closed_reason=?, updated_at=? WHERE id=?',
            patch.lastSize ?? String(cur.last_size), patch.status ?? String(cur.status),
            patch.closedAt ?? (cur.closed_at as string | null), patch.closedReason ?? (cur.closed_reason as string | null),
            nowIso(), id,
        );
    }

    /** 账本条目幂等追加 */
    appendLedgerEntry(l: LedgerInput): boolean {
        const res = this.db.run(
            `INSERT OR IGNORE INTO ledger_entries(episode_id, wallet, token_id, kind, delta_size, cash_delta, source_record_id, source_type, event_at, observed_at, note, dedupe_key)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            l.episodeId, l.wallet.toLowerCase(), l.tokenId, l.kind, l.deltaSize, l.cashDelta ?? null,
            l.sourceRecordId ?? null, l.sourceType, l.eventAt, l.observedAt, l.note ?? null, l.dedupeKey,
        );
        return res.changes > 0;
    }

    ledgerForEpisode(episodeId: number): Row[] {
        return this.db.all('SELECT * FROM ledger_entries WHERE episode_id=? ORDER BY event_at ASC, id ASC', episodeId);
    }

    ledgerForWallet(wallet: string): Row[] {
        return this.db.all('SELECT * FROM ledger_entries WHERE wallet=? ORDER BY event_at ASC, id ASC', wallet.toLowerCase());
    }

    // ---------- 关系证据 ----------
    insertRelation(r: { from: string; to: string; relationType: string; evidence: string; validFrom?: string | null; validTo?: string | null; strength: 'verified' | 'observed' | 'weak'; checkedAt: string }): void {
        this.db.run(
            `INSERT OR IGNORE INTO wallet_relations(from_address, to_address, relation_type, evidence, valid_from, valid_to, strength, checked_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            r.from.toLowerCase(), r.to.toLowerCase(), r.relationType, r.evidence, r.validFrom ?? null, r.validTo ?? null, r.strength, r.checkedAt,
        );
    }

    relationsFrom(address: string): Row[] {
        return this.db.all('SELECT * FROM wallet_relations WHERE from_address=? ORDER BY checked_at DESC', address.toLowerCase());
    }

    /** 同一 owner 名下的其它地址（只认单签名者控制关系；多签共享签名者不合并身份，方案 §3.1、§12） */
    siblingsByOwner(address: string): string[] {
        const rows = this.db.all<{ to_address: string }>(
            `SELECT DISTINCT r2.to_address AS to_address FROM wallet_relations r2
             WHERE r2.relation_type='owner'
               AND r2.from_address IN (SELECT r1.from_address FROM wallet_relations r1 WHERE r1.to_address=? AND r1.relation_type='owner')
               AND r2.to_address != ?`,
            address.toLowerCase(), address.toLowerCase(),
        );
        return rows.map((r) => r.to_address);
    }

    // ---------- 画像 ----------
    insertProfileVersion(p: { wallet: string; asOf: string; coverageFrom?: string | null; coverageTo?: string | null; coverageComplete: boolean; metrics: string; algorithmVersion: string }): void {
        this.db.run(
            `INSERT OR REPLACE INTO profile_versions(wallet, as_of, coverage_from, coverage_to, coverage_complete, metrics, algorithm_version, created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            p.wallet.toLowerCase(), p.asOf, p.coverageFrom ?? null, p.coverageTo ?? null, p.coverageComplete ? 1 : 0, p.metrics, p.algorithmVersion, nowIso(),
        );
    }

    // ---------- 行为事件 ----------
    insertBehaviorEvent(e: BehaviorEventInput): { inserted: boolean; id: number } {
        const res = this.db.run(
            `INSERT OR IGNORE INTO behavior_events(dedupe_key, wallet, condition_id, token_id, event_type, magnitude, evidence, data_quality, priority, priority_reason, rule_version, event_at, observed_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            e.dedupeKey, e.wallet.toLowerCase(), e.conditionId ?? null, e.tokenId ?? null, e.eventType,
            e.magnitude ?? null, e.evidence, e.dataQuality, e.priority, e.priorityReason, e.ruleVersion, e.eventAt, e.observedAt,
        );
        if (res.changes === 0) {
            const row = this.db.get<{ id: number }>('SELECT id FROM behavior_events WHERE dedupe_key=?', e.dedupeKey);
            return { inserted: false, id: row?.id ?? 0 };
        }
        return { inserted: true, id: res.lastInsertRowid };
    }

    recentEvents(limit = 20): Row[] {
        return this.db.all('SELECT * FROM behavior_events ORDER BY event_at DESC LIMIT ?', limit);
    }

    eventsForWallet(wallet: string, limit = 20): Row[] {
        return this.db.all('SELECT * FROM behavior_events WHERE wallet=? ORDER BY event_at DESC LIMIT ?', wallet.toLowerCase(), limit);
    }

    eventsForCondition(conditionId: string, limit = 50): Row[] {
        return this.db.all('SELECT * FROM behavior_events WHERE condition_id=? ORDER BY event_at DESC LIMIT ?', conditionId, limit);
    }

    markEventObserved(id: number, observedAt: string): void {
        this.db.run('UPDATE behavior_events SET observed_at=? WHERE id=? AND observed_at < ?', observedAt, id, observedAt);
    }

    // ---------- 报警队列 ----------
    enqueueAlert(dedupeKey: string, payload: string, now = nowIso()): { inserted: boolean; id: number } {
        const res = this.db.run(
            `INSERT OR IGNORE INTO alert_outbox(dedupe_key, payload, status, attempts, next_attempt_at, created_at, updated_at)
             VALUES (?,?,'pending',0,?,?,?)`,
            dedupeKey, payload, now, now, now,
        );
        const row = this.db.get<{ id: number }>('SELECT id FROM alert_outbox WHERE dedupe_key=?', dedupeKey);
        return { inserted: res.changes > 0, id: row?.id ?? 0 };
    }

    dueAlerts(now: string, limit: number): Row[] {
        return this.db.all(
            `SELECT * FROM alert_outbox WHERE status IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             ORDER BY created_at ASC LIMIT ?`,
            now, limit,
        );
    }

    /** 取出即置 sending，避免重复发送（发送成功但回写前崩溃的重试风险在报告里显式说明） */
    claimAlert(id: number, now = nowIso()): boolean {
        return this.db.run(`UPDATE alert_outbox SET status='sending', attempts=attempts+1, updated_at=? WHERE id=? AND status IN ('pending','retry')`, now, id).changes > 0;
    }

    markAlertSent(id: number, messageId: string | null, now = nowIso()): void {
        this.db.run(`UPDATE alert_outbox SET status='sent', telegram_message_id=?, last_error=NULL, updated_at=? WHERE id=?`, messageId, now, id);
    }

    /** 失败后退避重试；超过最大次数转 dead（不静默丢弃） */
    markAlertFailure(id: number, error: string, nextAttemptAt: string | null, now = nowIso()): string {
        const row = this.db.get<{ attempts: number }>('SELECT attempts FROM alert_outbox WHERE id=?', id);
        const attempts = row?.attempts ?? 0;
        const status = nextAttemptAt ? 'retry' : 'dead';
        this.db.run('UPDATE alert_outbox SET status=?, last_error=?, next_attempt_at=?, updated_at=? WHERE id=?', status, error, nextAttemptAt, now, id);
        return status;
    }

    /** 限速溢出：合并进摘要条目，而不是丢弃（方案 §7.3） */
    mergeAlert(id: number, mergedInto: number, now = nowIso()): void {
        this.db.run(`UPDATE alert_outbox SET status='merged', merged_into=?, updated_at=? WHERE id=?`, mergedInto, now, id);
    }

    updateAlertPayload(id: number, payload: string, now = nowIso()): void {
        this.db.run('UPDATE alert_outbox SET payload=?, updated_at=? WHERE id=?', payload, now, id);
    }

    alertById(id: number): Row | undefined { return this.db.get('SELECT * FROM alert_outbox WHERE id=?', id); }

    /**
     * 崩溃恢复：卡在 sending 超时的条目回到 retry。
     * 发送成功但回写前崩溃的条目会被重发（至少一次投递），这一点在报告里显式说明，不承诺跨网络恰好一次。
     */
    resetStuckSending(olderThanIso: string, now = nowIso()): number {
        return this.db.run(
            `UPDATE alert_outbox SET status='retry', last_error=COALESCE(last_error,'') || ' [崩溃恢复：可能重复投递]', next_attempt_at=?, updated_at=?
             WHERE status='sending' AND updated_at < ?`,
            now, now, olderThanIso,
        ).changes;
    }

    /** 最近一分钟发送计数（限速依据） */
    sentSince(iso: string): number {
        const r = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM alert_outbox WHERE status='sent' AND updated_at >= ?`, iso);
        return r?.n ?? 0;
    }

    outboxStats(): Record<string, number> {
        const rows = this.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM alert_outbox GROUP BY status');
        return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    }

    // ---------- 采集进度与缺口 ----------
    getState(key: string): Row | undefined { return this.db.get('SELECT * FROM collection_state WHERE key=?', key); }

    upsertState(key: string, patch: { cursor?: string | null; watermarkTs?: string | null; earliestTs?: string | null; latestTs?: string | null; reachedStart?: boolean; truncated?: boolean; truncationReason?: string | null; lastRunAt?: string; lastOkAt?: string | null; failures?: number; lastError?: string | null }): void {
        const now = nowIso();
        this.db.run(
            `INSERT INTO collection_state(key, cursor, watermark_ts, earliest_ts, latest_ts, reached_start, truncated, truncation_reason, last_run_at, last_ok_at, consecutive_failures, last_error)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(key) DO UPDATE SET
               cursor=COALESCE(excluded.cursor, collection_state.cursor),
               watermark_ts=COALESCE(excluded.watermark_ts, collection_state.watermark_ts),
               earliest_ts=CASE WHEN excluded.earliest_ts IS NULL THEN collection_state.earliest_ts
                                WHEN collection_state.earliest_ts IS NULL THEN excluded.earliest_ts
                                ELSE MIN(collection_state.earliest_ts, excluded.earliest_ts) END,
               latest_ts=CASE WHEN excluded.latest_ts IS NULL THEN collection_state.latest_ts
                              WHEN collection_state.latest_ts IS NULL THEN excluded.latest_ts
                              ELSE MAX(collection_state.latest_ts, excluded.latest_ts) END,
               reached_start=MAX(collection_state.reached_start, excluded.reached_start),
               truncated=CASE WHEN excluded.last_ok_at IS NULL THEN collection_state.truncated ELSE excluded.truncated END,
               truncation_reason=COALESCE(excluded.truncation_reason, collection_state.truncation_reason),
               last_run_at=excluded.last_run_at,
               last_ok_at=COALESCE(excluded.last_ok_at, collection_state.last_ok_at),
               consecutive_failures=excluded.consecutive_failures,
               last_error=excluded.last_error`,
            key, patch.cursor ?? null, patch.watermarkTs ?? null, patch.earliestTs ?? null, patch.latestTs ?? null,
            patch.reachedStart ? 1 : 0, patch.truncated ? 1 : 0, patch.truncationReason ?? null,
            patch.lastRunAt ?? now, patch.lastOkAt ?? null, patch.failures ?? 0, patch.lastError ?? null,
        );
    }

    addGap(scope: string, key: string, reason: string, detail?: string, now = nowIso()): void {
        this.db.run(
            `INSERT INTO data_gaps(scope, key, reason, detail, detected_at) VALUES (?,?,?,?,?)
             ON CONFLICT(scope, key, reason) DO UPDATE SET detail=excluded.detail, detected_at=excluded.detected_at, resolved_at=NULL`,
            scope, key, reason, detail ?? null, now,
        );
    }

    resolveGap(scope: string, key: string, reason: string, now = nowIso()): void {
        this.db.run('UPDATE data_gaps SET resolved_at=? WHERE scope=? AND key=? AND reason=? AND resolved_at IS NULL', now, scope, key, reason);
    }

    openGaps(limit = 50): Row[] {
        return this.db.all('SELECT * FROM data_gaps WHERE resolved_at IS NULL ORDER BY detected_at DESC LIMIT ?', limit);
    }

    // ---------- 市场观察 ----------
    insertMarketObservation(o: { conditionId: string; tokenId?: string | null; price?: string | null; volume24h?: string | null; liquidity?: string | null; observedAt: string }): void {
        this.db.run(
            `INSERT INTO market_observations(condition_id, token_id, price, volume_24h, liquidity, observed_at) VALUES (?,?,?,?,?,?)`,
            o.conditionId, o.tokenId ?? null, o.price ?? null, o.volume24h ?? null, o.liquidity ?? null, o.observedAt,
        );
    }

    // ---------- 手动关注的市场 ----------
    addWatchedMarket(conditionId: string, slug: string | null, note: string | null, now = nowIso()): void {
        this.db.run(
            `INSERT INTO watched_markets(condition_id, slug, note, added_at) VALUES (?,?,?,?)
             ON CONFLICT(condition_id) DO UPDATE SET slug=COALESCE(excluded.slug, watched_markets.slug), note=COALESCE(excluded.note, watched_markets.note)`,
            conditionId, slug, note, now,
        );
    }

    removeWatchedMarket(conditionId: string): number {
        return this.db.run('DELETE FROM watched_markets WHERE condition_id=?', conditionId).changes;
    }

    listWatchedMarkets(): Row[] { return this.db.all('SELECT * FROM watched_markets ORDER BY added_at'); }

    // ---------- 决策与跟进 ----------
    insertDecision(behaviorEventId: number, decision: string, reason: string | null, now = nowIso()): void {
        this.db.run('INSERT INTO decisions(behavior_event_id, decision, reason, decided_at) VALUES (?,?,?,?)', behaviorEventId, decision, reason, now);
    }

    listDecisions(): Row[] { return this.db.all('SELECT * FROM decisions ORDER BY decided_at DESC'); }
}
