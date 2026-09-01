-- NFL Intelligence Machine v1: player/play/roster/injury/advanced SSOT
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nfl_players (
  player_id INTEGER PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  player_name TEXT,
  position TEXT,
  position_abbreviation TEXT,
  height TEXT,
  weight TEXT,
  jersey_number TEXT,
  college TEXT,
  experience TEXT,
  age INTEGER,
  current_team_id INTEGER,
  current_team_abbr TEXT,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  raw_r2_key TEXT,
  schema_version TEXT NOT NULL,
  build TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nfl_players_team ON nfl_players(current_team_id, position_abbreviation);

CREATE TABLE IF NOT EXISTS nfl_rosters (
  season INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  team_abbr TEXT,
  player_id INTEGER NOT NULL,
  roster_position TEXT NOT NULL,
  depth INTEGER,
  player_name TEXT,
  injury_status TEXT,
  observed_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  build TEXT NOT NULL,
  PRIMARY KEY (season, team_id, player_id, roster_position)
);
CREATE INDEX IF NOT EXISTS idx_nfl_rosters_player ON nfl_rosters(season, player_id);
CREATE INDEX IF NOT EXISTS idx_nfl_rosters_team_depth ON nfl_rosters(season, team_id, roster_position, depth);

CREATE TABLE IF NOT EXISTS nfl_player_game_stats (
  game_id TEXT NOT NULL,
  bdl_game_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER,
  season_type INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  team_id INTEGER,
  team_abbr TEXT,
  player_name TEXT,
  position_abbreviation TEXT,
  passing_attempts INTEGER,
  passing_completions INTEGER,
  passing_yards REAL,
  passing_touchdowns INTEGER,
  interceptions INTEGER,
  rushing_attempts INTEGER,
  rushing_yards REAL,
  rushing_touchdowns INTEGER,
  targets INTEGER,
  receptions INTEGER,
  receiving_yards REAL,
  receiving_touchdowns INTEGER,
  fumbles_lost INTEGER,
  total_points REAL,
  stats_json TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  build TEXT NOT NULL,
  PRIMARY KEY (game_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_nfl_player_game_stats_player ON nfl_player_game_stats(season, player_id, week);
CREATE INDEX IF NOT EXISTS idx_nfl_player_game_stats_team ON nfl_player_game_stats(season, team_id, week);
CREATE INDEX IF NOT EXISTS idx_nfl_player_game_stats_game ON nfl_player_game_stats(bdl_game_id);

CREATE TABLE IF NOT EXISTS nfl_plays (
  play_id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  bdl_game_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER,
  season_type INTEGER NOT NULL,
  period INTEGER,
  clock TEXT,
  play_type TEXT,
  text TEXT,
  short_text TEXT,
  scoring_play INTEGER,
  team_id INTEGER,
  team_abbr TEXT,
  start_down INTEGER,
  start_distance INTEGER,
  start_yards_to_endzone INTEGER,
  end_down INTEGER,
  end_distance INTEGER,
  end_yards_to_endzone INTEGER,
  stat_yardage REAL,
  home_win_probability REAL,
  wallclock TEXT,
  play_json TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  build TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nfl_plays_game ON nfl_plays(bdl_game_id, wallclock);
CREATE INDEX IF NOT EXISTS idx_nfl_plays_team ON nfl_plays(season, team_id, week);

CREATE TABLE IF NOT EXISTS nfl_injury_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL,
  team_id INTEGER,
  team_abbr TEXT,
  player_name TEXT,
  position_abbreviation TEXT,
  status TEXT,
  comment TEXT,
  source_date TEXT,
  payload_json TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  build TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nfl_injuries_team ON nfl_injury_snapshots(team_id, source_date);
CREATE INDEX IF NOT EXISTS idx_nfl_injuries_player ON nfl_injury_snapshots(player_id, source_date);

CREATE TABLE IF NOT EXISTS nfl_player_advanced_stats (
  family TEXT NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  season_type INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  player_name TEXT,
  position_abbreviation TEXT,
  payload_json TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  build TEXT NOT NULL,
  PRIMARY KEY (family, season, week, season_type, player_id)
);
CREATE INDEX IF NOT EXISTS idx_nfl_adv_player ON nfl_player_advanced_stats(player_id, season, week);
CREATE INDEX IF NOT EXISTS idx_nfl_adv_family ON nfl_player_advanced_stats(family, season, week);

CREATE TABLE IF NOT EXISTS nfl_bdl_capabilities (
  endpoint_key TEXT PRIMARY KEY,
  required_tier TEXT NOT NULL,
  accessible INTEGER,
  http_status INTEGER,
  checked_at TEXT NOT NULL,
  details_json TEXT,
  build TEXT NOT NULL
);
