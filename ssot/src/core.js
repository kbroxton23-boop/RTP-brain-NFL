export const BUILD = "rtp-nfl-ssot-reconstruction-v1";
export const SCHEMA_VERSION = "nfl_ssot_v1";
export const PROVIDER = "balldontlie";

export function asInt(value, fallback = null) {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

export function asNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function asText(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  return s ? s : fallback;
}

export function canonicalGameId(game) {
  const id = asInt(game?.id);
  if (!id) throw new Error("game_missing_bdl_id");
  return `bdl:${id}`;
}

export function normalizeGame(game, observedAt = new Date().toISOString()) {
  const home = game?.home_team || {};
  const away = game?.visitor_team || {};
  const season = asInt(game?.season);
  const week = asInt(game?.week);
  const bdlGameId = asInt(game?.id);
  if (!bdlGameId || !season || !week) throw new Error("game_missing_identity");
  if (!asText(home?.abbreviation) || !asText(away?.abbreviation)) throw new Error("game_missing_team_identity");

  const statusState = asText(game?.status_state, "unknown").toLowerCase();
  const seasonType = game?.postseason === true ? 3 : 2;

  return {
    game_id: canonicalGameId(game),
    bdl_game_id: bdlGameId,
    season,
    week,
    season_type: seasonType,
    kickoff_at: asText(game?.date),
    status_state: statusState,
    status_text: asText(game?.status),
    postseason: game?.postseason === true ? 1 : 0,
    venue: asText(game?.venue),
    summary: asText(game?.summary),
    home_team_id: asInt(home?.id),
    home_team_abbr: asText(home?.abbreviation)?.toUpperCase() || null,
    home_team_name: asText(home?.full_name),
    away_team_id: asInt(away?.id),
    away_team_abbr: asText(away?.abbreviation)?.toUpperCase() || null,
    away_team_name: asText(away?.full_name),
    home_score: asInt(game?.home_team_score),
    away_score: asInt(game?.visitor_team_score),
    source: PROVIDER,
    observed_at: observedAt,
    available_at: null,
    ingested_at: observedAt,
    schema_version: SCHEMA_VERSION,
    build: BUILD,
  };
}

function possessionSide(stat, game) {
  const teamId = asInt(stat?.team?.id);
  const homeId = asInt(game?.home_team?.id);
  const awayId = asInt(game?.visitor_team?.id);
  if (teamId && homeId && teamId === homeId) return "home";
  if (teamId && awayId && teamId === awayId) return "away";
  return null;
}

export function normalizeTeamStat(stat, observedAt = new Date().toISOString()) {
  const game = stat?.game || {};
  const team = stat?.team || {};
  const gameId = canonicalGameId(game);
  const teamId = asInt(team?.id);
  if (!teamId || !asText(team?.abbreviation)) throw new Error("team_stat_missing_team_identity");

  const side = possessionSide(stat, game);
  const opponent = side === "home" ? game?.visitor_team : side === "away" ? game?.home_team : null;

  return {
    game_id: gameId,
    bdl_game_id: asInt(game?.id),
    season: asInt(game?.season),
    week: asInt(game?.week),
    season_type: game?.postseason === true ? 3 : 2,
    team_id: teamId,
    team_abbr: asText(team?.abbreviation)?.toUpperCase() || null,
    team_name: asText(team?.full_name),
    opponent_team_id: asInt(opponent?.id),
    opponent_abbr: asText(opponent?.abbreviation)?.toUpperCase() || null,
    home_away: side,
    first_downs: asInt(stat?.first_downs),
    third_down_conversions: asInt(stat?.third_down_conversions),
    third_down_attempts: asInt(stat?.third_down_attempts),
    fourth_down_conversions: asInt(stat?.fourth_down_conversions),
    fourth_down_attempts: asInt(stat?.fourth_down_attempts),
    total_offensive_plays: asInt(stat?.total_offensive_plays),
    total_yards: asInt(stat?.total_yards),
    yards_per_play: asNum(stat?.yards_per_play),
    total_drives: asInt(stat?.total_drives),
    net_passing_yards: asInt(stat?.net_passing_yards),
    passing_completions: asInt(stat?.passing_completions),
    passing_attempts: asInt(stat?.passing_attempts),
    yards_per_pass: asNum(stat?.yards_per_pass),
    sacks: asInt(stat?.sacks),
    sack_yards_lost: asInt(stat?.sack_yards_lost),
    rushing_yards: asInt(stat?.rushing_yards),
    rushing_attempts: asInt(stat?.rushing_attempts),
    yards_per_rush_attempt: asNum(stat?.yards_per_rush_attempt),
    red_zone_scores: asInt(stat?.red_zone_scores),
    red_zone_attempts: asInt(stat?.red_zone_attempts),
    penalties: asInt(stat?.penalties),
    penalty_yards: asInt(stat?.penalty_yards),
    turnovers: asInt(stat?.turnovers),
    fumbles_lost: asInt(stat?.fumbles_lost),
    interceptions_thrown: asInt(stat?.interceptions_thrown),
    defensive_touchdowns: asInt(stat?.defensive_touchdowns),
    possession_time_seconds: asInt(stat?.possession_time_seconds),
    source: PROVIDER,
    observed_at: observedAt,
    available_at: null,
    ingested_at: observedAt,
    schema_version: SCHEMA_VERSION,
    build: BUILD,
  };
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export async function sha256Hex(value) {
  const input = typeof value === "string" ? value : stableStringify(value);
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function makeBudget(input = {}) {
  const now = Date.now();
  const budgetMs = Math.max(5_000, Math.min(asInt(input.budget_ms, 80_000), 240_000));
  const callBudget = Math.max(1, Math.min(asInt(input.call_budget, 8), 100));
  const maxPages = Math.max(1, Math.min(asInt(input.max_pages, 5), 100));
  const maxRows = Math.max(1, Math.min(asInt(input.max_rows, 500), 10_000));
  return {
    started_ms: now,
    deadline_ms: now + budgetMs,
    budget_ms: budgetMs,
    call_budget: callBudget,
    max_pages: maxPages,
    max_rows: maxRows,
    calls_used: 0,
    pages_used: 0,
    rows_used: 0,
  };
}

export function budgetCanContinue(budget, reserveMs = 3_000) {
  if (Date.now() >= budget.deadline_ms - reserveMs) return false;
  if (budget.calls_used >= budget.call_budget) return false;
  if (budget.pages_used >= budget.max_pages) return false;
  if (budget.rows_used >= budget.max_rows) return false;
  return true;
}

export function markBudgetPage(budget, rows = 0) {
  budget.calls_used += 1;
  budget.pages_used += 1;
  budget.rows_used += Math.max(0, asInt(rows, 0));
  return budget;
}

export function safeSeason(value) {
  const season = asInt(value);
  if (!season || season < 2000 || season > 2100) throw new Error("invalid_season");
  return season;
}

export function safeSeasonType(value) {
  const v = asInt(value, 2);
  if (![1, 2, 3].includes(v)) throw new Error("invalid_season_type");
  return v;
}

export function rawArchiveKey({ phase, season, seasonType, cursor, payloadHash }) {
  const c = cursor === null || cursor === undefined || cursor === "" ? "START" : String(cursor);
  return [
    "raw", "bdl", "nfl", "v1", phase,
    `season=${season}`,
    `season_type=${seasonType}`,
    `cursor=${encodeURIComponent(c)}`,
    `${payloadHash}.json`,
  ].join("/");
}

export async function secureEqualText(a, b) {
  const aa = new TextEncoder().encode(String(a ?? ""));
  const bb = new TextEncoder().encode(String(b ?? ""));
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", aa),
    crypto.subtle.digest("SHA-256", bb),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}
