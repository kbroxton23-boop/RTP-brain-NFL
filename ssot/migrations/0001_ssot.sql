-- RTP NFL SSOT Reconstruction v1
-- Factual authority only. Model/calibration tables are intentionally excluded.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS source_versions (
  source_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  details_json TEXT
);

CREATE TABLE IF NOT EXISTS nfl_games (
  game_id TEXT PRIMARY KEY,
  bdl_game_id INTEGER NOT NULL UNIQUE,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  season_type INTEGER NOT NULL CHECK (season_type IN (1,2,3)),
  kickoff_at TEXT,
  status_state TEXT NOT NULL,
  status_text TEXT,
  postseason INTEGER NOT NULL DEFAULT 0,
  venue TEXT,
  summary TEXT,
  home_team_id INTEGER NOT NULL,
  home_team_abbr TEXT NOT NULL,
  home_team_name TEXT,
  away_team_id INTEGER NOT NULL,
  away_team_abbr TEXT NOT NULL,
  away_team_name TEXT,
  home_score INTEGER,
  away_score INTEGER,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  available_at TEXT,
  ingested_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  build TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_games_season_week
  ON nfl_games(season, season_type, week);
CREATE INDEX IF NOT EXISTS idx_games_kickoff
  ON nfl_games(kickoff_at);
CREATE INDEX IF NOT EXISTS idx_games_status
  ON nfl_games(season, season_type, status_state);

CREATE TABLE IF NOT EXISTS nfl_team_game_stats (
  game_id TEXT NOT NULL,
  bdl_game_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  season_type INTEGER NOT NULL CHECK (season_type IN (1,2,3)),
  team_id INTEGER NOT NULL,
  team_abbr TEXT NOT NULL,
  team_name TEXT,
  opponent_team_id INTEGER,
  opponent_abbr TEXT,
  home_away TEXT CHECK (home_away IN ('home','away')),

  first_downs INTEGER,
  third_down_conversions INTEGER,
  third_down_attempts INTEGER,
  fourth_down_conversions INTEGER,
  fourth_down_attempts INTEGER,
  total_offensive_plays INTEGER,
  total_yards INTEGER,
  yards_per_play REAL,
  total_drives INTEGER,
  net_passing_yards INTEGER,
  passing_completions INTEGER,
  passing_attempts INTEGER,
  yards_per_pass REAL,
  sacks INTEGER,
  sack_yards_lost INTEGER,
  rushing_yards INTEGER,
  rushing_attempts INTEGER,
  yards_per_rush_attempt REAL,
  red_zone_scores INTEGER,
  red_zone_attempts INTEGER,
  penalties INTEGER,
  penalty_yards INTEGER,
  turnovers INTEGER,
  fumbles_lost INTEGER,
  interceptions_thrown INTEGER,
  defensive_touchdowns INTEGER,
  possession_time_seconds INTEGER,

  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  available_at TEXT,
  ingested_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  build TEXT NOT NULL,

  PRIMARY KEY (game_id, team_id),
  FOREIGN KEY (game_id) REFERENCES nfl_games(game_id)
);

CREATE INDEX IF NOT EXISTS idx_teamstats_season_team_week
  ON nfl_team_game_stats(season, team_id, week);
CREATE INDEX IF NOT EXISTS idx_teamstats_game
  ON nfl_team_game_stats(game_id);

CREATE TABLE IF NOT EXISTS ingest_runs (
  run_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  season INTEGER NOT NULL,
  season_type INTEGER NOT NULL,
  status TEXT NOT NULL,
  cursor TEXT,
  processed_pages INTEGER NOT NULL DEFAULT 0,
  fetched_rows INTEGER NOT NULL DEFAULT 0,
  stored_rows INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  budget_json TEXT,
  checkpoint_json TEXT,
  build TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_phase_season
  ON ingest_runs(phase, season, season_type, started_at);

CREATE TABLE IF NOT EXISTS ingest_receipts (
  receipt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  season INTEGER NOT NULL,
  season_type INTEGER NOT NULL,
  page_cursor TEXT,
  next_cursor TEXT,
  source_row_count INTEGER NOT NULL,
  stored_row_count INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  build TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipts_run
  ON ingest_receipts(run_id, created_at);

CREATE TABLE IF NOT EXISTS phase_certifications (
  cert_key TEXT PRIMARY KEY,
  season INTEGER NOT NULL,
  season_type INTEGER NOT NULL,
  phase TEXT NOT NULL,
  complete INTEGER NOT NULL,
  certified INTEGER NOT NULL,
  expected_rows INTEGER NOT NULL,
  found_rows INTEGER NOT NULL,
  missing_rows INTEGER NOT NULL,
  invalid_rows INTEGER NOT NULL,
  details_json TEXT,
  assessed_at TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  build TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cert_season
  ON phase_certifications(season, season_type, phase);
