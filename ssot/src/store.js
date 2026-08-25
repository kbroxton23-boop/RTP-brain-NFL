import { BUILD, SCHEMA_VERSION, rawArchiveKey, sha256Hex } from "./core.js";

const GAME_SQL = `
INSERT INTO nfl_games (
  game_id, bdl_game_id, season, week, season_type, kickoff_at, status_state, status_text,
  postseason, venue, summary, home_team_id, home_team_abbr, home_team_name,
  away_team_id, away_team_abbr, away_team_name, home_score, away_score,
  source, observed_at, available_at, ingested_at, payload_hash, raw_r2_key, schema_version, build
) VALUES (
  ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
)
ON CONFLICT(game_id) DO UPDATE SET
  season=excluded.season,
  week=excluded.week,
  season_type=excluded.season_type,
  kickoff_at=excluded.kickoff_at,
  status_state=excluded.status_state,
  status_text=excluded.status_text,
  postseason=excluded.postseason,
  venue=excluded.venue,
  summary=excluded.summary,
  home_team_id=excluded.home_team_id,
  home_team_abbr=excluded.home_team_abbr,
  home_team_name=excluded.home_team_name,
  away_team_id=excluded.away_team_id,
  away_team_abbr=excluded.away_team_abbr,
  away_team_name=excluded.away_team_name,
  home_score=excluded.home_score,
  away_score=excluded.away_score,
  observed_at=excluded.observed_at,
  ingested_at=excluded.ingested_at,
  payload_hash=excluded.payload_hash,
  raw_r2_key=excluded.raw_r2_key,
  schema_version=excluded.schema_version,
  build=excluded.build
`;

const TEAM_SQL = `
INSERT INTO nfl_team_game_stats (
  game_id, bdl_game_id, season, week, season_type, team_id, team_abbr, team_name,
  opponent_team_id, opponent_abbr, home_away,
  first_downs, third_down_conversions, third_down_attempts, fourth_down_conversions,
  fourth_down_attempts, total_offensive_plays, total_yards, yards_per_play, total_drives,
  net_passing_yards, passing_completions, passing_attempts, yards_per_pass, sacks,
  sack_yards_lost, rushing_yards, rushing_attempts, yards_per_rush_attempt,
  red_zone_scores, red_zone_attempts, penalties, penalty_yards, turnovers, fumbles_lost,
  interceptions_thrown, defensive_touchdowns, possession_time_seconds,
  source, observed_at, available_at, ingested_at, payload_hash, raw_r2_key, schema_version, build
) VALUES (
  ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
)
ON CONFLICT(game_id, team_id) DO UPDATE SET
  season=excluded.season,
  week=excluded.week,
  season_type=excluded.season_type,
  team_abbr=excluded.team_abbr,
  team_name=excluded.team_name,
  opponent_team_id=excluded.opponent_team_id,
  opponent_abbr=excluded.opponent_abbr,
  home_away=excluded.home_away,
  first_downs=excluded.first_downs,
  third_down_conversions=excluded.third_down_conversions,
  third_down_attempts=excluded.third_down_attempts,
  fourth_down_conversions=excluded.fourth_down_conversions,
  fourth_down_attempts=excluded.fourth_down_attempts,
  total_offensive_plays=excluded.total_offensive_plays,
  total_yards=excluded.total_yards,
  yards_per_play=excluded.yards_per_play,
  total_drives=excluded.total_drives,
  net_passing_yards=excluded.net_passing_yards,
  passing_completions=excluded.passing_completions,
  passing_attempts=excluded.passing_attempts,
  yards_per_pass=excluded.yards_per_pass,
  sacks=excluded.sacks,
  sack_yards_lost=excluded.sack_yards_lost,
  rushing_yards=excluded.rushing_yards,
  rushing_attempts=excluded.rushing_attempts,
  yards_per_rush_attempt=excluded.yards_per_rush_attempt,
  red_zone_scores=excluded.red_zone_scores,
  red_zone_attempts=excluded.red_zone_attempts,
  penalties=excluded.penalties,
  penalty_yards=excluded.penalty_yards,
  turnovers=excluded.turnovers,
  fumbles_lost=excluded.fumbles_lost,
  interceptions_thrown=excluded.interceptions_thrown,
  defensive_touchdowns=excluded.defensive_touchdowns,
  possession_time_seconds=excluded.possession_time_seconds,
  observed_at=excluded.observed_at,
  ingested_at=excluded.ingested_at,
  payload_hash=excluded.payload_hash,
  raw_r2_key=excluded.raw_r2_key,
  schema_version=excluded.schema_version,
  build=excluded.build
`;

export async function archivePage(env, { phase, season, seasonType, cursor, rawText }) {
  if (!env.NFL_RAW) throw new Error("missing_NFL_RAW_binding");
  const payloadHash = await sha256Hex(rawText);
  const key = rawArchiveKey({ phase, season, seasonType, cursor, payloadHash });
  await env.NFL_RAW.put(key, rawText, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      provider: "balldontlie",
      phase,
      season: String(season),
      season_type: String(seasonType),
      schema_version: SCHEMA_VERSION,
      build: BUILD,
    },
  });
  return { payload_hash: payloadHash, r2_key: key };
}

