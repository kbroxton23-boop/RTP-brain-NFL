export const TRUTH_VERSION = "truth-v2";
export const TRUTH_BLOCKED = "BLOCKED_TRUTH";

export const REQUIRED_TEAM_STATS = Object.freeze([
  "pace_plays60",
  "pass_rate",
  "off_epa_play",
  "def_epa_play",
  "yards_per_play",
  "points_per_drive",
  "down_conversion_rate",
  "redzone_td_rate_off",
  "redzone_td_rate_def",
  "pressure_rate",
  "def_success",
  "sack_rate_allowed",
  "explosive_play_rate",
  "takeaways_per_game",
  "giveaways_per_game",
  "penalties_per_game"
]);

const FINAL_ONLY_KEYS = new Set([
  "final",
  "final_score",
  "home_final",
  "away_final",
  "winner",
  "ats_result",
  "total_result",
  "grade",
  "graded",
  "profit",
  "roi"
]);

function finiteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isoMs(v) {
  const n = Date.parse(String(v || ""));
  return Number.isFinite(n) ? n : null;
}

function pushErr(errors, code, detail = null) {
  errors.push(detail == null ? { code } : { code, detail });
}

function requireNonEmpty(errors, obj, key, code = `missing_${key}`) {
  const v = obj?.[key];
  if (v === null || v === undefined || String(v).trim() === "") pushErr(errors, code);
}

function requireAsOf(errors, label, ts, decisionMs) {
  const ms = isoMs(ts);
  if (ms == null) {
    pushErr(errors, `${label}_missing_asof`);
    return;
  }
  if (decisionMs != null && ms > decisionMs) {
    pushErr(errors, `${label}_lookahead`, { as_of: ts });
  }
}

function hasForbiddenFallback(meta) {
  if (!meta || typeof meta !== "object") return false;
  const kind = String(meta.fallback_kind ?? meta.fallback ?? "").toLowerCase();
  const sourceWeek = String(meta.source_week ?? "").toUpperCase();
  return (
    meta.used_future === true ||
    meta.used_current === true ||
    meta.used_default === true ||
    meta.used_all_bucket === true ||
    kind.includes("future") ||
    kind.includes("current") ||
    kind.includes("default") ||
    sourceWeek === "ALL"
  );
}

export function validateTeamSnapshot(teamRec, targetWeek, decisionTsUtc, label = "team") {
  const errors = [];
  const decisionMs = isoMs(decisionTsUtc);

  if (!teamRec || typeof teamRec !== "object") {
    pushErr(errors, `${label}_missing`);
    return errors;
  }

  requireAsOf(errors, label, teamRec.as_of_ts_utc, decisionMs);

  if (hasForbiddenFallback(teamRec.provenance) || hasForbiddenFallback(teamRec.meta)) {
    pushErr(errors, `${label}_forbidden_fallback`);
  }

  const target = Number(targetWeek);
  const through = Number(teamRec.through_week);
  if (Number.isFinite(target) && Number.isFinite(through) && through >= target) {
    pushErr(errors, `${label}_future_week_data`, { through_week: through, target_week: target });
  }

  const stats = teamRec.stats || {};
  for (const k of REQUIRED_TEAM_STATS) {
    if (!finiteNumber(stats[k])) pushErr(errors, `${label}_missing_stat`, { stat: k });
  }

  if (!Array.isArray(teamRec.source_game_ids)) {
    pushErr(errors, `${label}_missing_source_game_ids`);
  }

  return errors;
}

