-- Poly-sniper P1 持久化结构（方案 §8）。
-- 约定：
--   * 所有时间列是 UTC ISO 8601 字符串（'2026-10-09T08:30:00.000Z'），展示层再转东八区。
--   * 所有数量/金额列是精确十进制字符串（见 src/util/decimal.ts），NULL 表示未知，'0' 表示确认的零。
--   * 派生表保留来源证据与算法版本；重算不覆盖原始事实与当时已发送的报告版本。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- 市场与结果 token（方案 §8 markets/outcome_tokens）
CREATE TABLE IF NOT EXISTS markets (
  condition_id    TEXT PRIMARY KEY,
  event_slug      TEXT,
  slug            TEXT,
  question        TEXT,
  neg_risk        INTEGER,            -- 1/0，NULL = 未知
  closed          INTEGER,
  end_date        TEXT,
  first_seen_at   TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outcome_tokens (
  token_id        TEXT PRIMARY KEY,   -- 十进制字符串
  condition_id    TEXT NOT NULL REFERENCES markets(condition_id),
  outcome         TEXT,               -- 'Yes' / 'No' / ...
  outcome_index   INTEGER,
  first_seen_at   TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outcome_tokens_condition ON outcome_tokens(condition_id);

-- 钱包与关注名单
CREATE TABLE IF NOT EXISTS wallets (
  address        TEXT PRIMARY KEY,    -- 统一小写
  first_seen_at  TEXT NOT NULL,       -- 本机首次看到（不能用于证明账户新）
  last_seen_at   TEXT NOT NULL,
  note           TEXT
);

CREATE TABLE IF NOT EXISTS watchlist (
  address              TEXT NOT NULL REFERENCES wallets(address),
  market_condition_id  TEXT NOT NULL DEFAULT '',   -- '' = 钱包级关注
  source               TEXT NOT NULL,              -- manual | significant_trade | major_holder | relation
  priority_tier        INTEGER NOT NULL DEFAULT 3, -- 1 手动 / 2 显著成交·大户 / 3 低频
  state                TEXT NOT NULL DEFAULT 'discovered', -- discovered|backfilling|watching|lowfreq|archived
  reason               TEXT,
  added_at             TEXT NOT NULL,
  withdrawn_at         TEXT,
  next_collect_at      TEXT,
  last_collect_at      TEXT,
  PRIMARY KEY (address, market_condition_id)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_due ON watchlist(next_collect_at) WHERE withdrawn_at IS NULL;

-- 原始记录（不可变事实层）：去重、核对、重算的依据
CREATE TABLE IF NOT EXISTS source_records (
  id                  INTEGER PRIMARY KEY,
  source              TEXT NOT NULL,          -- data-api/activity | data-api/trades | data-api/positions | gamma/markets | rpc/eth_call
  source_key          TEXT NOT NULL,          -- 稳定来源键，或合成键
  synthetic_key       INTEGER NOT NULL DEFAULT 0, -- 1 = 来源没有稳定 ID，用的是合成键
  wallet              TEXT,
  market_condition_id TEXT,
  payload             TEXT NOT NULL,          -- 原始 JSON（截断存储见 config）
  event_at            TEXT,
  observed_at         TEXT NOT NULL,
  contract_version    TEXT NOT NULL,
  UNIQUE(source, source_key)
);
CREATE INDEX IF NOT EXISTS idx_source_records_wallet ON source_records(wallet, event_at);

-- 规范化活动（成交/拆分/合并/赎回/奖励等）
CREATE TABLE IF NOT EXISTS wallet_activities (
  id                INTEGER PRIMARY KEY,
  source_record_id  INTEGER NOT NULL REFERENCES source_records(id),
  activity_key      TEXT NOT NULL UNIQUE,     -- 来源稳定 ID 或合成键
  synthetic_key     INTEGER NOT NULL DEFAULT 0,
  wallet            TEXT NOT NULL,
  type              TEXT NOT NULL,            -- TRADE|SPLIT|MERGE|REDEEM|CONVERSION|YIELD|MAKER_REBATE|TAKER_REBATE|UNKNOWN:<原值>
  source_type       TEXT NOT NULL DEFAULT 'verified', -- verified|unsupported
  condition_id      TEXT,
  token_id          TEXT,
  outcome_index     INTEGER,
  outcome           TEXT,
  side              TEXT,                     -- BUY|SELL（TRADE 才有）
  size              TEXT,                     -- 份数（精确十进制字符串，NULL = 未知）
  price             TEXT,
  usdc_size         TEXT,                     -- 现金变化（正=流入本钱包）
  event_at          TEXT NOT NULL,
  observed_at       TEXT NOT NULL,
  tx_hash           TEXT,
  market_slug       TEXT,
  event_slug        TEXT
);
CREATE INDEX IF NOT EXISTS idx_activities_wallet_time ON wallet_activities(wallet, event_at);
CREATE INDEX IF NOT EXISTS idx_activities_token_time ON wallet_activities(token_id, event_at);

-- 快照：持仓与现金
CREATE TABLE IF NOT EXISTS position_snapshots (
  id                INTEGER PRIMARY KEY,
  source_record_id  INTEGER,
  wallet            TEXT NOT NULL,
  token_id          TEXT NOT NULL,
  condition_id      TEXT,
  outcome           TEXT,
  size              TEXT,                     -- NULL = 未知；'0' = 确认零
  current_value     TEXT,
  price             TEXT,
  avg_price         TEXT,
  redeemable        INTEGER,
  completeness      TEXT NOT NULL,            -- complete | partial | failed
  snapshot_at       TEXT NOT NULL,
  UNIQUE(wallet, token_id, snapshot_at)
);
CREATE INDEX IF NOT EXISTS idx_pos_snap_wallet ON position_snapshots(wallet, snapshot_at);

CREATE TABLE IF NOT EXISTS balance_snapshots (
  id                INTEGER PRIMARY KEY,
  wallet            TEXT NOT NULL,
  asset             TEXT NOT NULL,            -- USDC.e（0x2791Bca…）等
  amount            TEXT,
  completeness      TEXT NOT NULL,            -- complete | partial | failed
  block_number      TEXT,
  snapshot_at       TEXT NOT NULL,
  UNIQUE(wallet, asset, snapshot_at)
);

-- 持仓过程与账本
CREATE TABLE IF NOT EXISTS position_episodes (
  id                INTEGER PRIMARY KEY,
  wallet            TEXT NOT NULL,
  condition_id      TEXT NOT NULL,
  token_id          TEXT NOT NULL,
  outcome           TEXT,
  opened_at         TEXT NOT NULL,
  opened_reason     TEXT NOT NULL,            -- snapshot | first_observed_change
  initial_size      TEXT NOT NULL,
  baseline_complete INTEGER NOT NULL,         -- 1 = 从零开始可核验；0 = 观察起点未知
  last_size         TEXT NOT NULL,
  status            TEXT NOT NULL,            -- open | closed | unknown
  closed_at         TEXT,
  closed_reason     TEXT,                     -- snapshot_zero | ...
  updated_at        TEXT NOT NULL,
  UNIQUE(wallet, token_id, opened_at)
);
CREATE INDEX IF NOT EXISTS idx_episodes_open ON position_episodes(wallet, token_id, status);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id                INTEGER PRIMARY KEY,
  episode_id        INTEGER NOT NULL REFERENCES position_episodes(id),
  wallet            TEXT NOT NULL,
  token_id          TEXT NOT NULL,
  kind              TEXT NOT NULL,   -- trade_buy|trade_sell|split|merge|redeem|conversion|reward|transfer_in|transfer_out|unexplained
  delta_size        TEXT NOT NULL,   -- 带符号份数变化（精确十进制）
  cash_delta        TEXT,            -- 现金变化（NULL = 未知，不当作 0）
  source_record_id  INTEGER REFERENCES source_records(id),
  source_type       TEXT NOT NULL,   -- verified | derived | unexplained
  event_at          TEXT NOT NULL,
  observed_at       TEXT NOT NULL,
  note              TEXT,
  dedupe_key        TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_ledger_episode ON ledger_entries(episode_id, event_at);

-- 关系证据（控制关系、资金联系）
CREATE TABLE IF NOT EXISTS wallet_relations (
  id             INTEGER PRIMARY KEY,
  from_address   TEXT NOT NULL,
  to_address     TEXT NOT NULL,
  relation_type  TEXT NOT NULL,      -- owner | multisig_signer | funding_source
  evidence       TEXT NOT NULL,      -- JSON：方法选择器、区块、来源、原始返回
  valid_from     TEXT,
  valid_to       TEXT,
  strength       TEXT NOT NULL,      -- verified | observed | weak
  checked_at     TEXT NOT NULL,
  UNIQUE(from_address, to_address, relation_type, checked_at)
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON wallet_relations(from_address, relation_type);

-- 画像版本（截止时间、覆盖范围、指标、基线口径、算法版本）
CREATE TABLE IF NOT EXISTS profile_versions (
  id                INTEGER PRIMARY KEY,
  wallet            TEXT NOT NULL,
  as_of             TEXT NOT NULL,
  coverage_from     TEXT,             -- 已覆盖区间起点（NULL = 未知）
  coverage_to       TEXT,
  coverage_complete INTEGER NOT NULL DEFAULT 0,
  metrics           TEXT NOT NULL,    -- JSON
  algorithm_version TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE(wallet, as_of, algorithm_version)
);

-- 行为事件与报警队列
CREATE TABLE IF NOT EXISTS behavior_events (
  id                INTEGER PRIMARY KEY,
  dedupe_key        TEXT NOT NULL UNIQUE,
  wallet            TEXT NOT NULL,
  condition_id      TEXT,
  token_id          TEXT,
  event_type        TEXT NOT NULL,   -- position_opened|position_increased|position_reduced|position_exited|reactivated|capital_in|capital_out|unexplained_change
  magnitude         TEXT,            -- JSON: {before, after, delta, pct, notional}
  evidence          TEXT NOT NULL,   -- JSON: 账本/快照/来源记录 id 与链接
  data_quality      TEXT NOT NULL,   -- verified | partial | incomplete（与优先级独立展示）
  priority          TEXT NOT NULL,   -- high | medium | low
  priority_reason   TEXT NOT NULL,
  rule_version      TEXT NOT NULL,
  event_at          TEXT NOT NULL,
  observed_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_wallet ON behavior_events(wallet, event_at);

CREATE TABLE IF NOT EXISTS alert_outbox (
  id                 INTEGER PRIMARY KEY,
  dedupe_key         TEXT NOT NULL UNIQUE,
  payload            TEXT NOT NULL,   -- JSON：报告内容（含行为事件与收件人）
  status             TEXT NOT NULL DEFAULT 'pending', -- pending|sending|sent|retry|dead|merged
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TEXT,
  last_error         TEXT,
  telegram_message_id TEXT,
  merged_into        INTEGER REFERENCES alert_outbox(id),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON alert_outbox(status, next_attempt_at);

-- 用户手动关注的「市场」（与钱包关注分开；不受自动候选排名淘汰）
CREATE TABLE IF NOT EXISTS watched_markets (
  condition_id TEXT PRIMARY KEY,
  slug         TEXT,
  note         TEXT,
  added_at     TEXT NOT NULL
);

-- 活动处理标记：区分「已入账」「观察起点之前的历史（只用于画像）」「跳过并给出原因」
CREATE TABLE IF NOT EXISTS activity_processing (
  activity_id INTEGER PRIMARY KEY REFERENCES wallet_activities(id),
  decision    TEXT NOT NULL,   -- ledger_applied | pre_observation_history | skipped
  reason      TEXT,
  decided_at  TEXT NOT NULL
);

-- 采集进度、缺口
CREATE TABLE IF NOT EXISTS collection_state (
  key                  TEXT PRIMARY KEY,   -- activity:<wallet> | positions:<wallet> | markets:<slug>
  cursor               TEXT,               -- JSON 游标（水位/页码）
  watermark_ts         TEXT,
  earliest_ts          TEXT,               -- 最早已取到的事件时间
  latest_ts            TEXT,
  reached_start        INTEGER NOT NULL DEFAULT 0,  -- 1 = 已到来源起点（可称「首次可验证活动」）
  truncated            INTEGER NOT NULL DEFAULT 0,
  truncation_reason    TEXT,
  last_run_at          TEXT,
  last_ok_at           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT
);

CREATE TABLE IF NOT EXISTS data_gaps (
  id           INTEGER PRIMARY KEY,
  scope        TEXT NOT NULL,     -- wallet | market | source | db
  key          TEXT NOT NULL,
  reason       TEXT NOT NULL,     -- budget_exhausted|truncated|query_failed|unsupported_activity|unexplained_change|contract_mismatch
  detail       TEXT,
  detected_at  TEXT NOT NULL,
  resolved_at  TEXT,
  UNIQUE(scope, key, reason)
);

-- 市场观察（价格/盘口/成交量背景）—— 这是「市场异动」判定的原始事实层
CREATE TABLE IF NOT EXISTS market_observations (
  id            INTEGER PRIMARY KEY,
  condition_id  TEXT NOT NULL,
  token_id      TEXT,
  outcome       TEXT,
  price         TEXT,            -- 该 token 的价格（gamma outcomePrices / 盘口中间价）
  best_bid      TEXT,
  best_ask      TEXT,
  spread        TEXT,
  last_trade_price TEXT,
  change_1h     TEXT,
  change_24h    TEXT,
  volume_24h    TEXT,
  liquidity     TEXT,
  observed_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_obs ON market_observations(condition_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_market_obs_token ON market_observations(token_id, observed_at);

-- 市场异动（首要信号）：价格异动 / 盘口走阔 / 成交量突增
CREATE TABLE IF NOT EXISTS market_anomalies (
  id             INTEGER PRIMARY KEY,
  dedupe_key     TEXT NOT NULL UNIQUE,
  condition_id   TEXT NOT NULL,
  token_id       TEXT,
  outcome        TEXT,
  kind           TEXT NOT NULL,   -- price_move | spread_widen | volume_surge
  window_minutes INTEGER,
  price_before   TEXT,
  price_after    TEXT,
  delta          TEXT,            -- 价格变化（百分点差）
  best_bid       TEXT,
  best_ask       TEXT,
  spread         TEXT,
  volume_24h     TEXT,
  liquidity      TEXT,
  change_1h      TEXT,
  change_24h     TEXT,
  priority       TEXT NOT NULL,
  reason         TEXT NOT NULL,
  data_quality   TEXT NOT NULL,
  rule_version   TEXT NOT NULL,
  event_at       TEXT NOT NULL,
  observed_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anomalies_time ON market_anomalies(event_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomalies_market ON market_anomalies(condition_id, event_at DESC);

-- 决策与跟进（用于评估报告是否有用）
CREATE TABLE IF NOT EXISTS decisions (
  id                INTEGER PRIMARY KEY,
  behavior_event_id INTEGER NOT NULL REFERENCES behavior_events(id),
  decision          TEXT NOT NULL,   -- follow | fade | skip
  reason            TEXT,
  decided_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS followups (
  id                INTEGER PRIMARY KEY,
  behavior_event_id INTEGER NOT NULL REFERENCES behavior_events(id),
  window_hours      INTEGER NOT NULL,
  price_at_event    TEXT,
  price_after       TEXT,
  size_after        TEXT,
  observed_at       TEXT NOT NULL,
  note              TEXT,
  UNIQUE(behavior_event_id, window_hours)
);