function chunks(items, size = 40) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function upsertGames(env, rows, pageMeta) {
  let stored = 0;
  for (const group of chunks(rows)) {
    const statements = [];
    for (const r of group) {
      const hash = await sha256Hex(r);
      statements.push(env.NFL_DB.prepare(GAME_SQL).bind(
        r.game_id, r.bdl_game_id, r.season, r.week, r.season_type, r.kickoff_at,
        r.status_state, r.status_text, r.postseason, r.venue, r.summary,
        r.home_team_id, r.home_team_abbr, r.home_team_name,
        r.away_team_id, r.away_team_abbr, r.away_team_name,
        r.home_score, r.away_score, r.source, r.observed_at, r.available_at,
        r.ingested_at, hash, pageMeta.r2_key, r.schema_version, r.build
      ));
    }
    const results = await env.NFL_DB.batch(statements);
    stored += results.length;
  }
  return stored;
}

export async function upsertTeamStats(env, rows, pageMeta) {
  let stored = 0;
  for (const group of chunks(rows, 30)) {
    const statements = [];
    for (const r of group) {
      const hash = await sha256Hex(r);
      statements.push(env.NFL_DB.prepare(TEAM_SQL).bind(
        r.game_id, r.bdl_game_id, r.season, r.week, r.season_type,
        r.team_id, r.team_abbr, r.team_name, r.opponent_team_id, r.opponent_abbr, r.home_away,
        r.first_downs, r.third_down_conversions, r.third_down_attempts,
        r.fourth_down_conversions, r.fourth_down_attempts, r.total_offensive_plays,
        r.total_yards, r.yards_per_play, r.total_drives, r.net_passing_yards,
        r.passing_completions, r.passing_attempts, r.yards_per_pass, r.sacks,
        r.sack_yards_lost, r.rushing_yards, r.rushing_attempts, r.yards_per_rush_attempt,
        r.red_zone_scores, r.red_zone_attempts, r.penalties, r.penalty_yards,
        r.turnovers, r.fumbles_lost, r.interceptions_thrown, r.defensive_touchdowns,
        r.possession_time_seconds, r.source, r.observed_at, r.available_at, r.ingested_at,
        hash, pageMeta.r2_key, r.schema_version, r.build
      ));
    }
    const results = await env.NFL_DB.batch(statements);
    stored += results.length;
  }
  return stored;
}

export async function ensureRun(env, run) {
  await env.NFL_DB.prepare(`
    INSERT INTO ingest_runs (
      run_id, phase, season, season_type, status, cursor, processed_pages,
      fetched_rows, stored_rows, error_count, started_at, updated_at,
      completed_at, budget_json, checkpoint_json, build
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(run_id) DO NOTHING
  `).bind(
    run.run_id, run.phase, run.season, run.season_type, "running", run.cursor ?? null,
    0, 0, 0, 0, run.started_at, run.started_at, null,
    JSON.stringify(run.budget || {}), JSON.stringify({}), BUILD
  ).run();
}

export async function updateRun(env, runId, patch) {
  const now = new Date().toISOString();
  await env.NFL_DB.prepare(`
    UPDATE ingest_runs SET
      status=?,
      cursor=?,
      processed_pages=?,
      fetched_rows=?,
      stored_rows=?,
      error_count=?,
      updated_at=?,
      completed_at=?,
      budget_json=?,
      checkpoint_json=?
    WHERE run_id=?
  `).bind(
    patch.status, patch.cursor ?? null, patch.processed_pages ?? 0,
    patch.fetched_rows ?? 0, patch.stored_rows ?? 0, patch.error_count ?? 0,
    now, patch.completed_at ?? null, JSON.stringify(patch.budget || {}),
    JSON.stringify(patch.checkpoint || {}), runId
  ).run();
}

export async function getRun(env, runId) {
  return await env.NFL_DB.prepare(`SELECT * FROM ingest_runs WHERE run_id=?`).bind(runId).first();
}

export async function writeReceipt(env, receipt) {
  await env.NFL_DB.prepare(`
    INSERT INTO ingest_receipts (
      receipt_id, run_id, phase, season, season_type, page_cursor, next_cursor,
      source_row_count, stored_row_count, payload_hash, raw_r2_key,
      created_at, schema_version, build
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(receipt_id) DO NOTHING
  `).bind(
    receipt.receipt_id, receipt.run_id, receipt.phase, receipt.season, receipt.season_type,
    receipt.page_cursor ?? null, receipt.next_cursor ?? null, receipt.source_row_count,
    receipt.stored_row_count, receipt.payload_hash, receipt.raw_r2_key,
    receipt.created_at, SCHEMA_VERSION, BUILD
  ).run();
}

export async function upsertCertification(env, cert) {
  await env.NFL_DB.prepare(`
    INSERT INTO phase_certifications (
      cert_key, season, season_type, phase, complete, certified, expected_rows,
      found_rows, missing_rows, invalid_rows, details_json, assessed_at,
      schema_version, build
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(cert_key) DO UPDATE SET
      complete=excluded.complete,
      certified=excluded.certified,
      expected_rows=excluded.expected_rows,
      found_rows=excluded.found_rows,
      missing_rows=excluded.missing_rows,
      invalid_rows=excluded.invalid_rows,
      details_json=excluded.details_json,
      assessed_at=excluded.assessed_at,
      schema_version=excluded.schema_version,
      build=excluded.build
  `).bind(
    cert.cert_key, cert.season, cert.season_type, cert.phase,
    cert.complete ? 1 : 0, cert.certified ? 1 : 0,
    cert.expected_rows, cert.found_rows, cert.missing_rows, cert.invalid_rows,
    JSON.stringify(cert.details || {}), cert.assessed_at, SCHEMA_VERSION, BUILD
  ).run();
}

export async function latestCertification(env, season, seasonType, phase) {
  return await env.NFL_DB.prepare(`
    SELECT * FROM phase_certifications
    WHERE season=? AND season_type=? AND phase=?
    ORDER BY assessed_at DESC LIMIT 1
  `).bind(season, seasonType, phase).first();
}