export function validateHistoricalTruthBundle(bundle) {
  const errors = [];

  if (!bundle || typeof bundle !== "object") {
    return { ok: false, status: TRUTH_BLOCKED, errors: [{ code: "missing_bundle" }] };
  }

  if (bundle.truth_version !== TRUTH_VERSION) {
    pushErr(errors, "wrong_truth_version", { got: bundle.truth_version ?? null });
  }

  for (const k of [
    "event_id",
    "season",
    "week",
    "season_type",
    "kickoff_ts_utc",
    "decision_ts_utc",
    "home_team",
    "away_team",
    "model_build",
    "calibration_version"
  ]) requireNonEmpty(errors, bundle, k);

  const kickoffMs = isoMs(bundle.kickoff_ts_utc);
  const decisionMs = isoMs(bundle.decision_ts_utc);
  if (kickoffMs == null) pushErr(errors, "invalid_kickoff_ts");
  if (decisionMs == null) pushErr(errors, "invalid_decision_ts");
  if (kickoffMs != null && decisionMs != null && decisionMs >= kickoffMs) {
    pushErr(errors, "decision_not_before_kickoff");
  }

  errors.push(...validateTeamSnapshot(bundle.home_stats, bundle.week, bundle.decision_ts_utc, "home_stats"));
  errors.push(...validateTeamSnapshot(bundle.away_stats, bundle.week, bundle.decision_ts_utc, "away_stats"));

  const roster = bundle.roster;
  if (!roster || typeof roster !== "object") {
    pushErr(errors, "missing_roster_truth");
  } else {
    requireAsOf(errors, "roster", roster.as_of_ts_utc, decisionMs);
    if (hasForbiddenFallback(roster.provenance) || hasForbiddenFallback(roster.meta)) {
      pushErr(errors, "roster_forbidden_fallback");
    }
  }

  const injuries = bundle.injuries;
  if (!injuries || typeof injuries !== "object") {
    pushErr(errors, "missing_injury_truth");
  } else {
    requireAsOf(errors, "injuries", injuries.as_of_ts_utc, decisionMs);
    if (hasForbiddenFallback(injuries.provenance) || hasForbiddenFallback(injuries.meta)) {
      pushErr(errors, "injuries_forbidden_fallback");
    }
  }

  const market = bundle.market;
  if (!market || typeof market !== "object") {
    pushErr(errors, "missing_market_truth");
  } else {
    requireAsOf(errors, "market", market.snapshot_ts_utc, decisionMs);
    if (hasForbiddenFallback(market.provenance) || hasForbiddenFallback(market.meta)) {
      pushErr(errors, "market_forbidden_fallback");
    }
    if (!finiteNumber(market.spread_home)) pushErr(errors, "market_missing_spread");
    if (!finiteNumber(market.total)) pushErr(errors, "market_missing_total");
    if (!finiteNumber(market.home_ml)) pushErr(errors, "market_missing_home_ml");
    if (!finiteNumber(market.away_ml)) pushErr(errors, "market_missing_away_ml");
  }

  if (bundle.weather?.applicable !== false) {
    if (!bundle.weather || typeof bundle.weather !== "object") {
      pushErr(errors, "missing_weather_truth");
    } else {
      requireAsOf(errors, "weather", bundle.weather.as_of_ts_utc, decisionMs);
      if (hasForbiddenFallback(bundle.weather.provenance) || hasForbiddenFallback(bundle.weather.meta)) {
        pushErr(errors, "weather_forbidden_fallback");
      }
    }
  }

  const cal = bundle.calibration;
  if (!cal || typeof cal !== "object") {
    pushErr(errors, "missing_calibration_truth");
  } else {
    const cutoffMs = isoMs(cal.training_cutoff_ts_utc);
    if (cutoffMs == null) pushErr(errors, "calibration_missing_cutoff");
    if (cutoffMs != null && decisionMs != null && cutoffMs >= decisionMs) {
      pushErr(errors, "calibration_lookahead", { cutoff: cal.training_cutoff_ts_utc });
    }
    if (cal.contains_target_event === true || cal.contains_future_results === true) {
      pushErr(errors, "calibration_contains_future_truth");
    }
  }

  if (bundle.final || bundle.grade || bundle.result) {
    pushErr(errors, "pregame_bundle_contains_final_truth");
  }

  if (hasForbiddenFallback(bundle.provenance) || hasForbiddenFallback(bundle.meta)) {
    pushErr(errors, "bundle_forbidden_fallback");
  }

  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? "TRUTH_CERTIFIED" : TRUTH_BLOCKED,
    errors
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (FINAL_ONLY_KEYS.has(key)) continue;
    const v = value[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

export async function computeTruthInputHash(bundle) {
  const clone = canonicalize(bundle);
  delete clone.input_hash;
  const bytes = new TextEncoder().encode(JSON.stringify(clone));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export function assertHistoricalTruthBundle(bundle) {
  const result = validateHistoricalTruthBundle(bundle);
  if (!result.ok) {
    const err = new Error(TRUTH_BLOCKED);
    err.code = TRUTH_BLOCKED;
    err.truth_errors = result.errors;
    throw err;
  }
  return result;
}
