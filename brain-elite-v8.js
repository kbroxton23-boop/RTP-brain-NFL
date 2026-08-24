/**
 * RTP NFL Brain v3.1 — Elite Engine + Clean Calibrations (NFL-only)
 *
 * Core:
 *   - Ingest NFL team stats (Sumer-style CSV / JSON) into KV
 *   - Read team stats from KV to build matchup payloads
 *   - Elite matchup engine: EPA + RZ + trench + context + calibration
 *   - NFL game lines from The Odds API for anchors/edges
 *   - Props scoring (line vs projection, Normal CDF, Kelly)
 *   - Last slate cache for UI
 *
 * Required bindings (wrangler.toml):
 *   [[kv_namespaces]]
 *   binding = "RTP_CACHE"
 *   id      = "xxxxxxxxxxxxxxxxxxxx"
 *
 *   [vars]
 *   ODDS_API_KEY = "your_odds_api_key_here"
 *   UI_ORIGIN    = "https://your-ui.example.com" # optional
 */

const SPORT = "nfl";

// Normalize team abbreviations (handles common aliases)
function normalizeTeamAbbr(t) {
  if (!t) return null;
  const x = String(t).trim().toUpperCase();
  const map = {
    JAC: "JAX",
    LA: "LAR",
    STL: "LAR",
    SD: "LAC",
    OAK: "LV",
    ARZ: "ARI",
    KAN: "KC",
    SFO: "SF",
    NWE: "NE",
    NOR: "NO",
    TAM: "TB",
    GNB: "GB",
    KCC: "KC"
  };
  return map[x] || x;
}



const BUILD = "elite-v8-p12f";
const CALFIT_VERSION = "elite-v8-p12f-calfit-prod3-v23-totalsec";
// ========= Calibration =========
const CAL_DEFAULTS = {
  temp_tau: 1.10,
  spread_a: 0.0,
  spread_b: 0.95,
  // ML calibration knobs (keeps spread market stable while making ML less jumpy)
  // - home_field_ml_mult: fraction of home_field used for ML conversion (not for spread market)
  // - ml_spread_scale: additional shrink/expand on spread before converting to win prob
  home_field_ml_mult: 0.60,
  ml_spread_scale: 0.85,
  total_a: -1.0,
  total_b: 0.98,
  ci80_inflate: 1.08,
  w_ypp: 7.0,
  w_epa: 10.0,
  w_redzone: 18.0,
  w_success: 10.0,
  w_trench: 6.0,
  w_turnovers: 4.0,
  w_penalties: 0.10,
  w_plays: 0.12,
  home_field: 1.75
};

// Core matchup weights (from your v2 brain)
const TRENCH_WEIGHT   = 12;
const TURNOVER_WEIGHT = 14;
const INJURY_WEIGHT   = 0.25;

async function getCal(env) {
  const fromKv = await kvGet(env, "calibration:params");
  if (fromKv) return { ...CAL_DEFAULTS, ...fromKv };
  return { ...CAL_DEFAULTS };
}


async function getCalFit(env, season) {
  try {
    const s = Number(season);
    if (!s) return null;
    const raw = await env.RTP_CACHE.get(`calfit:${s}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function _clamp01(p) { return Math.min(0.999999, Math.max(0.000001, p)); }
function _logit(p) { const pp=_clamp01(p); return Math.log(pp/(1-pp)); }
function _sigmoid(z) { return 1/(1+Math.exp(-z)); }


function defaultTeamStats() {
  // Injury total (for UI/model): prefer net_penalty/off+def penalty from payload; else derive from computed injury_penalty.
  let inj_total = num(
    g('injury_impact.net_penalty') ??
    g('injury_impact.offense_penalty') ??
    g('injury_impact.defense_penalty') ??
    undefined
  , NaN);
  if (!Number.isFinite(inj_total)) inj_total = Math.abs(num(injury_penalty, 0));
  // keep as positive magnitude
  inj_total = Math.abs(inj_total);

  return {
    pace_plays60: 62.0000,
    pass_rate: 0.58000,

    off_epa_play: 0,
    def_epa_play: 0,

    yards_per_play: 5.0000000,
    points_per_drive: 2.00000,
    down_conversion_rate: 0.750000,

    redzone_td_rate_off: 0.550000,
    redzone_td_rate_def: 0.550000,

    pressure_rate: 0.30000,
    def_success: 0.45000,
    sack_rate_allowed: 0.06000,
    explosive_play_rate: 0.12000,

    takeaways_per_game: 1.3000,
    giveaways_per_game: 1.3000,
    penalties_per_game: 6.5000,

    recent_form: {},
    injuries_summary: null,
    _injury_penalty: 0,
    extras: {}
  };
}

// ========= Small helpers =========
// NOTE: define this BEFORE jsonResponse() to avoid `ReferenceError: normalizeOrigin is not defined`
// when running from Cloudflare Dashboard HTTP tester.
function normalizeOrigin(origin) {
  if (typeof origin !== "string") return "*";
  const o = origin.trim();
  if (!o) return "*";
  return o.endsWith("/") ? o.slice(0, -1) : o;
}

// Safe JSON parser used by multiple handlers.
// Returns `null` on parse failure instead of throwing.
function safeJsonParse(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === "object") return input; // already parsed
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}
function jsonResponse(status, body, origin) {
  // Also support: jsonResponse(body, { origin, status })
  if (status && typeof status === "object" && body && typeof body === "object" && ("status" in body || "origin" in body) && !Array.isArray(body)) {
    const opts = body;
    body = status;
    status = opts.status;
    origin = opts.origin;
  }
  // Cloudflare Workers requires a valid HTTP status code (200..599).
  // Some paths can accidentally pass a non-number (e.g. a meta object) or undefined,
  // which would hard-crash the Worker with:
  // "Responses may only be constructed with status codes in the range 200 to 599".
  let s = Number(status);
  if (!Number.isFinite(s)) {
    // Prefer 500 for error payloads; otherwise default to 200.
    s = body && body.ok === false ? 500 : 200;
  }
  s = Math.trunc(s);
  if (s < 200 || s > 599) {
    s = body && body.ok === false ? 500 : 200;
  }

  const o = normalizeOrigin(origin);
  const headers = {
    "content-type": "application/json; charset=utf-8",
  };
  if (o) headers["access-control-allow-origin"] = o;

  return new Response(JSON.stringify(body), { status: s, headers });
}

function ok(data, meta = {}, origin, status = 200) {
  // Allow flexible call signatures across the codebase:
  // ok(data, meta?, origin?, status?)
  // ok(data, origin)
  // ok(data, status)
  if (typeof meta === "string" && origin === undefined) {
    origin = meta;
    meta = {};
  } else if (typeof meta === "number" && origin === undefined) {
    status = meta;
    meta = {};
  }
  if (typeof origin === "number") {
    status = origin;
    origin = undefined;
  }
  origin = normalizeOrigin(origin);

  try { if (meta && typeof meta === "object") meta.build = BUILD; } catch (_) {}
  return jsonResponse(status, { ok: true, data, meta, error: null }, origin);
}

function fail(error, a = 400, b = {}, origin) {
  // Supports both calling conventions used across the codebase:
  // 1) fail(error, status, meta, origin)
  // 2) fail(error, meta, status, origin)
  let status = 400;
  let meta = {};

  if (typeof a === "number") {
    status = a;
    meta = (b && typeof b === "object") ? b : {};
  } else {
    meta = (a && typeof a === "object") ? a : {};
    status = (typeof b === "number") ? b : 400;
  }

  // Also allow: fail(error, meta, origin) or fail(error, status, origin)
  if (typeof b === "string" && origin === undefined) {
    origin = b;
    b = {};
  }
  if (typeof origin === "number") {
    status = origin;
    origin = undefined;
  }
  origin = normalizeOrigin(origin);

  try { if (meta && typeof meta === "object") meta.build = BUILD; } catch (_) {}
  return jsonResponse(status, { ok: false, data: null, meta, error }, origin);
}

async function readJson(req) {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid_json_body");
  }
}

function parseCsvLight(text) {
  const lines = String(text || "").split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];
  const header = lines[0].split(",").map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const row = {};
    header.forEach((h, idx) => {
      const val = (cols[idx] ?? "").replace(/^"|"$/g, "").replace(/""/g, '"').trim();
      row[h] = val;
    });
    rows.push(row);
  }
  return rows;
}

function normalizeWeekParam(w) {
  if (w == null) return null;
  const s = String(w).trim();
  if (!s || s.toLowerCase() === "all") return null;
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : null;
}

function parseCSV(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  if (!lines.length) return [];

  const headers = splitCSVLine(lines[0]).map(h => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCSVLine(lines[i]);
    if (!cells.length) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = (cells[c] ?? "").trim();
    }
    rows.push(obj);
  }
  rows._headers = headers;
  return rows;
}

async function parseTeamsCSVText(csvText, seasonDefault = 2025, weekDefault = null) {
  const rows = parseCSV(csvText);
  const headers = rows._headers || [];

  const schema = detectTeamsSchema(headers);

  if (schema === "long_sumer") {
    return { schema, teams: buildTeamsFromLong(rows, seasonDefault, weekDefault) };
  }

  if (schema === "wide_team_rows") {
    return { schema, teams: buildTeamsFromWide(rows, seasonDefault, weekDefault) };
  }

  return { schema: "unknown", teams: {}, headers };
}

function splitCSVLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"' && inQ && next === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') {
      inQ = !inQ;
    } else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function detectTeamsSchema(headers) {
  const h = new Set(headers.map(x => String(x ?? "").toLowerCase()));

  const looksLong =
    h.has("metric") &&
    (h.has("value") || h.has("values")) &&
    (h.has("team_abbr") || h.has("team") || h.has("team_id")) &&
    h.has("bucket");

  const looksWide =
    h.has("team") || h.has("team_abbr") ||
    // legacy flat columns
    h.has("pace_plays60") || h.has("pass_rate") ||
    // dotted "teamwell" columns
    h.has("pace.pace_plays60") || h.has("efficiency.off_epa_play") || h.has("redzone.redzone_td_rate_off");

  if (looksLong) return "long_sumer";
  if (looksWide) return "wide_team_rows";
  return "unknown";
}

function norm(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

// ======== PROPS ENGINE HELPERS (no stubs) ========

// super simple CSV parser / formatter (ok for clean CSVs)
function parseCsvBasic(text) {
  const lines = (text || "").trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };

  const headers = lines[0].split(",").map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const cols = line.split(",");
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = cols[i] !== undefined ? cols[i] : "";
    });
    return obj;
  });

  return { headers, rows };
}

function stringifyCsvBasic(headers, rows) {
  const esc = v => {
    if (v === null || v === undefined) return "";
    return String(v).replace(/"/g, '""');
  };
  const lines = [];
  lines.push(headers.join(","));
  for (const row of rows) {
    lines.push(headers.map(h => esc(row[h])).join(","));
  }
  return lines.join("\n");
}

// numeric helper
function toNum(v, fallback = NaN) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// normal CDF via erf approximation
function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// American odds → Kelly fraction (relative to bankroll)
function kellyFromProb(p, american) {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  let b;
  const price = Number(american);
  if (!Number.isFinite(price) || price === 0) {
    // assume even money
    b = 1;
  } else if (price > 0) {
    b = price / 100;
  } else {
    b = 100 / Math.abs(price);
  }
  const f = (p * (b + 1) - 1) / b;
  return f > 0 ? f : 0;
}

// classify PrizePicks-like market into a simple bucket
function inferMarket(row) {
  const mRaw = (row.market || row.prop_market || "").toString().toLowerCase();
  const m = mRaw.replace(/\s+/g, " ");

  if (m.includes("pass") && m.includes("yard")) return { key: "pass_yds", stat: "yards" };
  if (m.includes("rush") && m.includes("yard")) return { key: "rush_yds", stat: "yards" };
  if (m.includes("rec") && m.includes("yard")) return { key: "rec_yds", stat: "yards" };
  if ((m.includes("rec") || m.includes("catch")) && !m.includes("yard")) return { key: "receptions", stat: "count" };
  if (m.includes("rush") && (m.includes("att") || m.includes("carry"))) return { key: "rush_att", stat: "count" };
  if (m.includes("pass") && m.includes("td")) return { key: "pass_tds", stat: "count" };
  if (m.includes("rush") && m.includes("td")) return { key: "rush_tds", stat: "count" };
  if (m.includes("rec") && m.includes("td")) return { key: "rec_tds", stat: "count" };
  if (m.includes("fg") && (m.includes("made") || m.includes("field goal"))) return { key: "fg_made", stat: "count" };

  return { key: "generic", stat: "generic" };
}

// main projection logic using row-level advanced metrics when present

function clampMeanForMarket(key, mean) {
  if (!Number.isFinite(mean)) return mean;
  // Hard plausibility bands to prevent insane anchors from bad parses
  if (key === "pass_yds") return Math.min(Math.max(mean, 50), 450);
  if (key === "rush_yds") return Math.min(Math.max(mean, 5), 250);
  if (key === "rec_yds") return Math.min(Math.max(mean, 5), 250);
  if (key === "receptions") return Math.min(Math.max(mean, 0), 20);
  if (key === "pass_tds") return Math.min(Math.max(mean, 0), 6);
  if (key === "rush_rec_tds" || key === "rush_tds" || key === "rec_tds") return Math.min(Math.max(mean, 0), 4);
  if (key === "fg_made") return Math.min(Math.max(mean, 0), 6);
  return mean;
}

function projectPropRow(row) {
  const line = toNum(row.line ?? row.prop_line ?? row.pp_line, 0);
  const odds = toNum(row.price_american ?? row.odds_american ?? -119, -119); // default book-ish price
  const m = inferMarket(row);

  const g = name => toNum(row[name]);

  let mean = NaN;

  // 1) if user already stuffed a projection column, trust it (only if plausible for the market)
  if (!Number.isNaN(g("rtp_proj"))) {
    const candidate = g("rtp_proj");
    const clamped = clampMeanForMarket(m.key, candidate);
    if (Math.abs(clamped - candidate) < 1e-9) mean = candidate;
  } else if (!Number.isNaN(g("proj_mean"))) {
    mean = g("proj_mean");
  }

  // 2) Otherwise build from advanced stats when we recognize the market
  if (Number.isNaN(mean)) {
    if (m.key === "pass_yds") {
      // Prefer per-game passing yards when present (avoids season-total inflation)
      const pg = g("ss_passing_yards_per_game");
      const total = g("ss_passing_yards") || g("ap_pass_yards");
      const games = g("ss_games_played") || g("ap_games_played");
      if (!Number.isNaN(pg) && pg > 0) mean = pg;
      else if (!Number.isNaN(total) && !Number.isNaN(games) && games > 0) mean = total / games;
      else {
        // Fallback: approximate per-game from attempts + completion% + completed air yards (+ small YAC kicker)
        const attTot = g("ss_passing_attempts") || g("ap_attempts");
        const cPct = g("ap_completion_percentage");
        const cAir = g("ap_avg_completed_air_yards");
        if (!Number.isNaN(attTot) && !Number.isNaN(games) && games > 0 && !Number.isNaN(cPct) && !Number.isNaN(cAir)) {
          const att = attTot / games;
          const comp = att * (cPct / 100);
          mean = comp * (cAir + 3);
        }
      }
    } else if (m.key === "receptions") {
      // Prefer per-game receptions
      const games = g("ss_games_played") || g("ap_games_played");
      const recTot = g("ss_receptions") || g("av_receptions");
      if (!Number.isNaN(recTot) && !Number.isNaN(games) && games > 0) mean = recTot / games;
      else {
        // Fallback: per-game completions estimate (not great for non-QBs, but keeps scale sane)
        const compTot = g("ap_completions");
        const attTot = g("ss_passing_attempts") || g("ap_attempts");
        const cPct = g("ap_completion_percentage");
        if (!Number.isNaN(compTot) && !Number.isNaN(games) && games > 0) mean = compTot / games;
        else if (!Number.isNaN(attTot) && !Number.isNaN(games) && games > 0 && !Number.isNaN(cPct)) mean = (attTot / games) * (cPct / 100);
      }
    } else if (m.key === "rush_yds") {
      // Prefer per-game rushing yards
      const pg = g("ss_rushing_yards_per_game");
      const total = g("ss_rushing_yards") || g("ar_rush_yards");
      const games = g("ss_games_played") || g("ap_games_played");
      if (!Number.isNaN(pg) && pg > 0) mean = pg;
      else if (!Number.isNaN(total) && !Number.isNaN(games) && games > 0) mean = total / games;
      else {
        // Fallback: attempts per game * ypc
        const attTot = g("ss_rushing_attempts") || g("ar_rush_attempts") || g("rush_attempts") || g("ra_attempts") || g("carries");
        const ypc = g("ss_yards_per_rush_attempt") || g("rush_yards_per_attempt") || g("ra_yards_per_attempt") || g("yards_per_carry");
        if (!Number.isNaN(attTot) && !Number.isNaN(games) && games > 0 && !Number.isNaN(ypc)) mean = (attTot / games) * ypc;
      }
    } else if (m.key === "rec_yds") {
      // Prefer per-game receiving yards
      const pg = g("ss_receiving_yards_per_game");
      const total = g("ss_receiving_yards") || g("av_yards");
      const games = g("ss_games_played") || g("ap_games_played");
      if (!Number.isNaN(pg) && pg > 0) mean = pg;
      else if (!Number.isNaN(total) && !Number.isNaN(games) && games > 0) mean = total / games;
      else {
        // Fallback: receptions per game * ypr OR targets per game * ypt
        const recTot = g("ss_receptions") || g("av_receptions") || g("receptions");
        const ypr = g("ss_yards_per_reception") || g("yards_per_reception") || g("ypr");
        const tgtTot = g("ss_receiving_targets") || g("av_targets") || g("targets");
        const ypt = g("yards_per_target") || g("ypt");
        if (!Number.isNaN(recTot) && !Number.isNaN(games) && games > 0 && !Number.isNaN(ypr)) mean = (recTot / games) * ypr;
        else if (!Number.isNaN(tgtTot) && !Number.isNaN(games) && games > 0 && !Number.isNaN(ypt)) mean = (tgtTot / games) * ypt;
      }
    } else if (m.key.endsWith("_tds")) {
      // TD markets – light Poisson style, built off implied TD rate if present
      const tdRate = g("td_rate") || g("redzone_td_rate") || g("rush_td_rate") || g("rec_td_rate");
      const opp = g("opp_td_rate") || g("opp_redzone_td_rate");
      const uses = g("opportunities") || g("touches") || g("targets") || g("rush_attempts") || g("ra_attempts");
      if (!Number.isNaN(tdRate) && !Number.isNaN(uses)) {
        const base = tdRate * uses;
        const defAdj = !Number.isNaN(opp) ? (0.8 + (opp - 0.5)) : 1.0;
        mean = base * defAdj;
      }
    }
  }

  // 3) Fallbacks – if we still don't know, shade around the line (slight edge to lean)
  if (Number.isNaN(mean)) {
    if (!Number.isNaN(line) && line > 0) {
      const lean = (row.lean || "").toString().toLowerCase();
      const bump = m.stat === "count" ? 0.3 : 0.05 * line;
      if (lean.includes("more") || lean.includes("over")) mean = line + bump;
      else if (lean.includes("less") || lean.includes("under")) mean = line - bump;
      else mean = line; // truly neutral
    } else {
      mean = 0;
    }
  }


  // Final plausibility clamp (prevents insane means from poisoning sigma/prob)
  const _mean_before_clamp = mean;
  mean = clampMeanForMarket(m.key, mean);
  const _mean_clamped = (Number.isFinite(_mean_before_clamp) && Number.isFinite(mean) && Math.abs(mean - _mean_before_clamp) > 1e-9);

  // 4) Volatility model per market
  let sigma;
  if (!Number.isNaN(g("rtp_sigma"))) {
    sigma = g("rtp_sigma");
  } else {
    const base = Math.max(Math.abs(mean), Math.abs(line));
    if (m.key === "pass_yds") sigma = 0.32 * base + 8;        // ~ 1/3 of mean
    else if (m.key === "rush_yds" || m.key === "rec_yds") sigma = 0.40 * base + 5;
    else if (m.stat === "count") sigma = 0.8 + 0.35 * base;
    else sigma = 0.35 * base + 5;
  }
  if (!Number.isFinite(sigma) || sigma <= 0) sigma = 10;

  // 5) Probabilities + Kelly
  const z = (line - mean) / sigma;
  const pUnder = normCdf(z);
  const pOver  = 1 - pUnder;

  // bookmaker implied probability (includes vig if only one side is provided)
  const pBook = oddsToImplied(odds);

  // payout (net profit) per 1 unit staked at American odds
  const payout = (() => {
    const o = Number(odds) || -110;
    return o > 0 ? (o / 100) : (100 / Math.abs(o));
  })();

  // Kelly fractions by side (already capped inside helper)
  const kOver  = kellyFromProb(pOver, odds);
  const kUnder = kellyFromProb(pUnder, odds);

  // Expected value per 1 unit staked (profit units). Positive = +EV.
  const evOver  = (pOver  * payout) - (1 - pOver);
  const evUnder = (pUnder * payout) - (1 - pUnder);

  // edges vs bookmaker implied (rough when only one side odds is known)
  const edgeOver  = pOver  - pBook;
  const edgeUnder = pUnder - pBook;

  // pick best side primarily by EV; fall back to probability
  const bestSide = (evOver > evUnder) ? "over" : (evUnder > evOver ? "under" : (pOver >= pUnder ? "over" : "under"));
  const bestProb = bestSide === "over" ? pOver : pUnder;
  const bestKelly = bestSide === "over" ? kOver : kUnder;
  const bestEV = bestSide === "over" ? evOver : evUnder;
  const bestEdge = bestSide === "over" ? edgeOver : edgeUnder;

  // grading blends win-prob + EV + stake sizing
  let grade = "D";
  if (bestProb >= 0.66 && bestEV >= 0.04 && bestKelly >= 0.04) grade = "A";
  else if (bestProb >= 0.60 && bestEV >= 0.02 && bestKelly >= 0.025) grade = "B";
  else if (bestProb >= 0.55 && bestEV >= 0.00 && bestKelly >= 0.01) grade = "C";

  // If projection had to be clamped into a plausible range, treat this as low-confidence
  // to avoid creating fake "elite" anchors from bad upstream projection parsing.
  if (_mean_clamped) {
    if (grade === "A" || grade === "B") grade = "C";
  }

  const edge = mean - line; // positive = over lean

  // anchor score – pillaring legs: prefers high prob + meaningful EV + sane Kelly
  const _anchorScoreRaw = Math.max(0, Math.min(100,
    ((bestProb - 0.5) * 120) +
    (bestEV * 250) +
    (Math.min(bestKelly, 0.08) * 300)
  ));
  const anchorScore = _mean_clamped ? Math.min(_anchorScoreRaw * 0.4, 60) : _anchorScoreRaw;
return {
    line,
    odds,
    mean,
    sigma,
    edge,
    pOver,
    pUnder,
    pBook,
    payout,
    evOver,
    evUnder,
    bestSide,
    bestProb,
    bestKelly,
    bestEV,
    bestEdge,
    grade,
    anchorScore,
    marketKey: m.key,
  };}

// Base aliases WITHOUT off/def prefix logic
const METRIC_ALIASES = {
  // pace / volume
  "pace_plays60": "pace_plays60",
  "plays60": "pace_plays60",
  "plays_per_60": "pace_plays60",
  "plays_per_game": "plays_per_game",

  // pass tendencies
  "pass_rate": "pass_rate",

  // EPA (we will prefix by section)
  "epa": "epa_play",
  "total_epa": "epa_play",
  "epa_play": "epa_play",

  // success
  "success_rate": "success_rate",
  "def_success": "def_success",

  // red zone
  "redzone_td_rate": "redzone_td_rate",
  "red_zone_td_rate": "redzone_td_rate",
  "rz_td_rate": "redzone_td_rate",

  // trenches / pressure
  "pressure_rate": "pressure_rate",
  "sack_rate_allowed": "sack_rate_allowed",

  // explosives
  "explosive_play_rate": "explosive_play_rate"
};


function buildCalGameKey(season, week, away, home, event_id) {
  const s = String(season ?? "").trim();
  const w = String(week ?? "").trim();
  const a = String(away ?? "").trim();
  const h = String(home ?? "").trim();
  const eid = String(event_id ?? "optional").trim() || "optional";
  if (!s || !w || !a || !h) return null;
  return `calgame:${s}:${w}:${a}@${h}:${eid}`;
}

function num(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}


function nflSeasonFromDate(d) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1; // 1-12
  // NFL regular season mostly spans Sep -> Jan; Jan/Feb belong to prior season
  return (m <= 2) ? (y - 1) : y;
}
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Safety: some older branches call avgDefEPA/avgOffEPA; keep as stable helpers
function avgDefEPA(obj) {
  const t = obj && (obj.stats || obj);
  return num(t && (t.def_epa_play ?? t.def_epa), 0);
}
function avgOffEPA(obj) {
  const t = obj && (obj.stats || obj);
  return num(t && (t.off_epa_play ?? t.off_epa), 0);
}


function safeWeightedFromGroups(groups, defaults = { pass_rate: 0.58, epa: 0 }) {
  const list = Object.values(groups || {}).filter(Boolean);

  const usable = list.filter(g =>
    Number.isFinite(Number(g.weight)) ||
    Number.isFinite(Number(g.pass_rate)) ||
    Number.isFinite(Number(g.epa))
  );

  if (!usable.length) {
    return { pass_rate: defaults.pass_rate, off_epa_play: defaults.epa, used: 0 };
  }

  let wSum = 0, wPass = 0, wEpa = 0, used = 0;

  for (const g of usable) {
    const w  = Number(g.weight);
    const pr = g.pass_rate != null ? Number(g.pass_rate) : null;
    const e  = g.epa != null ? Number(g.epa) : null;

    if (!Number.isFinite(w) || w <= 0) continue;

    wSum += w;
    if (Number.isFinite(pr)) wPass += w * pr;
    if (Number.isFinite(e))  wEpa  += w * e;
    used++;
  }

  if (wSum <= 0 || used < 2) {
    const prs = usable.map(g => Number(g.pass_rate)).filter(Number.isFinite);
    const eps = usable.map(g => Number(g.epa)).filter(Number.isFinite);

    const avgPr = prs.length ? prs.reduce((a,b)=>a+b,0)/prs.length : defaults.pass_rate;
    const avgE  = eps.length ? eps.reduce((a,b)=>a+b,0)/eps.length : defaults.epa;

    return { pass_rate: avgPr, off_epa_play: avgE, used: prs.length + eps.length };
  }

  const pass_rate = wPass !== 0 ? (wPass / wSum) : defaults.pass_rate;
  const off_epa_play = wEpa !== 0 ? (wEpa / wSum) : defaults.epa;

  return { pass_rate, off_epa_play, used };
}

// Normal CDF approximation
function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  const prob =
    d *
    t *
    (0.319381530 +
      t * (-0.356563782 +
      t * (1.781477937 +
      t * (-1.821255978 +
      t * 1.330274429))));
  return x > 0 ? 1 - prob : prob;
}

function buildTeamsFromLong(rows, seasonDefault = 2025, weekDefault = null) {
  const teams = {};

  for (const r of rows) {
    const team =
      r.team_abbr || r.team || r.teamAbbr || r.abbr || "";

    if (!team) continue;

    const bucket = norm(r.bucket);
    const section = norm(r.section); // offense / defense
    const scope = norm(r.scope);     // base / refined
    const refinement = norm(r.refinement);

    // Focus on the stable signals first
    const isOverview =
      bucket.includes("overview") ||
      bucket === "overview";

    const isRedZoneBucket =
      bucket.includes("red_zone") ||
      bucket.includes("redzone");

    // You can widen this later for formations/personnel
    if (!isOverview && !isRedZoneBucket) continue;

    // Prefer base, but allow refined if you want
    if (scope && scope !== "base" && scope !== "refined") continue;

    const rawMetric = norm(r.metric);
    const alias = METRIC_ALIASES[rawMetric];
    if (!alias) continue;

    const vRaw = r.value ?? r.values ?? r.val ?? "";
    const value = Number(vRaw);
    if (!Number.isFinite(value)) continue;

    if (!teams[team]) {

    // Create base stats container first (so we can safely write to stats.extras below)
    const initStats = defaultTeamStats();

    // Preserve a few useful non-core columns into stats.extras (if present)
    const EXTRA_WIDE = {
      "pressure_rate_allowed_off": "pressure_rate_allowed_off",
      "sack_rate_generated_def": "sack_rate_generated_def",
      "yards_per_play_def": "yards_per_play_def",
      "points_per_drive_def": "points_per_drive_def",
      "third_down_def_allowed": "third_down_def_allowed"
    };
    for (const [ek, outk] of Object.entries(EXTRA_WIDE)) {
      if (r[ek] != null && r[ek] !== "") {
        const v = Number(r[ek]);
        if (Number.isFinite(v)) initStats.extras[outk] = v;
      }
    }

    teams[team] = {
      season: Number(r.season) || seasonDefault,
      week: r.week ? Number(r.week) : weekDefault,
      team,
      stats,
      // Preserve raw dotted/nested so modifiers & feature registry (including splits.*) can function end-to-end.
      raw_dotted,
      raw_nested,
      // Convenience accessors for splits (if present)
      splits: (raw_nested && typeof raw_nested === "object") ? (raw_nested.splits || null) : null,
      splits_meta: {
        groups: (raw_nested && raw_nested.splits && typeof raw_nested.splits === "object") ? Object.keys(raw_nested.splits) : []
      },
      audit: {
        missing_core: CORE_KEYS.filter(k => stats[k] == null),
        missing_patch: []
      },
      meta: {}
    };
  }

const stats = teams[team].stats;

    // ----- alias routing -----

    // EPA gets prefixed by section
    if (alias === "epa_play") {
      if (section === "offense") stats.off_epa_play = value;
      else if (section === "defense") stats.def_epa_play = value;
      else {
        // fallback if section missing
        if (stats.off_epa_play === 0) stats.off_epa_play = value;
      }
      continue;
    }

    // success rate: your core list uses def_success
    if (alias === "success_rate") {
      if (section === "defense") stats.def_success = value;
      continue;
    }

    // red zone TD rate by section
    if (alias === "redzone_td_rate") {
      if (section === "offense") stats.redzone_td_rate_off = value;
      else if (section === "defense") stats.redzone_td_rate_def = value;
      else {
        // bucket-based fallback
        if (isRedZoneBucket) {
          // If we can't tell which side, don't overwrite both.
          if (stats.redzone_td_rate_off === 0.55) stats.redzone_td_rate_off = value;
        }
      }
      continue;
    }

    // direct map keys
    if (alias in stats) {
      stats[alias] = value;
      continue;
    }

    // plays_per_game can help compute pace if you want later
    if (alias === "plays_per_game") {
      stats.extras.plays_per_game = value;
    }
  }

  // audit
  for (const t of Object.values(teams)) {
    t.audit.missing_core = CORE_KEYS.filter(k => t.stats[k] == null);
  }

  return teams;
}


function buildTeamsFromWide(rows, seasonDefault = 2025, weekDefault = null) {
  // Build raw_dotted + raw_nested so downstream (modifiers/splits) can be applied.
  // raw_dotted preserves original dotted keys (e.g. "splits.early_down.off.epa_play").
  // raw_nested materializes them into nested objects (e.g. splits -> early_down -> off -> epa_play).

  const _setDeep = (obj, parts, val) => {
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
      const k = parts[i];
      if (!k) continue;
      if (i === parts.length - 1) { cur[k] = val; return; }
      if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
      cur = cur[k];
    }
  };

  const teams = {};

  for (const r0 of rows) {
    // Normalize keys to avoid BOM / NBSP / trailing spaces breaking alias mapping.
    const r = _normalizeRowKeys(r0 || {});
    const team = r.team_abbr || r.team || r.abbr;
    if (!team) continue;

    // 1) Capture dotted columns for modifiers/splits support
    const raw_dotted = {};
    const raw_nested = {};
    for (const [dk0, dv0] of Object.entries(r)) {
      const dk = String(dk0 || "");
      if (dk.includes(".")) {
        const dvn = Number(dv0);
        const dv = Number.isFinite(dvn) ? dvn : (dv0 === "" ? null : dv0);
        raw_dotted[dk] = dv;
        _setDeep(raw_nested, dk.split("."), dv);
      }
    }

    // 2) Map dotted/alternate headers into the brain's flat keys
    // (e.g. efficiency.off_epa_play -> off_epa_play)
    for (const [from, to] of Object.entries(WIDE_ALIASES)) {
      if (r[from] != null && r[from] !== "" && (r[to] == null || r[to] === "")) {
        r[to] = r[from];
      }
    }

    // 3) Fill core flat stats from the row (if present)
    const stats = defaultTeamStats();
    for (const k of CORE_KEYS) {
      if (r[k] != null && r[k] !== "") {
        const v = Number(r[k]);
        if (Number.isFinite(v)) stats[k] = v;
      }
    }

    // 4) If key stats are still default-y, compute them from the raw_nested canonical paths
    // Pace: prefer average plays/game (off + def faced) rather than possession seconds.
    const pOff = num(_getIn(raw_nested, "pace.plays_per_game_off"), null);
    const pDef = num(_getIn(raw_nested, "pace.plays_per_game_def_faced"), null);
    const paceNeedFix =
      (stats.pace_plays60 == null || !Number.isFinite(stats.pace_plays60) || stats.pace_plays60 < 40 || stats.pace_plays60 > 80);
    // Also persist underlying plays/game if available
    if (pOff != null && (stats.plays_per_game_off == null || !Number.isFinite(stats.plays_per_game_off))) stats.plays_per_game_off = pOff;
    if (pDef != null && (stats.plays_per_game_def_faced == null || !Number.isFinite(stats.plays_per_game_def_faced))) stats.plays_per_game_def_faced = pDef;

    if (paceNeedFix && (pOff != null || pDef != null)) {
      const pace = (pOff != null && pDef != null) ? (0.5 * pOff + 0.5 * pDef) : (pOff ?? pDef);
      stats.pace_plays60 = clamp(num(pace, 62), 40, 80);
    }

    // EPA: pull directly from efficiency.* if present
    const offE = num(_getIn(raw_nested, "efficiency.off_epa_play"), null);
    const defE = num(_getIn(raw_nested, "efficiency.def_epa_play"), null);
    if ((stats.off_epa_play == null || stats.off_epa_play === 0) && offE != null) stats.off_epa_play = clamp(offE, -0.30, 0.30);
    if ((stats.def_epa_play == null || stats.def_epa_play === 0) && defE != null) stats.def_epa_play = clamp(defE, -0.30, 0.30);

    // Pass rate: tendencies.pass_rate_off
    const pr = _asRate(_getIn(raw_nested, "tendencies.pass_rate_off"));
    if ((stats.pass_rate == null || stats.pass_rate === 0.58) && pr != null) stats.pass_rate = clamp(pr, 0.30, 0.80);

    // Red zone TD rates
    const rzOff = _asRate(_getIn(raw_nested, "redzone.redzone_td_rate_off"));
    const rzDef = _asRate(_getIn(raw_nested, "redzone.redzone_td_rate_def"));
    if ((stats.redzone_td_rate_off == null || stats.redzone_td_rate_off === 0.55) && rzOff != null) stats.redzone_td_rate_off = clamp(rzOff, 0.2, 0.8);
    if ((stats.redzone_td_rate_def == null || stats.redzone_td_rate_def === 0.55) && rzDef != null) stats.redzone_td_rate_def = clamp(rzDef, 0.2, 0.8);

    // YPP / PPD
    const ypp = num(_getIn(raw_nested, "efficiency.yards_per_play_off"), null);
    const ppd = num(_getIn(raw_nested, "efficiency.points_per_drive_off"), null);
    if ((stats.yards_per_play == null || stats.yards_per_play === 5.3) && ypp != null) stats.yards_per_play = clamp(ypp, 4.0, 6.8);
    if ((stats.points_per_drive == null || stats.points_per_drive === 2.0) && ppd != null) stats.points_per_drive = clamp(ppd, 1.0, 3.2);

    // 3rd down
    const td = _asRate(_getIn(raw_nested, "conversion.third_down_conv_rate_off"));
    if ((stats.down_conversion_rate == null || stats.down_conversion_rate === 0.75) && td != null) stats.down_conversion_rate = clamp(td, 0.25, 0.85);

    // Turnovers / penalties
    const ta = num(_getIn(raw_nested, "turnovers.takeaways_per_game"), null);
    const ga = num(_getIn(raw_nested, "turnovers.giveaways_per_game"), null);
    const pen = num(_getIn(raw_nested, "penalties.penalties_per_game"), null);
    if ((stats.takeaways_per_game == null || stats.takeaways_per_game === 1.3) && ta != null) stats.takeaways_per_game = clamp(ta, 0.2, 3.0);
    if ((stats.giveaways_per_game == null || stats.giveaways_per_game === 1.3) && ga != null) stats.giveaways_per_game = clamp(ga, 0.2, 3.0);
    if ((stats.penalties_per_game == null || stats.penalties_per_game === 6.5) && pen != null) stats.penalties_per_game = clamp(pen, 3.0, 10.0);

    // Trench-ish proxies
    const prAllowed = _asRate(_getIn(raw_nested, "pass.pressure_rate_allowed_off"));
    const sackTaken = _asRate(_getIn(raw_nested, "pass.sack_rate_taken_off"));
    if ((stats.pressure_rate == null || stats.pressure_rate === 0.30) && prAllowed != null) stats.pressure_rate = clamp(prAllowed, 0.15, 0.45);
    if ((stats.sack_rate_allowed == null || stats.sack_rate_allowed === 0.06) && sackTaken != null) stats.sack_rate_allowed = clamp(sackTaken, 0.02, 0.12);

    // Explosives + defensive success
    const ex = num(_getIn(raw_nested, "explosives.explosive_efficiency_off"), null);
    const ds = _asRate(_getIn(raw_nested, "efficiency.def_success_rate"));
    if ((stats.explosive_play_rate == null || stats.explosive_play_rate === 0.12) && ex != null) stats.explosive_play_rate = clamp(ex, 0.05, 0.25);
    if ((stats.def_success == null || stats.def_success === 0.45) && ds != null) stats.def_success = clamp(ds, 0.35, 0.55);

    teams[team] = {
      season: Number(r.season) || seasonDefault,
      week: r.week ? Number(r.week) : weekDefault,
      team,
      stats,
      raw_dotted,
      raw_nested,
      splits: raw_nested.splits || null,
      audit: {
        missing_core: CORE_KEYS.filter(k => stats[k] == null),
        missing_patch: []
      },
      meta: {}
    };
  }

  return teams;
}

function resolveTeamAbbrFromRow(row) {
  const raw =
    row.team_abbr ||
    row.team ||
    row.team_name ||
    row.Team ||
    row.TEAM ||
    "";

  const v = String(raw).trim();
  if (!v) return "";

  // If already an abbr
  const up = v.toUpperCase();
  if (up.length <= 4) return up;

  // Try name -> abbr
  const fromName = teamNameToAbbr(v);
  return fromName || up;
}

function abbrToTeamName(abbr) {
  if (!abbr) return "";
  const a = String(abbr).toUpperCase();
  const map = {
    ARI: "Arizona Cardinals",
    ATL: "Atlanta Falcons",
    BAL: "Baltimore Ravens",
    BUF: "Buffalo Bills",
    CAR: "Carolina Panthers",
    CHI: "Chicago Bears",
    CIN: "Cincinnati Bengals",
    CLE: "Cleveland Browns",
    DAL: "Dallas Cowboys",
    DEN: "Denver Broncos",
    DET: "Detroit Lions",
    GB:  "Green Bay Packers",
    HOU: "Houston Texans",
    IND: "Indianapolis Colts",
    JAX: "Jacksonville Jaguars",
    KC:  "Kansas City Chiefs",
    LV:  "Las Vegas Raiders",
    LAC: "Los Angeles Chargers",
    LAR: "Los Angeles Rams",
    MIA: "Miami Dolphins",
    MIN: "Minnesota Vikings",
    NE:  "New England Patriots",
    NO:  "New Orleans Saints",
    NYG: "New York Giants",
    NYJ: "New York Jets",
    PHI: "Philadelphia Eagles",
    PIT: "Pittsburgh Steelers",
    SF:  "San Francisco 49ers",
    SEA: "Seattle Seahawks",
    TB:  "Tampa Bay Buccaneers",
    TEN: "Tennessee Titans",
    WAS: "Washington Commanders"
  };
  return map[a] || "";
}

// Map Odds API team names -> abbreviations
function teamNameToAbbr(name) {
  if (!name) return "";
  const n = String(name).toLowerCase();
  const map = {
    "arizona cardinals": "ARI",
    "atlanta falcons": "ATL",
    "baltimore ravens": "BAL",
    "buffalo bills": "BUF",
    "carolina panthers": "CAR",
    "chicago bears": "CHI",
    "cincinnati bengals": "CIN",
    "cleveland browns": "CLE",
    "dallas cowboys": "DAL",
    "denver broncos": "DEN",
    "detroit lions": "DET",
    "green bay packers": "GB",
    "houston texans": "HOU",
    "indianapolis colts": "IND",
    "jacksonville jaguars": "JAX",
    "kansas city chiefs": "KC",
    "las vegas raiders": "LV",
    "los angeles chargers": "LAC",
    "los angeles rams": "LAR",
    "miami dolphins": "MIA",
    "minnesota vikings": "MIN",
    "new england patriots": "NE",
    "new orleans saints": "NO",
    "new york giants": "NYG",
    "new york jets": "NYJ",
    "philadelphia eagles": "PHI",
    "pittsburgh steelers": "PIT",
    "san francisco 49ers": "SF",
    "seattle seahawks": "SEA",
    "tampa bay buccaneers": "TB",
    "tennessee titans": "TEN",
    "washington commanders": "WAS",
  };
  return map[n] || "";
}

// --- Injury helpers ---
function canonTeamAbbrFromInjFeed(abbr) {
  const a = String(abbr || "").toUpperCase();
  if (a === "WSH") return "WAS";
  return a;
}

function aggregateInjuriesFromFeed(feedJson) {
  const teams = {};
  for (const item of (feedJson && feedJson.data) || []) {
    const teamObj = item.player && item.player.team;
    if (!teamObj) continue;

    const abbr = canonTeamAbbrFromInjFeed(teamObj.abbreviation);
    if (!abbr) continue;

    const t = (teams[abbr] ||= {
      total: 0,
      statuses: { Out: 0, "Injured Reserve": 0, Questionable: 0 }
    });

    const rawStatus = String(item.status || "").toLowerCase();

    let bucket = null;
    if (rawStatus.includes("injured reserve") || rawStatus === "ir") bucket = "Injured Reserve";
    else if (rawStatus.includes("question")) bucket = "Questionable";
    else if (rawStatus.includes("doubt")) bucket = "Questionable";
    else if (rawStatus.includes("suspension")) bucket = "Out";
    else if (rawStatus.includes("out")) bucket = "Out";

    if (!bucket) continue;

    t.statuses[bucket] = (t.statuses[bucket] || 0) + 1;
    t.total += 1;
  }
  return teams;
}

async function mergeInjuriesIntoTeams(env, { season, week, teamsInj }) {
  const updated = [];
  for (const [team, summary] of Object.entries(teamsInj)) {
    const existing = await getTeamStats(env, { season, week, team });
    if (!existing) continue;

    const baseStats = existing.stats || existing;
    const mergedStats = { ...baseStats, injuries_summary: summary };

    await saveTeamStats(env, { season, week, team, stats: mergedStats });

    updated.push({
      team: String(team).toUpperCase(),
      total: summary.total,
      statuses: summary.statuses
    });
  }
  return updated;
}

// ========= KV helpers =========
async function kvGet(env, key) {
  const raw = await env.RTP_CACHE.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function kvPut(env, key, obj, ttlSec) {
  const payload = { ...obj, asOf: new Date().toISOString() };
  const options = ttlSec ? { expirationTtl: ttlSec } : undefined;
  await env.RTP_CACHE.put(key, JSON.stringify(payload), options);
  return payload;
}

// ========= Injuries summary map (from /injuries/ingest) =========
async function getInjurySummary(env, season, week, sourcePref) {
  // Returns map: TEAM -> { inj_total, injuries_summary, _injury_penalty, source }
  const w = week == null || week === "" ? "ALL" : String(week);
  const sources = Array.isArray(sourcePref) && sourcePref.length ? sourcePref : ["bdl", "mateo", "espn"];

  let raw = null;
  let usedKey = null;
  let usedSource = null;

  // Prefer canonical keys produced by /injuries/build
  for (const src of sources) {
    const key = injuriesCacheKey(season, w, src);
    const txt = await env.RTP_CACHE.get(key);
    if (txt) {
      raw = safeJsonParse(txt);
      usedKey = key;
      usedSource = src;
      break;
    }
  }

  // Legacy fallback
  if (!raw) {
    const legacyKey = `injuries:${season}:${w}`;
    const txt = await env.RTP_CACHE.get(legacyKey);
    if (txt) {
      raw = safeJsonParse(txt);
      usedKey = legacyKey;
      usedSource = "legacy";
    }
  }

  const map = (raw && raw.teams && typeof raw.teams === "object") ? raw.teams : ((raw && raw.injuries_by_team && typeof raw.injuries_by_team === "object") ? raw.injuries_by_team : {});
  // Non-team metadata (safe key name unlikely to collide with NFL team codes)
  map.__meta = {
    cache_key: (raw && raw.cache_key) || usedKey,
    source: usedSource,
    vendor: (raw && raw.vendor) || usedSource,
    built_at: (raw && raw.built_at) || null,
  };
  return map;
}
// ========= Calibration game logs =========
const CAL_GAME_TTL = 365 * 24 * 3600;

function normalizeEventId(eventId) {
  if (eventId == null) return "";
  const s = String(eventId).trim();
  if (!s) return "";
  const low = s.toLowerCase();
  if (low === "optional" || low === "null" || low === "undefined" || low === "none" || low === "na" || low === "n/a") return "";
  // Keep it KV-safe and short-ish
  return s.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 32);
}

function calGameKey(season, week, home, away, eventId, nonce) {
  const w = week == null || week === "" ? "ALL" : String(week);
  const cleaned = normalizeEventId(eventId);
  const eid = cleaned || `${Date.now()}-${(nonce ?? Math.random().toString(36).slice(2, 8))}`;
  return `calgame:${season}:${w}:${String(home).toUpperCase()}@${String(away).toUpperCase()}:${eid}`;
}

async function saveCalGame(env, payload, nonce) {
  const { season, week, home, away } = payload;
  const key = calGameKey(season, week, home, away, payload.event_id, nonce);
  await kvPut(env, key, payload, CAL_GAME_TTL);
  return { key, saved: true };
}

// List ALL KV keys under a prefix
async function listAllKeys(env, prefix) {
  const all = [];
  let cursor = undefined;

  while (true) {
    const res = await env.RTP_CACHE.list({ prefix, cursor });
    if (res && Array.isArray(res.keys)) all.push(...res.keys);
    if (!res || res.list_complete || !res.cursor) break;
    cursor = res.cursor;
  }
  return all;
}


// Back-compat helper: list KV keys by prefix (optionally limited)
async function listKeysByPrefix(env, prefix, limit = 1000) {
  const keys = await listAllKeys(env, prefix);
  // listAllKeys returns KV key objects ({name, ...}) in CF KV; normalize to string names.
  const names = Array.isArray(keys) ? keys.map(k => (typeof k === "string" ? k : (k && k.name) ? k.name : String(k))) : [];
  if (typeof limit === "number" && limit > 0 && names.length > limit) return names.slice(0, limit);
  return names;
}

// Load all cal games (for /cal/game/list)
async function loadAllCalGames(env, { season, week } = {}) {
  const s = season ? String(season) : "";
  const w = week == null || week === "" ? "ALL" : String(week);

  const prefix = s
    ? `calgame:${s}:${w}:`
    : `calgame:`;

  const keys = await listAllKeys(env, prefix);
  const games = [];

  for (const { name } of keys) {
    const raw = await env.RTP_CACHE.get(name);
    if (!raw) continue;
    try {
      games.push(JSON.parse(raw));
    } catch {}
  }

  if (season && week == null) {
    // If season specified but not week, also include other week buckets
    // by scanning a broader prefix
    const broad = await listAllKeys(env, `calgame:${season}:`);
    for (const { name } of broad) {
      const raw = await env.RTP_CACHE.get(name);
      if (!raw) continue;
      try {
        const g = JSON.parse(raw);
        games.push(g);
      } catch {}
    }
  }

  // de-dupe lightly by key fields
  const seen = new Set();
  const out = [];
  for (const g of games) {
    const key = `${g.season}:${g.week ?? "ALL"}:${g.home}@${g.away}:${g.event_id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }

  return out;
}

// ========= Team stats (Team Well) =========
const TEAM_STATS_TTL = 7 * 24 * 3600;
const MATCHUP_TTL   = 3 * 24 * 3600;

function teamKey(season, week, team) {
  const s = String(season ?? "");
  const w = String(week ?? "ALL");
  const t = String(team ?? "").toUpperCase();
  // Version the KV key by BUILD so schema changes don't get "stuck" behind old cached rows.
  // This is the root cause when uploads appear to "use old keys" unless you manually delete KV.
  return `teamstats:${BUILD}:${s}:${w}:${t}`;
}
function teamKeyLegacy(season, week, team) {
  const s = String(season ?? "");
  const w = String(week ?? "ALL");
  const t = String(team ?? "").toUpperCase();
  return `teamstats:${s}:${w}:${t}`;
}

function matchupKey(season, week, home, away) {
  return `matchup:${season}:${week ?? "ALL"}:${String(home).toUpperCase()}@${String(away).toUpperCase()}`;
}

async function saveTeamStats(env, { season, week, team, stats, raw_dotted, raw_nested, source, splits, splits_meta }) {
  if (!season || !team || !stats) throw new Error("teamstats_missing_fields");
  const key = teamKey(season, week, team);

  // If splits not explicitly provided, try to derive from raw payloads (CSV dotted or nested).
  let derivedSplits = splits ?? null;
  if (!derivedSplits) {
    if (raw_nested && typeof raw_nested === "object" && raw_nested.splits && typeof raw_nested.splits === "object") {
      derivedSplits = raw_nested.splits;
    } else if (raw_dotted && typeof raw_dotted === "object") {
      const nested = undotToNested(raw_dotted);
      if (nested && typeof nested === "object" && nested.splits && typeof nested.splits === "object") {
        derivedSplits = nested.splits;
      }
    }
  }

  const payload = {
    season: Number(season),
    week: week ?? null,
    team: String(team).toUpperCase(),
    stats,
    raw_dotted: raw_dotted ?? null,
    raw_nested: raw_nested ?? null,
    splits: derivedSplits ?? null,
    splits_meta: splits_meta ?? null,
    source: source ?? null
  };

  await env.RTP_CACHE.put(key, JSON.stringify(payload), { expirationTtl: TEAM_STATS_TTL });
  return { key, saved: true };
}

async function getTeamStats(env, { season, week, team }) {
  const t = String(team || "").toUpperCase();
  if (!season || !t) return null;

  const exact = await env.RTP_CACHE.get(teamKey(season, week, t));
  if (exact) return JSON.parse(exact);

  const any = await env.RTP_CACHE.get(teamKey(season, "ALL", t));
  if (any) return JSON.parse(any);

  // IMPORTANT: playoffs can push "week" beyond 18.
  // Keep this list wide so lookups still work even when callers pass week=null.
  const weeks = [
    "22","21","20","19",
    "18","17","16","15","14","13","12","11",
    "10","9","8","7","6","5","4","3","2","1",
    "ALL"
  ];
  for (const w of weeks) {
    const kNew = teamKey(season, w, t);
    const kOld = teamKeyLegacy(season, w, t);
    const row = (await env.RTP_CACHE.get(kNew)) || (await env.RTP_CACHE.get(kOld));
    if (row) return JSON.parse(row);
  }
  return null;
}

const WIDE_ALIASES = {
  // dotted teamwell -> brain flat keys
  "pace.pace_plays60": "pace_plays60",
  "efficiency.off_epa_play": "off_epa_play",
  "efficiency.def_epa_play": "def_epa_play",
  "redzone.redzone_td_rate_off": "redzone_td_rate_off",
  "redzone.redzone_td_rate_def": "redzone_td_rate_def",
  "pass.pressure_rate_def": "pressure_rate",
  "pass.sack_rate_taken_off": "sack_rate_allowed",
  "explosives.explosive_efficiency_off": "explosive_play_rate",
  "efficiency.yards_per_play_off": "yards_per_play",
  "efficiency.points_per_drive_off": "points_per_drive",
  "conversion.third_down_conv_rate_off": "down_conversion_rate",
  "turnovers.takeaways_per_game": "takeaways_per_game",
  "turnovers.giveaways_per_game": "giveaways_per_game",
  "penalties.penalties_per_game": "penalties_per_game",
  "tendencies.pass_rate_off": "pass_rate",
  "tendencies.pass_rate": "pass_rate",
  "pass.pressure_rate_allowed_off": "pressure_rate_allowed_off",
  "pass.sack_rate_generated_def": "sack_rate_generated_def",
  "efficiency.yards_per_play_def": "yards_per_play_def",
  "efficiency.points_per_drive_def": "points_per_drive_def",
  "conversion.third_down_conv_rate_def_allowed": "third_down_def_allowed",

  // other possible column names we might see
  "team_abbr": "team",
  "abbr": "team"

};

// Fallback key-paths for pulling stats out of a nested team object
// (used by the brain when a value is missing at the top-level).
const CORE_FALLBACK_PATHS = {

  pass_rate: ["pass_rate", "tendencies.pass_rate_off"],
  yards_per_play: ["yards_per_play", "efficiency.yards_per_play_off"],
  points_per_drive: ["points_per_drive", "efficiency.points_per_drive_off"],
  down_conversion_rate: ["down_conversion_rate", "conversion.third_down_conv_rate_off"],
  takeaways_per_game: ["takeaways_per_game", "turnovers.takeaways_per_game"],
  giveaways_per_game: ["giveaways_per_game", "turnovers.giveaways_per_game"],
  penalties_per_game: ["penalties_per_game", "penalties.penalties_per_game"],
  off_epa_play: ["off_epa_play", "efficiency.off_epa_play"],
  def_epa_play: ["def_epa_play", "efficiency.def_epa_play"],
  def_success: ["def_success", "efficiency.def_success_rate"],
  redzone_td_rate_off: ["redzone_td_rate_off", "redzone.redzone_td_rate_off"],
  redzone_td_rate_def: ["redzone_td_rate_def", "redzone.redzone_td_rate_def"],
  pressure_rate: ["pressure_rate", "pass.pressure_rate_def"],
  sack_rate_allowed: ["sack_rate_allowed", "pass.sack_rate_taken_off"],
  explosive_play_rate: ["explosive_play_rate", "explosives.explosive_efficiency_off"],
  plays_per_game_off: ["plays_per_game_off", "pace.plays_per_game_off"],
  plays_per_game_def_faced: ["plays_per_game_def_faced", "pace.plays_per_game_def_faced"],
  seconds_per_play_off: ["seconds_per_play_off", "pace.seconds_per_play_off"],
  seconds_per_play_def_faced: ["seconds_per_play_def_faced", "pace.seconds_per_play_def"],
  pace_plays60: ["pace_plays60", "pace.plays_per_game_off", "pace.plays_per_game_def_faced"],
  pressure_rate_allowed_off: ["pressure_rate_allowed_off", "pass.pressure_rate_allowed_off"],
  sack_rate_generated_def: ["sack_rate_generated_def", "pass.sack_rate_generated_def"],
  yards_per_play_def: ["yards_per_play_def", "efficiency.yards_per_play_def"],
  points_per_drive_def: ["points_per_drive_def", "efficiency.points_per_drive_def"],
  third_down_def_allowed: ["third_down_def_allowed", "conversion.third_down_conv_rate_def_allowed"],
};

const CORE_KEYS = [
  "pace_plays60",
  "pass_rate",
  "off_epa_play",
  "def_epa_play",
  "yards_per_play",
  "points_per_drive",
  "down_conversion_rate",
  "takeaways_per_game",
  "giveaways_per_game",
  "penalties_per_game",
  "redzone_td_rate_off",
  "redzone_td_rate_def",
  "pressure_rate",
  "def_success",
  "sack_rate_allowed",
  "explosive_play_rate",
  "plays_per_game_off",
  "plays_per_game_def_faced",
  "seconds_per_play_off",
  "seconds_per_play_def_faced",
  "pressure_rate_allowed_off",
  "sack_rate_generated_def",
  "yards_per_play_def",
  "points_per_drive_def",
  "third_down_def_allowed"
];


// ========= Stat Registry + Weights (for transparent tuning) =========

const STAT_REGISTRY = {
  // Core stats used by matchup model
  pace_plays60:          { sources: ["pace.plays_per_game_off", "pace.plays_per_game_def_faced"],                         default: 62,   scale: 1.0,  clamp: [40, 80] },
  pass_rate:             { sources: ["tendencies.pass_rate_off", "offense.pass_rate", "pass.pass_rate_off"],           default: 0.58, scale: 1.0,  clamp: [0.35, 0.75] },

  off_epa_play:          { sources: ["efficiency.off_epa_play", "offense.epa_play", "offense.epa_per_play"],          default: 0.00, scale: 1.0,  clamp: [-0.30, 0.30] },
  def_epa_play:          { sources: ["efficiency.def_epa_play", "defense.epa_play", "defense.epa_per_play"],          default: 0.00, scale: 1.0,  clamp: [-0.30, 0.30] },
  yards_per_play:        { sources: ["efficiency.yards_per_play_off", "offense.yards_per_play", "offense.ypp"],          default: 5.30, scale: 1.0,  clamp: [4.0, 6.8] },
  points_per_drive:      { sources: ["efficiency.points_per_drive_off", "offense.points_per_drive", "offense.ppd"],     default: 2.00, scale: 1.0,  clamp: [1.0, 3.2] },
  down_conversion_rate:  { sources: ["conversion.third_down_conv_rate_off", "offense.third_down_pct", "offense.3d_pct"], default: 0.75, scale: 1.0, clamp: [0.25, 0.85] },
  takeaways_per_game:    { sources: ["turnovers.takeaways_per_game", "defense.takeaways_per_game"],                  default: 1.30, scale: 1.0,  clamp: [0.2, 3.0] },
  giveaways_per_game:    { sources: ["turnovers.giveaways_per_game", "offense.giveaways_per_game"],                  default: 1.30, scale: 1.0,  clamp: [0.2, 3.0] },

  penalties_per_game:    { sources: ["penalties.penalties_per_game"],                                                default: 6.50, scale: 1.0,  clamp: [3.0, 10.0] },

  redzone_td_rate_off:   { sources: ["redzone.redzone_td_rate_off", "redzone.redzone_td_rate_off_td_only"],          default: 0.55, scale: 1.0,  clamp: [0.35, 0.75] },
  redzone_td_rate_def:   { sources: ["redzone.redzone_td_rate_def", "redzone.redzone_td_rate_def_td_only"],          default: 0.55, scale: 1.0,  clamp: [0.35, 0.75] },

  // "pressure_rate" is defensive pressure generated (not allowed)
  pressure_rate:         { sources: ["pass.pressure_rate_def", "pass.pressure_rate_generated_def"],                  default: 0.30, scale: 1.0,  clamp: [0.15, 0.45] },

  def_success:           { sources: ["efficiency.def_success_rate", "defense.success_rate_def"],                      default: 0.45, scale: 1.0,  clamp: [0.35, 0.55] },

  sack_rate_allowed:     { sources: ["pass.sack_rate_taken_off", "pass.sack_rate_allowed_off"],                      default: 0.06, scale: 1.0,  clamp: [0.02, 0.12] },

  // Proxy until we have true explosive play rate column
  explosive_play_rate:   { sources: ["explosives.explosive_efficiency_off", "explosives.explosive_rate_off"],        default: 0.12, scale: 1.0,  clamp: [0.05, 0.25] },
};

/**
 * Dynamic registry: make every raw_dotted stat weightable.
 * We treat dotted keys (e.g. splits.early_down.off.epa_play) as stat_ids.
 * Core flat ids remain the primary model inputs.
 */
function inferGroupFromStatId(id) {
  if (!id) return "misc";
  if (id.startsWith("splits.early_down.")) return "splits_early_down";
  if (id.startsWith("splits.late_down.")) return "splits_late_down";
  if (id.startsWith("splits.red_zone.")) return "splits_red_zone";
  if (id.startsWith("splits.non_garbage_time.")) return "splits_non_garbage";
  if (id.startsWith("pace.")) return "pace";
  if (id.startsWith("efficiency.")) return "efficiency";
  if (id.startsWith("pass.")) return "pass";
  if (id.startsWith("rush.")) return "rush";
  if (id.startsWith("tendencies.")) return "tendencies";
  if (id.startsWith("conversion.")) return "conversion";
  if (id.startsWith("redzone.")) return "redzone";
  if (id.startsWith("explosives.")) return "explosives";
  if (id.startsWith("turnovers.")) return "turnovers";
  if (id.startsWith("penalties.")) return "penalties";
  if (id.startsWith("injury_impact.")) return "injury_impact";
  return "misc";
}

function inferDirFromStatId(id) {
  // +1 means higher is better; -1 means lower is better
  const s = String(id || "").toLowerCase();
  // Defensive "allowed/against" and bad outcomes
  if (s.includes("allowed") || s.includes("_allowed") || s.includes("against")) return -1;
  if (s.includes("giveaways")) return -1;
  if (s.includes("penalties")) return -1;
  if (s.includes("sack_rate_taken") || s.includes("sack_rate_allowed")) return -1;
  // Defensive efficiency: higher EPA/YPP/success allowed is worse
  if (s.includes("def_epa") || s.includes(".def.epa") || s.includes("def.epa")) return -1;
  if (s.includes("yards_per_play_def") || s.includes(".yards_per_play_def") || s.includes("ypp_def")) return -1;
  if (s.includes("def_success") || s.includes(".def.success") || s.includes("def_success_rate")) return -1;
  // Redzone defense: higher TD rate allowed is worse
  if (s.includes("td_rate_def") || s.includes("redzone_td_rate_def")) return -1;
  return +1;
}

function inferTypeFromStatId(id) {
  const s = String(id || "").toLowerCase();
  if (s.includes("epa")) return "epa";
  if (s.includes("yards_per_play") || s.includes("ypp")) return "ypp";
  if (s.includes("points_per_drive")) return "ppd";
  if (s.includes("seconds_per_play")) return "sec";
  if (s.includes("rate") || s.includes("pct") || s.includes("success") || s.includes("pass_rate") || s.includes("rush_rate") || s.includes("share")) return "rate";
  return "float";
}

function inferCenterScale(id) {
  const t = inferTypeFromStatId(id);
  if (t === "rate") return { center: 0.5, scale: 0.20 };
  if (t === "epa") return { center: 0.0, scale: 0.25 };
  if (t === "ypp") return { center: 5.0, scale: 1.25 };
  if (t === "ppd") return { center: 2.0, scale: 0.75 };
  if (t === "sec") return { center: 29.0, scale: 3.0 };
  return { center: 0.0, scale: 1.0 };
}

function buildDynamicRegistryFromRaw(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of Object.keys(raw)) {
    if (!k || k === "team" || k === "team_abbr") continue;
    if (!k.includes(".")) continue; // raw dotted stats only
    const { center, scale } = inferCenterScale(k);
    out[k] = {
      sources: [k],
      default: null,
      center,
      scale,
      dir: inferDirFromStatId(k),
      group: inferGroupFromStatId(k),
      desc: null
    };
  }
  return out;
}

function parseAnyNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (!s) return null;
  if (s.includes("%")) {
    const n = parseFloat(s.replace("%",""));
    if (!Number.isFinite(n)) return null;
    return n / 100;
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function standardizeDynamic(id, value, def) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const { center, scale, dir } = def || {};
  const c = (typeof center === "number") ? center : 0;
  const sc = (typeof scale === "number" && scale > 0) ? scale : 1;
  let v = value;
  // clamp rates into [0,1] if they look like rates
  if (inferTypeFromStatId(id) === "rate") {
    if (v > 1) v = v / 100;
    if (v < 0) v = 0;
    if (v > 1) v = 1;
  }
  const z = ((v - c) / sc) * ((dir === -1) ? -1 : 1);
  // cap to keep modifiers stable
  if (z > 6) return 6;
  if (z < -6) return -6;
  return z;
}

function _normKey(k) {
  return String(k ?? "").replace(/\u00A0/g, " ").trim();
}

function _normalizeRowKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[_normKey(k)] = v;
  return out;
}

function _asRate(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.includes("%")) {
    const n = parseFloat(s.replace("%", ""));
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function _asFloat(v) {
  const n = _toNum(v);
  return Number.isFinite(n) ? n : null;
}

function _readFirst(obj, keys) {
  if (!obj) return null;
  const o = _normalizeRowKeys(obj);
  for (const k of keys) {
    const kk = _normKey(k);
    if (kk in o) return o[kk];
  }
  return null;
}

function computeFeatureValue(teamRec, statId) {
  const def = STAT_REGISTRY[statId];
  if (!def) return { value: null, defaulted: true, source: null };
  const stats = teamRec?.stats || {};
  const raw = teamRec?.raw_dotted || teamRec?.raw_nested || null;

  // Prefer already-normalized flat stat if present
  if (statId in stats && stats[statId] !== null && stats[statId] !== undefined) {
    return { value: stats[statId], defaulted: false, source: "stats."+statId };
  }

  const rawVal = _readFirst(raw, def.sources || []);
  let val = null;
  if (def.type === "rate") val = _asRate(rawVal);
  else val = _asFloat(rawVal);

  if (val === null || val === undefined) {
    return { value: def.default ?? null, defaulted: true, source: null };
  }
  return { value: val, defaulted: false, source: (def.sources || [])[0] || null };
}

function standardizeValue(statId, value) {
  const def = STAT_REGISTRY[statId];
  if (!def) return null;
  const scale = def.scale ?? 1;
  if (value === null || value === undefined) return null;
  return (value / (scale || 1)) * (def.dir ?? 1);
}

async function loadWeights(env, { season, week, name }) {
  const w = week == null || week === "" ? "ALL" : String(week);
  const nm = String(name || "default");
  const key = `weights:nfl:${season}:${w}:${nm}`;
  const hit = await kvGet(env, key);
  if (hit) return { key, ...hit };

  // fallback to ALL
  if (w !== "ALL") {
    const key2 = `weights:nfl:${season}:ALL:${nm}`;
    const hit2 = await kvGet(env, key2);
    if (hit2) return { key: key2, ...hit2 };
  }
  return null;
}

async function saveWeights(env, { season, week, name, weights }) {
  const w = week == null || week === "" ? "ALL" : String(week);
  const nm = String(name || "default");
  const key = `weights:nfl:${season}:${w}:${nm}`;
  const payload = {
    season: Number(season),
    week: w === "ALL" ? null : (Number.isFinite(Number(w)) ? Number(w) : w),
    name: nm,
    updatedAt: new Date().toISOString(),
    weights: weights || {}
  };
  await kvPut(env, key, payload, 365 * 24 * 3600);
  return { key, ...payload };
}


// --- Canonical payload helpers ---
// flatten nested payload objects (teamwell JSON) into dotted keys (teamwell CSV style)
function flattenToDotted(obj, prefix = "", out = {}) {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      flattenToDotted(v, key, out);
    } else {
      out[key] = v;
    }
  }
  return out;
}

// convert dotted-key row back into nested canonical shape
function undotToNested(row = {}) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (!k.includes(".")) continue;
    const parts = k.split(".");
    let cur = out;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (i === parts.length - 1) cur[p] = v;
      else cur = (cur[p] ||= {});
    }
  }
  return out;
}

// Detect & aggregate Sumer "long" CSV into team stats
function buildSumerTeamStats(rows, seasonDefault, weekDefault) {
  const teams = {};

  for (const row of rows) {
    const team = toTeamAbbr(row.team_abbr || row.team || row.TEAM || row.Team);
    if (!team) continue;

    const section = String(row.section || "").toLowerCase();
    const bucket  = String(row.bucket || "").toLowerCase();
    const metric  = String(row.metric || "").toLowerCase();
    const value   = Number(row.value);
    if (!Number.isFinite(value)) continue;

    const bag = (teams[team] ||= {
      season: Number(row.season || seasonDefault),
      week: row.week || weekDefault || null,
      offense: {},
      defense: {}
    });

    const tgt =
      section === "offense" ? bag.offense :
      section === "defense" ? bag.defense :
      null;
    if (!tgt) continue;

    const isOverview = bucket === "overview";

    if (isOverview) {
      // Accept multiple naming conventions from Sumer exports
      if (metric === "total_epa" || metric === "off_epa" || metric === "def_epa") {
        tgt.total_epa = value;
      } else if (metric === "epa" || metric === "epa_play" || metric === "epa_per_play") {
        // Some Sumer extracts label overview EPA this way
        tgt.total_epa = value;
      } else if (metric === "epa_pass") {
        tgt.epa_pass = value;
      } else if (metric === "epa_rush") {
        tgt.epa_rush = value;
      } else if (metric === "success_rate") {
        tgt.success_rate = value;
      } else if (metric === "explosive") {
        tgt.explosive = value;
      } else if (metric === "sack") {
        tgt.sack = value;
      }
    }


    if (section === "offense" && (bucket === "personnel" || bucket === "formations")) {
      const key = `grp:${bucket}:${row.player_name || ""}`;
      const groups = (tgt.groups ||= {});
      const grp = (groups[key] ||= { weight: 0, pass_rate: null, epa: null });

      if (metric === "rate") grp.weight = value;
      else if (metric === "pass_rate") grp.pass_rate = value;
      else if (metric === "epa") grp.epa = value;
    }
  }

  const out = [];
  for (const [team, bag] of Object.entries(teams)) {
    const season = bag.season || Number(seasonDefault);
    const week   = bag.week ?? weekDefault ?? null;
    const off    = bag.offense || {};
    const def    = bag.defense || {};

    let pass_rate = null;
    let off_epa_play = null;
    
    if (off.groups) {
      const w = safeWeightedFromGroups(
        off.groups,
        { pass_rate: 0.58, epa: off.total_epa ?? 0 }
      );
    
      pass_rate = w.pass_rate;
      off_epa_play = w.off_epa_play;
    }


    if (pass_rate == null) pass_rate = 0.58;

    if (off_epa_play == null) {
      // Priority 1: Sumer overview EPA if present
      if (off.total_epa != null) {
        off_epa_play = off.total_epa;
      }
      // Priority 2: derive from pass/rush splits
      else if (off.epa_pass != null || off.epa_rush != null) {
        const epaPass = off.epa_pass ?? 0;
        const epaRush = off.epa_rush ?? 0;
        off_epa_play = pass_rate * epaPass + (1 - pass_rate) * epaRush;
      }
      else {
        off_epa_play = 0;
      }
    }


    let def_epa_play;
    if (def.epa_pass != null || def.epa_rush != null) {
      const defEpaPass = def.epa_pass ?? 0;
      const defEpaRush = def.epa_rush ?? 0;
      def_epa_play = 0.6 * defEpaPass + 0.4 * defEpaRush;
    } else {
      def_epa_play = 0;
    }

    const def_success         = def.success_rate ?? 0.45;
    const pressure_rate       = def.sack ?? 0.30;
    const sack_rate_allowed   = off.sack ?? 0.06;
    const explosive_play_rate = off.explosive ?? 0.12;

    const stats = normalizeTeamStats({
      pace_plays60: 62,
      pass_rate,
      off_epa_play,
      def_epa_play,
      redzone_td_rate_off: undefined,
      redzone_td_rate_def: undefined,
      pressure_rate,
      def_success,
      sack_rate_allowed,
      explosive_play_rate
    });
      if (stats && stats.raw_nested && stats.raw_nested.splits && !stats.splits) stats.splits = stats.raw_nested.splits;

    out.push({ season, week, team, stats });
  }

  return out;
}

// Normalize stats into Brain shape
function normalizeTeamStats(stats = {}) {
  // Wide CSV with dotted headers (pace.xxx, efficiency.xxx, splits.xxx...)
  if (stats && typeof stats === 'object') {
    const ks = Object.keys(stats);
    if (ks.some(k => k.includes('.'))) {
      const raw_nested = {};
      const raw_dotted = {};
      for (const [dk, dv0] of Object.entries(stats)) {
        const dv = (dv0 === '' ? null : dv0);
        raw_dotted[dk] = dv;
        _setDeep(raw_nested, dk.split('.'), dv);
      }
      const out = raw_nested;
      out.raw_dotted = raw_dotted;
      out.raw_nested = raw_nested;
      if (raw_nested.splits && !out.splits) out.splits = raw_nested.splits;
      return out;
    }
  }

  const s = stats || {};

  // Robust getter: supports nested objects AND dotted keys (e.g. "pace.plays_per_game_off")
  const g = (path) => {
    if (!s) return undefined;
    if (Object.prototype.hasOwnProperty.call(s, path)) return s[path];
    const parts = String(path).split('.');
    let cur = s;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  };


  const defaults_used = [];
  const markDefault = (k, v) => { defaults_used.push(k); return v; };


  const pace_plays60 = num(
    // Prefer OFF plays per game (this is what your UI expects as "pace_plays60")
    s.pace_plays60 ??
    g('pace.plays_per_game_off') ??
    g('pace.plays_per_game') ??
    g('pace.plays_60') ??
    g('pace.pace_plays60') ??
    g('pace.pace.plays_per_game_off') ??
    s.pace ??
    s.plays_per_60 ??
    s.plays_60 ??
    62
  );

  let pass_rate = num(
    s.pass_rate ??
    s.pass_pct ??
    s.pass_rate_early ??
    s.pass_rate_neutral ??
    g('tendencies.pass_rate_off') ??
    g('tendencies.pass_rate') ??
    g('splits.early_down.off.pass_rate') ??
    (s.tendencies && (s.tendencies.pass_rate_off ?? s.tendencies.pass_rate ?? s.tendencies.pass_pct)) ??
    0.58
  );
  // percent -> decimal safety
  if (pass_rate > 1) pass_rate = pass_rate / 100;
  pass_rate = clamp(pass_rate, 0.30, 0.80);

  let off_epa_play = num(
    s.off_epa_play ??
    s.epa_off ??
    s.epa ??
    (s.efficiency && (s.efficiency.off_epa_play ?? s.efficiency.epa_off ?? s.efficiency.epa_play)) ??
    undefined
  , undefined
  );
  let def_epa_play = num(
    s.def_epa_play ??
    s.epa_def ??
    (s.efficiency && (s.efficiency.def_epa_play ?? s.efficiency.epa_def ?? s.efficiency.epa_play_def)) ??
    undefined
  , undefined
  );

  let redzone_td_rate_off = num(
    s.redzone_td_rate_off ??
    s.rz_td_rate_off ??
    s.rz_off ??
    s.rz_off_td_rate ??
    g('redzone.redzone_td_rate_off') ??
    g('redzone.td_rate_off') ??
    g('splits.red_zone.off.td_rate') ??
    (s.redzone && (s.redzone.redzone_td_rate_off ?? s.redzone.td_rate_off ?? s.redzone.td_rate)) ??
    0.55
  );
  let redzone_td_rate_def = num(
    s.redzone_td_rate_def ??
    s.rz_td_rate_def ??
    s.rz_def ??
    s.rz_def_td_rate ??
    g('redzone.redzone_td_rate_def') ??
    g('redzone.td_rate_def') ??
    g('splits.red_zone.def.td_rate_allowed') ??
    (s.redzone && (s.redzone.redzone_td_rate_def ?? s.redzone.td_rate_def ?? s.redzone.td_rate_allowed)) ??
    0.55
  );
  if (redzone_td_rate_off > 1) redzone_td_rate_off /= 100;
  if (redzone_td_rate_def > 1) redzone_td_rate_def /= 100;
  redzone_td_rate_off = clamp(redzone_td_rate_off, 0.2, 0.8);
  redzone_td_rate_def = clamp(redzone_td_rate_def, 0.2, 0.8);

  // --- pressure ---
  let pressure_rate = num(
    s.pressure_rate ??
    s.pressure_rate_def ??
    s.press_rate ??
    s.def_pressure_rate ??
    g('pass.pressure_rate_def') ??
    g('pass.pressure_rate_allowed_off') ??
    0.30
  );
  // percent -> decimal
  if (pressure_rate > 1) pressure_rate = pressure_rate / 100;

  // if this looks like sack-rate, scale into pressure-ish band
  if (pressure_rate > 0 && pressure_rate < 0.12) {
    pressure_rate = clamp(pressure_rate * 4.5, 0.18, 0.40);
  } else {
    pressure_rate = clamp(pressure_rate, 0.18, 0.45);
  }

  // --- efficiency + discipline additions ---
  let yards_per_play = num(s.yards_per_play ?? s.ypp ?? g('efficiency.yards_per_play_off') ?? g('efficiency.ypp_off') ?? 5.3);
  if (yards_per_play > 20) yards_per_play = yards_per_play / 10;
  yards_per_play = clamp(yards_per_play, 4.0, 7.5);

  let points_per_drive = num(s.points_per_drive ?? s.ppd ?? g('efficiency.points_per_drive_off') ?? g('efficiency.ppd_off') ?? 2.0);
  if (points_per_drive > 10) points_per_drive = points_per_drive / 10;
  points_per_drive = clamp(points_per_drive, 1.0, 4.0);

  let down_conversion_rate = num(
    s.down_conversion_rate ??
    s.down_conv_rate ??
    s.dcr ??
    g('conversion.third_down_conv_rate_off') ??
    g('conversion.down_conversion_rate_off') ??
    0.75
  );
  if (down_conversion_rate > 1) down_conversion_rate = down_conversion_rate / 100;
  down_conversion_rate = clamp(down_conversion_rate, 0.25, 0.70);

  // --- turnovers & penalties (prefer source columns; only default if truly missing) ---
  let takeaways_per_game = num(
    s.takeaways_per_game ??
    s.takeaways_pg ??
    g('turnovers.takeaways_per_game') ??
    g('turnovers.takeaways_pg') ??
    NaN
  );
  if (!Number.isFinite(takeaways_per_game)) takeaways_per_game = markDefault('takeaways_per_game', 1.3);
  takeaways_per_game = clamp(takeaways_per_game, 0.0, 3.0);

  let giveaways_per_game = num(
    s.giveaways_per_game ??
    s.giveaways_pg ??
    g('turnovers.giveaways_per_game') ??
    g('turnovers.giveaways_pg') ??
    NaN
  );
  if (!Number.isFinite(giveaways_per_game)) giveaways_per_game = markDefault('giveaways_per_game', 1.3);
  giveaways_per_game = clamp(giveaways_per_game, 0.0, 3.0);

  let penalties_per_game = num(
    s.penalties_per_game ??
    s.pen_pg ??
    g('penalties.penalties_per_game') ??
    g('penalties.per_game') ??
    NaN
  );
  if (!Number.isFinite(penalties_per_game)) penalties_per_game = markDefault('penalties_per_game', 6.5);
  penalties_per_game = clamp(penalties_per_game, 0.0, 12.0);

  // --- defensive success rate ---
  let def_success_raw = num(
    s.def_success_raw ??
    s.def_success ??
    s.def_success_rate ??
    g('efficiency.def_success') ??
    g('efficiency.def_success_rate') ??
    g('def_success') ??
    g('def_success_rate') ??
    NaN
  );
let def_success = num(def_success_raw, NaN);
  if (!Number.isFinite(def_success)) def_success = markDefault('def_success', 0.45);
  if (def_success > 1) def_success = def_success / 100;
  def_success = clamp(def_success, 0.25, 0.55);

  // --- sack rate allowed ---
  let sack_rate_allowed_raw =
    s.sack_rate_allowed ??
    s.sack_rate ??
    s.off_sack_rate ??
    g('pass.sack_rate_taken_off') ??
    g('pass.sack_rate_allowed_off') ??
    g('trench.sack_rate_allowed') ??
    undefined;

  let sack_rate_allowed = num(sack_rate_allowed_raw, NaN);
  if (!Number.isFinite(sack_rate_allowed)) sack_rate_allowed = markDefault('sack_rate_allowed', 0.06);
  if (sack_rate_allowed > 1) sack_rate_allowed = sack_rate_allowed / 100;
  sack_rate_allowed = clamp(sack_rate_allowed, 0.02, 0.12);

  // --- explosives ---
  // Prefer explicit explosive rates if present, then fall back to aggregate efficiency.
  const _expl_pass = num(
    g('explosives.explosive_pass_rate_off') ??
    g('explosives.explosive_pass_rate') ??
    s.explosive_pass_rate ??
    NaN
  , NaN);
  const _expl_rush = num(
    g('explosives.explosive_rush_rate_off') ??
    g('explosives.explosive_rush_rate') ??
    s.explosive_rush_rate ??
    NaN
  , NaN);

  let explosive_play_rate_raw = undefined;
  if (Number.isFinite(_expl_pass) || Number.isFinite(_expl_rush)) {
    const p = clamp(num(pass_rate, 0.55), 0, 1);
    const ep = Number.isFinite(_expl_pass) ? _expl_pass : _expl_rush;
    const er = Number.isFinite(_expl_rush) ? _expl_rush : _expl_pass;
    explosive_play_rate_raw = p * ep + (1 - p) * er;
  } else {
    explosive_play_rate_raw =
      s.explosive_play_rate ??
      s.explosive_rate ??
      s.xpl_rate ??
      g('explosives.explosive_efficiency_off') ??
      g('explosives.explosive_play_rate_off') ??
      g('explosives.explosive_rate_off') ??
      g('offense.explosive_play_rate') ??
      undefined;
  }

  let explosive_play_rate = num(explosive_play_rate_raw, NaN);
  if (!Number.isFinite(explosive_play_rate)) explosive_play_rate = markDefault('explosive_play_rate', 0.12);
  if (explosive_play_rate > 1) explosive_play_rate = explosive_play_rate / 100;
  explosive_play_rate = clamp(explosive_play_rate, 0.02, 0.30);

  const recent = (s.recent_form && typeof s.recent_form === 'object') ? s.recent_form
    : (s.recent && typeof s.recent === 'object') ? s.recent : {};
  const injuries = s.injuries_summary || s.injuries || null;
  const extras = s.extras || {};
  // Track which fields were default-imputed (helps diagnose 'swirl')
  extras.defaults_used = defaults_used;


  const points_for_pg     = num(recent.points_for_per_game, NaN);
  const points_against_pg = num(recent.points_against_per_game, NaN);
  const plays_pg          = num(recent.plays_per_game, NaN);

  const recent_margin =
    Number.isFinite(points_for_pg) && Number.isFinite(points_against_pg)
      ? points_for_pg - points_against_pg
      : 0;

  if (recent_margin !== 0) {
    const adj = clamp(recent_margin / 40, -0.15, 0.15);
    off_epa_play += adj * 0.30;
    def_epa_play -= adj * 0.20;
  }

  let _pace_recent = null;
  if (Number.isFinite(plays_pg)) {
    const paceAdj = clamp((plays_pg - 62) / 50, -0.10, 0.10);
    const newPace = pace_plays60 * (1 + paceAdj);
    _pace_recent = pace_plays60 * 0.67 + newPace * 0.33;
  }

  let injury_penalty = 0;
  if (injuries && typeof injuries.total === "number") {
    const t = injuries.total;
    injury_penalty = clamp(t / 12, 0, 0.20);
    off_epa_play -= injury_penalty * 0.40;
    def_epa_play += injury_penalty * 0.20;
  }

  
  // inj_total: prefer injuries.total if provided, else fall back to common fields
  const inj_total = (() => {
    const t1 = Number(injuries && typeof injuries === "object" ? injuries.total : NaN);
    if (Number.isFinite(t1)) return t1;
    const t2 = Number(s.inj_total ?? s.injury_total ?? s.injury_penalty ?? NaN);
    if (Number.isFinite(t2)) return t2;
    // If we only have penalty scalar, approximate back to a 0-12ish "total"
    if (Number.isFinite(injury_penalty) && injury_penalty > 0) return Math.round(injury_penalty * 12);
    return 0;
  })();

return {
    pace_plays60: _pace_recent || pace_plays60,
    pass_rate,
    off_epa_play,
    def_epa_play,
    yards_per_play,
    points_per_drive,
    down_conversion_rate,
    takeaways_per_game,
    giveaways_per_game,
    penalties_per_game,
    redzone_td_rate_off,
    redzone_td_rate_def,
    pressure_rate,
    def_success,
    sack_rate_allowed,
    explosive_play_rate,
    inj_total,
    recent_form: recent,
    injuries_summary: injuries,
    _injury_penalty: injury_penalty,
    extras
  };
}


// --- Modifiers (split-driven) application for matchup sims ---
// These are "safe": if split data is missing, we fall back to core.
// Supported split keys (expected under teamRaw.splits.*): non_garbage_time, early_down, late_down, red_zone

function _getIn(obj, path) {
  if (!obj || !path) return undefined;
  const parts = String(path).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && (p in cur)) cur = cur[p];
    else return undefined;
  }
  return cur;
}

function _isFiniteNumber(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function _collectEnabledSplits(modifiers) {
  if (!modifiers || modifiers.enabled !== true) return [];
  const splits = [];
  if (modifiers.use_non_garbage) splits.push("non_garbage_time");
  if (modifiers.use_early_down) splits.push("early_down");
  if (modifiers.use_late_down) splits.push("late_down");
  if (modifiers.use_red_zone) splits.push("red_zone");
  return splits;
}

function _avgNorm(norms) {
  if (!norms || norms.length === 0) return null;
  const out = {};
  const counts = {};
  for (const n of norms) {
    if (!n) continue;
    for (const [k, v] of Object.entries(n)) {
      // ignore non-numeric complex objects
      if (k === "recent_form" || k === "injuries_summary" || k === "extras") continue;
      if (_isFiniteNumber(v)) {
        out[k] = (out[k] ?? 0) + v;
        counts[k] = (counts[k] ?? 0) + 1;
      }
    }
  }
  for (const k of Object.keys(out)) {
    out[k] = out[k] / (counts[k] || 1);
  }
  return out;
}

function _blendNorm(coreNorm, modsNorm, pureW, modsW, mode) {
  if (!coreNorm) return coreNorm;
  if (!modsNorm) return coreNorm;

  const pw = _isFiniteNumber(pureW) ? pureW : 0.7;
  const mw = _isFiniteNumber(modsW) ? modsW : 0.3;
  const denom = (pw + mw) || 1;
  const a = pw / denom;
  const b = mw / denom;

  // mode: "dual" (core+mods), "mod_only" (mods), "pure" (core)
  const out = { ...coreNorm };
  for (const [k, coreV] of Object.entries(coreNorm)) {
    if (!_isFiniteNumber(coreV)) continue;
    const modV = modsNorm[k];
    if (!_isFiniteNumber(modV)) continue;
    if (mode === "mod_only") out[k] = modV;
    else if (mode === "dual") out[k] = (a * coreV) + (b * modV);
    // pure => unchanged
  }
  return out;
}


function _flattenSplitRaw(splitRaw, baseTeamRaw) {
  // Sumer worker emits splits like { off:{...}, def:{...} }.
  // Brain normalizer expects flat keys: off_epa_play, def_epa_play, yards_per_play, points_per_drive, pass_rate, redzone_td_rate_off/def, def_success, pressure_rate, sack_rate_allowed, explosive_play_rate.
  if (!splitRaw || typeof splitRaw !== "object") return null;

  const off = splitRaw.off || splitRaw.offense || null;
  const def = splitRaw.def || splitRaw.defense || null;

  // If already flat, just return as-is
  const looksFlat =
    splitRaw.off_epa_play != null ||
    splitRaw.def_epa_play != null ||
    splitRaw.yards_per_play != null ||
    splitRaw.points_per_drive != null;

  if (looksFlat) return { ...splitRaw };

  const flat = {};

  // Keep pace / context from base (splits are situational efficiency, not tempo)
  if (baseTeamRaw && typeof baseTeamRaw === "object") {
    if (baseTeamRaw.pace_plays60 != null) flat.pace_plays60 = baseTeamRaw.pace_plays60;
    if (baseTeamRaw.takeaways_per_game != null) flat.takeaways_per_game = baseTeamRaw.takeaways_per_game;
    if (baseTeamRaw.giveaways_per_game != null) flat.giveaways_per_game = baseTeamRaw.giveaways_per_game;
    if (baseTeamRaw.penalties_per_game != null) flat.penalties_per_game = baseTeamRaw.penalties_per_game;
    if (baseTeamRaw.pressure_rate != null) flat.pressure_rate = baseTeamRaw.pressure_rate;
    if (baseTeamRaw.sack_rate_allowed != null) flat.sack_rate_allowed = baseTeamRaw.sack_rate_allowed;
    if (baseTeamRaw.explosive_play_rate != null) flat.explosive_play_rate = baseTeamRaw.explosive_play_rate;
    if (baseTeamRaw.down_conversion_rate != null) flat.down_conversion_rate = baseTeamRaw.down_conversion_rate;
  }

  // Offense mappings (tolerant keys)
  if (off && typeof off === "object") {
    flat.pass_rate = _getIn(off, "pass_rate") ?? _getIn(off, "passRate") ?? _getIn(off, "tendencies.pass_rate") ?? flat.pass_rate;
    flat.off_epa_play = _getIn(off, "epa_play") ?? _getIn(off, "off_epa_play") ?? _getIn(off, "epaPerPlay") ?? flat.off_epa_play;
    flat.yards_per_play = _getIn(off, "yards_per_play") ?? _getIn(off, "ypp") ?? _getIn(off, "off_ypp") ?? flat.yards_per_play;
    flat.points_per_drive = _getIn(off, "points_per_drive") ?? _getIn(off, "ppd") ?? _getIn(off, "off_ppd") ?? flat.points_per_drive;
    flat.redzone_td_rate_off =
      _getIn(off, "redzone_td_rate") ??
      _getIn(off, "redzone_td_rate_off") ??
      _getIn(off, "red_zone.td_rate") ??
      flat.redzone_td_rate_off;
    // "success" often comes as success_rate
    flat.off_success =
      _getIn(off, "success_rate") ??
      _getIn(off, "off_success") ??
      _getIn(off, "success") ??
      flat.off_success;
  }

  // Defense mappings (tolerant keys)
  if (def && typeof def === "object") {
    flat.def_epa_play = _getIn(def, "epa_play") ?? _getIn(def, "def_epa_play") ?? _getIn(def, "epaPerPlay") ?? flat.def_epa_play;
    flat.yards_per_play_def = _getIn(def, "yards_per_play") ?? _getIn(def, "ypp") ?? _getIn(def, "def_ypp") ?? flat.yards_per_play_def;
    flat.points_per_drive_def = _getIn(def, "points_per_drive") ?? _getIn(def, "ppd") ?? _getIn(def, "def_ppd") ?? flat.points_per_drive_def;
    flat.redzone_td_rate_def =
      _getIn(def, "redzone_td_rate") ??
      _getIn(def, "redzone_td_rate_def") ??
      _getIn(def, "red_zone.td_rate_allowed") ??
      flat.redzone_td_rate_def;
    // Defense success / stop rate
    flat.def_success =
      _getIn(def, "success_rate") ??
      _getIn(def, "def_success") ??
      _getIn(def, "success_allowed") ??
      flat.def_success;
    flat.third_down_def_allowed =
      _getIn(def, "third_down_def_allowed") ??
      _getIn(def, "third_down_allowed") ??
      flat.third_down_def_allowed;
  }

  return flat;
}

function applySplitModifiersToTeamRaw(teamRaw, modifiers) {
  const splits = _collectEnabledSplits(modifiers);
  const mode = (modifiers && modifiers.blend_mode) ? String(modifiers.blend_mode) : "dual";

  // Splits may be persisted directly, or may live under raw_nested / raw_dotted.
  const teamSplits = (() => {
    if (teamRaw && teamRaw.splits && typeof teamRaw.splits === "object") return teamRaw.splits;
    if (teamRaw && teamRaw.raw_nested && typeof teamRaw.raw_nested === "object" && teamRaw.raw_nested.splits && typeof teamRaw.raw_nested.splits === "object") {
      return teamRaw.raw_nested.splits;
    }
    if (teamRaw && teamRaw.raw_dotted && typeof teamRaw.raw_dotted === "object") {
      const nested = undotToNested(teamRaw.raw_dotted);
      if (nested && typeof nested === "object" && nested.splits && typeof nested.splits === "object") return nested.splits;
    }
    return null;
  })();

  const available_splits = (teamSplits && typeof teamSplits === "object") ? Object.keys(teamSplits) : [];

  const probe = (teamRaw && teamRaw.splits && typeof teamRaw.splits === "object")
    ? teamRaw
    : { ...(teamRaw || {}), splits: (teamSplits || undefined) };

  // If modifiers disabled or pure-only -> no change, just echo
  if (!modifiers || modifiers.enabled !== true || mode === "pure") {
    return { teamRaw, applied: false, used_splits: [], available_splits, reason: "modifiers_disabled_or_pure" };
  }

  // Build core + mods norms
  const coreNorm = normalizeTeamStats(teamRaw);
  const splitNorms = [];
  const used = [];

  for (const s of splits) {
    const splitRaw =
      _getIn(probe, `splits.${s}`) ??
      _getIn(probe, `split.${s}`) ??
      _getIn(probe, `splits_${s}`) ??
      null;

    if (splitRaw && typeof splitRaw === "object") {
      const flat = _flattenSplitRaw(splitRaw, teamRaw);
      const n = normalizeTeamStats(flat);
      if (n) {
        splitNorms.push(n);
        used.push(s);
      }
    }
  }

  if (!splitNorms.length) {
    return {
      teamRaw,
      applied: false,
      used_splits: [],
      available_splits,
      reason: available_splits.length ? "no_enabled_splits_found" : "no_splits_present_on_teamRaw"
    };
  }

  const modsNorm = _avgNorm(splitNorms);
  if (!modsNorm) {
    // requested but no data available
    return { teamRaw, applied: false, used_splits: [], available_splits, reason: "failed_to_average_splits" };
  }

  const blended = _blendNorm(coreNorm, modsNorm, modifiers.pure_weight, modifiers.mods_weight, mode);

  // Overlay blended values onto raw so downstream normalizeTeamStats() will pick them up.
  // We only overlay the canonical numeric keys we know the model reads directly.
  const overlay = {
    pace_plays60: blended.pace_plays60,
    pass_rate: blended.pass_rate,
    off_epa_play: blended.off_epa_play,
    def_epa_play: blended.def_epa_play,
    yards_per_play: blended.yards_per_play,
    points_per_drive: blended.points_per_drive,
    down_conversion_rate: blended.down_conversion_rate,
    takeaways_per_game: blended.takeaways_per_game,
    giveaways_per_game: blended.giveaways_per_game,
    penalties_per_game: blended.penalties_per_game,
    redzone_td_rate_off: blended.redzone_td_rate_off,
    redzone_td_rate_def: blended.redzone_td_rate_def,
    pressure_rate: blended.pressure_rate,
    def_success: blended.def_success,
    sack_rate_allowed: blended.sack_rate_allowed,
    explosive_play_rate: blended.explosive_play_rate
  };

  // remove undefined so we don't override legit sources with undefined
  for (const k of Object.keys(overlay)) {
    if (!_isFiniteNumber(overlay[k])) delete overlay[k];
  }

  return {
    teamRaw: { ...teamRaw, ...overlay },
    applied: true,
    used_splits: used,
    available_splits,
    reason: used.length ? null : "no_splits_used"
  };
}

function detectDefaultLike(stats) {
  if (!stats) return [];

  const eps = 1e-6;

  // Baselines for "looks like default" checks
  const baselines = {
    yards_per_play:      5.3000,
    points_per_drive:    2.0000,
    down_conversion_rate: 0.75000,
    takeaways_per_game:  1.3000,
    giveaways_per_game:  1.3000,
    penalties_per_game:  6.5000
  };

  const hits = [];
  for (const [k, base] of Object.entries(baselines)) {
    const v = Number(stats[k]);
    if (!Number.isFinite(v)) continue;
    if (Math.abs(v - base) <= eps) hits.push(k);
  }

  return hits;
}

function computeQualityTier(missingHome = [], missingAway = []) {
  const n = (missingHome?.length || 0) + (missingAway?.length || 0);
  if (n <= 2) return "high";
  if (n <= 6) return "medium";
  return "low";
}

function validateEliteTeamStats(stats) {
  const missing_core = [];

  const req = [
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
  ];

  for (const k of req) {
    const v = stats?.[k];
    if (v == null || !Number.isFinite(Number(v))) missing_core.push(k);
  }

  return { missing_core, missing_patch: [] };
}

// Map simple 1-row-per-team CSV into normalized stats payload
function normalizeTeamCsvRow(row) {
  // Generic dot-path CSV row normalizer.
  // Returns: { team, stats, meta }
  // - `stats` is a nested object created from dot-path headers (e.g. pace.pace_plays60)
  // - preserves split keys under stats.splits (e.g. splits.early_down.*)
  // This shape is what /teams/ingest and /teams/upload expect.
  if (!row || typeof row !== "object") return null;

  const rawTeam =
    row.team || row.Team || row.TEAM || row.abbr || row.ABBR || row.team_abbr || row.TeamAbbr;
  const team = toTeamAbbr(rawTeam);
  if (!team) return null;

  const stats = {};
  const raw_dotted = {};
  const setPath = (obj, path, value) => {
    const parts = String(path).split(".");
    raw_dotted[String(path)] = value;
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
      const k = parts[i];
      if (!k) continue;
      if (i === parts.length - 1) {
        cur[k] = value;
      } else {
        if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
        cur = cur[k];
      }
    }
  };

  const maybeNum = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const s = String(v).trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const meta = {};
  const splitKeys = [];

  for (const [k0, v0] of Object.entries(row)) {
    const k = String(k0 || "").trim();
    if (!k) continue;
    const low = k.toLowerCase();

    // team identity fields
    if (low === "team" || low === "abbr" || low === "team_abbr" || low === "teamabbr") continue;

    // keep season/week if present
    if (low === "season" || low === "week") {
      meta[low] = v0;
      continue;
    }

    // Split fields: "splits.early_down.off_epa_play" OR "early_down.off_epa_play"
    if (low.startsWith("splits.")) {
      const rest = k.substring("splits.".length);
      setPath(stats, `splits.${rest}`, maybeNum(v0) ?? v0);
      const top = rest.split(".")[0];
      if (top && !splitKeys.includes(top)) splitKeys.push(top);
      continue;
    }
    if (["early_down.", "late_down.", "red_zone.", "non_garbage.", "nongarbage."].some(p => low.startsWith(p))) {
      // promote to splits.<name>.*
      const seg = k.split(".");
      const group = seg[0].toLowerCase() === "nongarbage" ? "non_garbage" : seg[0];
      const rest = seg.slice(1).join(".");
      setPath(stats, `splits.${group}.${rest}`, maybeNum(v0) ?? v0);
      if (group && !splitKeys.includes(group)) splitKeys.push(group);
      continue;
    }

    // Default: dot-path goes into stats
    const valNum = maybeNum(v0);
    setPath(stats, k, valNum ?? v0);
  }

  if (splitKeys.length) meta.split_keys = splitKeys;
  meta.raw_dotted = raw_dotted;
  meta.raw_nested = undotToNested(raw_dotted);
  return { team, stats, meta };
}

// ========= Matchup engine (elite) =========
function trenchSignal(home, away) {
  const h_pr  = num(home.pressure_rate, 0.30);
  const a_pr  = num(away.pressure_rate, 0.30);
  const h_sra = num(home.sack_rate_allowed, 0.06);
  const a_sra = num(away.sack_rate_allowed, 0.06);
  const h_xpl = num(home.explosive_play_rate, 0.12);
  const a_xpl = num(away.explosive_play_rate, 0.12);

  const trench_home =
    (h_pr - a_sra) * 6 +
    (h_xpl - a_xpl) * 8;

  const trench_away =
    (a_pr - h_sra) * 6 +
    (a_xpl - h_xpl) * 8;

  let pts_home = clamp(trench_home, -3, 3);
  let pts_away = clamp(trench_away, -3, 3);

  // Sack stress: amplify trench when opponent OL sack rate allowed is high
  const a_stress = clamp01((a_sra - 0.06) / 0.06);
  const h_stress = clamp01((h_sra - 0.06) / 0.06);
  pts_home *= (1 + 0.75 * a_stress);
  pts_away *= (1 + 0.75 * h_stress);

  const net = pts_home - pts_away;
  pts_home = clamp(net, -3, 3);
  pts_away = -pts_home;

  return { pts_home, pts_away, net_trench: net };
}

function computeContextSignal(home, away, cal) {
  // Injuries: already baked into base points via _injury_penalty in team stats.
  // Keep explicit context fields for debugging/UI (do NOT double-count).
  const home_inj_load = num(home._injury_penalty, 0);
  const away_inj_load = num(away._injury_penalty, 0);

  // ---- Turnovers (conservative) ----
  const h_take = num(home.takeaways_per_game, 1.3);
  const a_take = num(away.takeaways_per_game, 1.3);
  const h_give = num(home.giveaways_per_game, 1.2);
  const a_give = num(away.giveaways_per_game, 1.2);

  // Base turnover edges (home advantage if positive)
  const edge_vs_opp = h_take - a_give;
  const edge_net = (h_take - h_give) - (a_take - a_give);

  // Soft caps (avoid huge swings)
  const te_vs_opp = clamp(edge_vs_opp, -0.9, 0.9);
  const te_net = clamp(edge_net, -1.2, 1.2);

  // Conservative blend (regress-to-mean)
  const blended_turnover_edge = 0.55 * te_net + 0.45 * te_vs_opp;

  // QB risk interaction (pressure + sack-allowed -> slightly worse TO outlook)
  const h_pr_def = num(home.pressure_rate, 0.28);
  const a_pr_def = num(away.pressure_rate, 0.28);
  const h_sack_allowed = num(home.sack_rate_allowed, 0.06);
  const a_sack_allowed = num(away.sack_rate_allowed, 0.06);

  const risk_home = 0.15 *
    clamp((a_pr_def - 0.28) / 0.08, -1, 1) *
    clamp((h_sack_allowed - 0.06) / 0.03, -1, 1);

  const risk_away = 0.15 *
    clamp((h_pr_def - 0.28) / 0.08, -1, 1) *
    clamp((a_sack_allowed - 0.06) / 0.03, -1, 1);

  const adj_turnover_edge = blended_turnover_edge + (risk_away - risk_home);

  // Soft non-linear squish (keeps edge "real", avoids runaway)
  const soft_turnover_edge = 1.25 * Math.tanh(adj_turnover_edge / 1.25);

  // Reliability shrink (TO rates are noisy)
  const has_to_inputs = [h_take, a_take, h_give, a_give].every((v) => Number.isFinite(v));
  const rel = has_to_inputs ? 0.85 : 0.60;
  const final_turnover_edge = rel * soft_turnover_edge;

  // Convert to points (smaller weight + smaller cap)
  // Weight turnovers conservatively (they’re noisy week-to-week)
  // Use cal.w_turnovers as a hint, but dampen + cap hard so it can’t swing the game by itself.
  const raw_to_w = num(cal.w_turnovers, 4.0);
  const TURNOVER_WEIGHT = clamp(0.6 * raw_to_w, 0.8, 2.8);
  const turnover_pts = clamp(0.5 * TURNOVER_WEIGHT * final_turnover_edge, -0.8, 0.8);

  // For debug/UI
  const turnover_edge_style = clamp(final_turnover_edge / 1.25, -1, 1);

  // If you later ingest "real" turnover margin/turnovers per game, wire it here.
  const real_turnover_edge = null;

  const injury_diff = home_inj_load - away_inj_load;
  const injury_pts = 0;

  return {
    turnover_edge_style,
    edge_vs_opp,
    edge_net,
    blended_turnover_edge,
    real_turnover_edge,
    final_turnover_edge,
    turnover_pts,
    home_inj_load,
    away_inj_load,
    injury_diff,
    injury_pts,
    pts_home: turnover_pts + injury_pts,
    pts_away: -turnover_pts - injury_pts
  };
}


function baseExpectedPoints(team, opp, cal) {
  // Pace: average of both teams vs 62 baseline
  const paceTeam = num(team.pace_plays60, 62);
  const paceOpp  = num(opp.pace_plays60, 62);
  const paceFactor = ((paceTeam + paceOpp) / 2) / 62;

  // Opponent blending: combine offense EPA with opponent defensive EPA.
  // IMPORTANT: In our data, def_epa_play is the EPA *allowed* by the defense.
  // So a strong defense is typically negative, and should REDUCE expected points.
  // That means we ADD (off_epa_play + opp.def_epa_play), not subtract.
  const epaBlend = num(team.off_epa_play, 0) + num(opp.def_epa_play, 0);

  // Red zone offense vs league avg, and vs opp RZ defense
  const rzOff = num(team.redzone_td_rate_off, 0.55);
  const rzDefOpp = num(opp.redzone_td_rate_def, 0.55);

  const rzOffDiff = rzOff - 0.55;        // offense vs average
  const rzDefEdge = 0.55 - rzDefOpp;     // how soft/tight opp is in RZ

  // --- Elite micro-signals (light weights, no double counting) ---

  // Yards per play vs ~5.3 baseline
  const ypp = num(team.yards_per_play, 5.3);
  const yppDiff = ypp - 5.3;

  // Points per drive vs ~2.0 baseline
  const ppd = num(team.points_per_drive, 2.0);
  const ppdDiff = ppd - 2.0;

  // Down conversion rate (3rd/4th) vs ~0.75 baseline (decimal)
  const dcr = num(team.down_conversion_rate, 0.75);
  const dcrDiff = dcr - 0.75;

  // Penalties per game vs ~6.5 baseline (negative impact)
  const pens = num(team.penalties_per_game, 6.5);
  const pensDiff = pens - 6.5;

  // Plays60 “true” tilt beyond simple pace factor
  const playsDiff = paceTeam - 62;

  let pts = 21;

  // Core: EPA + RZ still drive most of the signal
  pts += epaBlend * cal.w_epa;
  pts += (rzOffDiff + rzDefEdge) * (cal.w_redzone / 2);

  // Pass rate tendency (kept small)
  const passRate = num(team.pass_rate, 0.58);
  pts += (passRate - 0.58) * (cal.w_ypp * 0.5);

  // Micro: YPP / PPD / DCR
  pts += yppDiff * (cal.w_ypp * 0.25);      // 1/4 of ypp weight
  pts += ppdDiff * (cal.w_epa * 0.15);      // small bump from finishing drives
  pts += dcrDiff * (cal.w_success * 0.60);  // 0.05 DCR ≈ ~0.3–0.4 pts

  // Micro: penalties (negative) + plays
  pts -= pensDiff * cal.w_penalties;        // more flags → fewer points
  pts += (playsDiff / 10) * cal.w_plays;    // every +10 plays60 adds a tiny bump

  // Apply shared pace factor last
  pts *= paceFactor;

  return clamp(pts, 10, 40);
}

function computeModelConfidence(quality, sim, sim_mc) {
  const tier = (quality && quality.tier) || "medium";
  let score;

  if (tier === "high") score = 0.80;
  else if (tier === "low") score = 0.35;
  else score = 0.55; // medium / unknown

  // Default-like fields penalty
  const dHome = (quality && quality.default_like && quality.default_like.home || []).length;
  const dAway = (quality && quality.default_like && quality.default_like.away || []).length;
  const defaultsCount = dHome + dAway;

  if (defaultsCount > 0) {
    const defaultPenalty = Math.min(0.04 * defaultsCount, 0.20); // max -0.20
    score -= defaultPenalty;
  }

  // Used_defaults flag (missing core) → small penalty
  if (quality && quality.used_defaults) {
    score -= 0.05;
  }

  // Volatility from CI width (use sim_mc first, fall back to sim)
  let ci = null;
  if (sim_mc && Array.isArray(sim_mc.ci_total)) ci = sim_mc.ci_total;
  else if (sim && Array.isArray(sim.ci_total)) ci = sim.ci_total;

  if (ci && ci.length === 2) {
    const w = Number(ci[1]) - Number(ci[0]);
    if (Number.isFinite(w)) {
      // Tight CI → bump, very wide CI → small penalty
      if (w <= 24) score += 0.05;
      else if (w >= 44) score -= 0.05;
    }
  }

  // Clamp to safe band
  return clamp(score, 0.10, 0.95);
}

function buildMatchupInputs(homeStats, awayStats, cal) {
  const home = normalizeTeamStats(homeStats);
  const away = normalizeTeamStats(awayStats);

  const homePts0 = baseExpectedPoints(home, away, cal);
  const awayPts0 = baseExpectedPoints(away, home, cal);

  const trench = trenchSignal(home, away, cal);
  const ctx    = computeContextSignal(home, away, cal);

  let homePts = clamp(homePts0 + trench.pts_home + ctx.pts_home, 10, 45);
  let awayPts = clamp(awayPts0 + trench.pts_away + ctx.pts_away, 10, 45);

  // ===== Patch 10: Play-split + Drive-kill (elite, minimal) =====
  // Drive-kill: sacks + giveaways (asymmetric; reduces points for the riskier offense)
  const dk_home_raw =
    4.0 * (num(home.sack_rate_allowed, 0.06) - 0.06) +
    0.35 * (num(home.giveaways_per_game, 1.1) - 1.1) +
    0.08 * (num(home.penalties_per_game, 6.6) - 6.6);
  const dk_away_raw =
    4.0 * (num(away.sack_rate_allowed, 0.06) - 0.06) +
    0.35 * (num(away.giveaways_per_game, 1.1) - 1.1) +
    0.08 * (num(away.penalties_per_game, 6.6) - 6.6);

  const dk_home = clamp(dk_home_raw, -0.12, 0.12);
  const dk_away = clamp(dk_away_raw, -0.12, 0.12);

  // Drive-kill should NOT directly swing points (too unstable).
  // Instead, it nudges *plays* (and therefore points) modestly downstream.
  homePts = clamp(homePts, 10, 45);
  awayPts = clamp(awayPts, 10, 45);
// Play split: allow asymmetric play volumes (e.g., 68 vs 52) while keeping total reasonable
  const paceHome = num(home.pace_plays60, 62);
  const paceAway = num(away.pace_plays60, 62);
  const avgPlays = (paceHome + paceAway) / 2;

  // Team-specific drive extension from conversions (proxy for 3rd/4th down sustain)
  const dcrHome = num(home.down_conversion_rate, 0.75);
  const dcrAway = num(away.down_conversion_rate, 0.75);

  // Conversion sustain influences play volume, but keep it modest to avoid runaway totals.
  let playsHome = paceHome + (dcrHome - 0.75) * 10;
  let playsAway = paceAway + (dcrAway - 0.75) * 10;

  // Drive-kill nudges plays (≈ +/-2.4 plays max)
  playsHome += (-dk_home) * 20;
  playsAway += (-dk_away) * 20;
// Script skew: leading team tends to run slightly fewer plays; trailing team more
  const leadScore = (homePts - awayPts) / 7; // ~1 per TD margin
  // Script skew exists, but don't let it dominate the whole projection.
  const skew = clamp(-leadScore * 6, -12, 12);
  playsHome += skew;
  playsAway -= skew;

  playsHome = clamp(playsHome, 40, 80);
  playsAway = clamp(playsAway, 40, 80);

  // Scale points by relative play volume vs average.
  // Use a sqrt response + clamp to keep realistic volatility (prevents 1-2 plays swings from flipping spreads).
  const volHome = clamp(Math.sqrt(playsHome / Math.max(1, avgPlays)), 0.85, 1.15);
  const volAway = clamp(Math.sqrt(playsAway / Math.max(1, avgPlays)), 0.85, 1.15);
  homePts = clamp(homePts * volHome, 10, 45);
  awayPts = clamp(awayPts * volAway, 10, 45);



// Chaos factor: boost totals in high-variance profiles (turnovers, penalties, explosives, sack stress)
const gHome = num(home.giveaways_per_game, 1.1);
const gAway = num(away.giveaways_per_game, 1.1);
const pHome = num(home.penalties_per_game, 6.6);
const pAway = num(away.penalties_per_game, 6.6);
const xHome = num(home.explosive_play_rate, 0.09);
const xAway = num(away.explosive_play_rate, 0.09);
const sHome = num(home.sack_rate_allowed, 0.06);
const sAway = num(away.sack_rate_allowed, 0.06);

const avgGive = (gHome + gAway) / 2;
const avgPen  = (pHome + pAway) / 2;
const avgExpl = (xHome + xAway) / 2;
const avgSack = (sHome + sAway) / 2;

let chaos = 0;
chaos += (avgGive - 1.0) * 4.0;          // +4 pts per giveaway above 1.0 avg
chaos += (avgPen  - 6.5) * 0.6;          // mild penalty chaos
chaos += (avgExpl - 0.09) * 18.0;        // explosives matter a lot
chaos += (avgSack - 0.06) * 10.0;        // sack stress creates short fields / volatility

// We separate chaos into:
//  (a) mean-shift (small) -> avoids "fake 70s" totals
//  (b) variance inflation (bigger) -> keeps high-variance profiles realistic
const chaos_raw = clamp(chaos, -2.5, 9.5);
const chaos_mean = clamp(chaos_raw, -2.0, 4.5);
// 0..0.25 sigma inflation based on magnitude of chaos signal
const chaos_sigma_scale = clamp(Math.abs(chaos_raw) / 9.5, 0, 1) * 0.25;

// Apply mean-shift to total, distribute by each team's point share
const total_base_pre_chaos = homePts + awayPts;
if (total_base_pre_chaos > 0) {
  const add = chaos_mean;
  const shareHome = homePts / total_base_pre_chaos;
  homePts = clamp(homePts + add * shareHome, 10, 50);
  awayPts = clamp(awayPts + add * (1 - shareHome), 10, 50);
}
  // Expose for debugging/UI (added to returned inputs)
  const plays_home_est = Number(playsHome.toFixed(1));
  const plays_away_est = Number(playsAway.toFixed(1));
  const drive_kill = { home: Number(dk_home.toFixed(3)), away: Number(dk_away.toFixed(3)) };

  const pace = (num(home.pace_plays60, 62) + num(away.pace_plays60, 62)) / 2;
  const h_pr = num(home.pass_rate, 0.58);
  const a_pr = num(away.pass_rate, 0.58);

  // --- Totals enhancement (keeps ML/spread logic intact) ---
  // Build a totals adjustment from *matchups* (off vs opp def) and pace.
  // League-ish anchors (tuned lightly; avoid wild swings).
  const L_RZ = 0.55;     // red zone TD rate baseline
  const L_EXPL = 0.09;   // explosive play rate baseline
  const L_YPP = 5.5;     // yards/play baseline
  const L_DEF_S = 0.44;  // defensive success baseline (higher = worse defense)
  const L_PACE = 62.0;   // plays/60 baseline

  const eff_rz_home = 0.5 * (home.redzone_td_rate_off + away.redzone_td_rate_def);
  const eff_rz_away = 0.5 * (away.redzone_td_rate_off + home.redzone_td_rate_def);
  const eff_rz = 0.5 * (eff_rz_home + eff_rz_away);

  const avg_expl = 0.5 * (home.explosive_play_rate + away.explosive_play_rate);
  const avg_ypp = 0.5 * (home.yards_per_play + away.yards_per_play);
  const avg_def_s = 0.5 * (home.def_success + away.def_success);

  const pace_delta = (pace - L_PACE);

  // Weighted blend; clamp to prevent overreaction.
  let totalAdj =
    12.0 * (eff_rz - L_RZ) +
    18.0 * (avg_expl - L_EXPL) +
     5.0 * ((avg_ypp - L_YPP) / 1.0) +
    15.0 * (avg_def_s - L_DEF_S) +
     0.50 * pace_delta;

  totalAdj = clamp(totalAdj, -9.0, 9.0);

  // Apply adjustment symmetrically so spread doesn't change.
  homePts += 0.5 * totalAdj;
  awayPts += 0.5 * totalAdj;

  const spread = homePts - awayPts;
  const total  = homePts + awayPts;

  return {
    pace,
    // Totals breakdown (no clamping; transparency + variance-aware totals)
    total_base_pre_chaos,
    chaos_raw,
    chaos_mean_add: chaos_mean,
    chaos_sigma_scale,
    total_pre_adj: (total_base_pre_chaos + chaos_mean),
    total_adj: totalAdj,
    plays_home_est,
    plays_away_est,
    drive_kill,
    h_pr,
    a_pr,
    homePts,
    awayPts,
    spread,
    total,
    trench,
    context: ctx,
    home_norm: home,
    away_norm: away
  };
}

function spreadToWinProb(spread, cal) {
  const scale = 6.5 * cal.temp_tau;
  const x = clamp(spread / scale, -8, 8);
  return 1 / (1 + Math.exp(-x));
}

function calibrateMatchup(inputs, cal) {
  const baseSpread = inputs.spread + (cal.home_field || 0);
  const baseTotal  = inputs.total;

  // Gate the negative total bias to only truly low-total profiles
  const pace = num(inputs.pace, 62);
  const h = inputs.home_norm || {};
  const a = inputs.away_norm || {};
  const h_xpl = num(h.explosive_play_rate, 0.12);
  const a_xpl = num(a.explosive_play_rate, 0.12);
  const h_def = num(h.def_success, 0.44);
  const a_def = num(a.def_success, 0.44);
  const lowTotalProfile = (pace < 60.5) && (h_xpl < 0.08) && (a_xpl < 0.08) && (h_def < 0.43) && (a_def < 0.43);
  const total_a_eff = lowTotalProfile ? num(cal.total_a, 0) : 0;

  const spread = cal.spread_a + cal.spread_b * baseSpread;
  const total  = total_a_eff + cal.total_b * baseTotal;

  // Moneyline should be less jumpy than the spread output.
  // We keep the spread market exactly as calibrated above, but compute ML from a
  // softened spread that (a) only partially applies home_field and (b) optionally
  // shrinks/expands the spread before converting to win probability.
  const hfMult = (typeof cal.home_field_ml_mult === "number") ? cal.home_field_ml_mult : CAL_DEFAULTS.home_field_ml_mult;
  const mlScale = (typeof cal.ml_spread_scale === "number") ? cal.ml_spread_scale : CAL_DEFAULTS.ml_spread_scale;

  const baseSpreadForML = inputs.spread + (cal.home_field || 0) * hfMult;
  const spreadForML = cal.spread_a + cal.spread_b * baseSpreadForML;

  const ml_home = spreadToWinProb(spreadForML * mlScale, cal);
  const ml_away = 1 - ml_home;

  // Use empirical sigma_total when available; inflate for high-variance (chaos) profiles.
  const sigmaTotalBase = Number.isFinite(num(cal.sigma_total, NaN))
    ? num(cal.sigma_total, 13) * (cal.ci80_inflate || 1.0)
    : 13 * (cal.ci80_inflate || 1.0);

  const sigmaInflate = (inputs && Number.isFinite(num(inputs.chaos_sigma_scale, NaN)))
    ? (1 + clamp(num(inputs.chaos_sigma_scale, 0), 0, 0.35))
    : 1;

  const sigmaTotal = sigmaTotalBase * sigmaInflate;
  const ci_low  = total - 1.28 * sigmaTotal;
  const ci_high = total + 1.28 * sigmaTotal;

  return {
    spread_base: baseSpread,
    total_base: baseTotal,
    spread,
    total,
    ml_home,
    ml_away,
    winner: ml_home >= 0.5 ? "HOME" : "AWAY",
    ci_total: [ci_low, ci_high]
  };
}

function simGameOutcome(inputs, cal) {
  return calibrateMatchup(inputs, cal);
}

// ========= Monte Carlo score distribution =========
const MC_DEFAULTS = { sims: 5000, dist: "negbin", alpha: 0.8 };

function randUniform() { return Math.random(); }

function sampleNormal() {
  let u1 = randUniform();
  let u2 = randUniform();
  if (u1 <= 0) u1 = 1e-12;
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  return r * Math.cos(theta);
}

function sampleGamma(shape, scale) {
  if (shape <= 0) return 0;
  if (shape === 1) {
    let u = randUniform();
    if (u <= 0) u = 1e-12;
    return -Math.log(u) * scale;
  }
  if (shape < 1) {
    const u = randUniform();
    return sampleGamma(1 + shape, scale) * Math.pow(u, 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  while (true) {
    const x = sampleNormal();
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const u = randUniform();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v * scale;
    }
  }
}

function samplePoisson(lambda) {
  const L = Math.exp(-lambda);
  let p = 1;
  let k = 0;
  do {
    k++;
    p *= Math.random();
  } while (p > L && k < 200);
  return k - 1;
}

function sampleNegBinFromLambda(lambda, alpha) {
  const lam = lambda <= 0 ? 0 : lambda;
  if (lam === 0) return 0;
  const a = alpha > 0 ? alpha : 0.5;
  const shape = lam / a;
  const scale = a;
  const lamPrime = sampleGamma(shape, scale);
  return samplePoisson(lamPrime);
}

function quantileSorted(arr, q) {
  const n = arr.length;
  if (!n) return null;
  const idx = (n - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  const w = idx - lo;
  return arr[lo] * (1 - w) + arr[hi] * w;
}

function simGameOutcomeMC(inputs) {
  const cfg = MC_DEFAULTS;
  const sims = cfg.sims || 5000;
  const alpha = cfg.alpha || 0;
  const useNegBin = cfg.dist === "negbin" && alpha > 0;

  const lambdaHome = Math.max(num(inputs.homePts, 0), 0.1);
  const lambdaAway = Math.max(num(inputs.awayPts, 0), 0.1);

  let homeWins = 0, awayWins = 0, ties = 0;
  let sumHome = 0, sumAway = 0, sumMargin = 0, sumTotal = 0;

  const marginSamples = new Array(sims);
  const totalSamples = new Array(sims);

  for (let i = 0; i < sims; i++) {
    const h = useNegBin ? sampleNegBinFromLambda(lambdaHome, alpha) : samplePoisson(lambdaHome);
    const a = useNegBin ? sampleNegBinFromLambda(lambdaAway, alpha) : samplePoisson(lambdaAway);

    const margin = h - a;
    const total = h + a;

    sumHome += h; sumAway += a; sumMargin += margin; sumTotal += total;
    marginSamples[i] = margin;
    totalSamples[i] = total;

    if (h > a) homeWins++;
    else if (a > h) awayWins++;
    else ties++;
  }

  marginSamples.sort((x, y) => x - y);
  totalSamples.sort((x, y) => x - y);

  return {
    sims,
    dist: cfg.dist,
    alpha,
    lambda_home: lambdaHome,
    lambda_away: lambdaAway,
    mean_home: sumHome / sims,
    mean_away: sumAway / sims,
    mean_margin: sumMargin / sims,
    mean_total: sumTotal / sims,
    home_win_prob: homeWins / sims,
    away_win_prob: awayWins / sims,
    tie_prob: ties / sims,
    ci_spread: [quantileSorted(marginSamples, 0.10), quantileSorted(marginSamples, 0.90)],
    ci_total:  [quantileSorted(totalSamples, 0.10),  quantileSorted(totalSamples, 0.90)]
  };
}

// ========= Odds / Anchors =========
const GAME_LINE_TTL = 35 * 60;
const GAME_LINE_MARKETS = ["spreads", "h2h", "totals"];

async function fetchGameLines(env) {
  if (!env.ODDS_API_KEY) throw new Error("missing_ODDS_API_KEY");

  const url = new URL("https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds");
  url.searchParams.set("apiKey", env.ODDS_API_KEY);
  url.searchParams.set("regions", "us");
  url.searchParams.set("markets", GAME_LINE_MARKETS.join(","));
  url.searchParams.set("oddsFormat", "american");

  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`odds_http_${r.status}`);
  return r.json();
}

function normalizeGameLines(json = []) {
  const events = [];
  for (const ev of json) {
    const item = {
      id: ev.id,
      commence: ev.commence_time,
      home: ev.home_team,
      away: ev.away_team,
      markets: {}
    };

    for (const bm of ev.bookmakers || []) {
      for (const mk of bm.markets || []) {
        if (mk.key === "spreads") {
          const out = mk.outcomes || [];
          const h = out.find(o => o.name === ev.home_team);
          const a = out.find(o => o.name === ev.away_team);
          if (h && a) {
            item.markets.spread = {
              home: { point: h.point, price: h.price },
              away: { point: a.point, price: a.price }
            };
          }
        } else if (mk.key === "totals") {
          const out = mk.outcomes || [];
          const over = out.find(o => o.name === "Over");
          const under = out.find(o => o.name === "Under");
          if (over && under) {
            item.markets.total = {
              total: over.point,
              over_price: over.price,
              under_price: under.price
            };
          }
        } else if (mk.key === "h2h") {
          const out = mk.outcomes || [];
          const h = out.find(o => o.name === ev.home_team);
          const a = out.find(o => o.name === ev.away_team);
          if (h && a) {
            item.markets.moneyline = { home: h.price, away: a.price };
          }
        }
      }
    }

    events.push(item);
  }
  return events;
}

async function getGameLines(env) {
  const cacheKey = "brain:v1:nfl:game-lines";
  const cached = await kvGet(env, cacheKey);
  if (cached && cached.data && cached.expiresAt) {
    const now = Date.now() / 1000;
    if (now < cached.expiresAt) return cached.data;
  }
  const raw = await fetchGameLines(env);
  const data = normalizeGameLines(raw);
  const expiresAt = Math.floor(Date.now() / 1000) + GAME_LINE_TTL;
  await kvPut(env, cacheKey, { data, expiresAt }, GAME_LINE_TTL);
  return data;
}

// American odds → implied probability
function oddsToImplied(american) {
  const price = Number(american);
  if (!Number.isFinite(price) || price === 0) return 0.5;
  if (price > 0) return 100 / (price + 100);
  return -price / (-price + 100);
}

function gradeEdgePts(edge) {
  const a = Math.abs(edge);
  if (a >= 4) return "A+";
  if (a >= 3) return "A";
  if (a >= 2) return "B";
  if (a >= 1) return "C";
  return "D";
}

function gradeEdgeProb(edgeProb) {
  const a = Math.abs(edgeProb);
  if (a >= 0.10) return "A+";
  if (a >= 0.07) return "A";
  if (a >= 0.05) return "B";
  if (a >= 0.03) return "C";
  return "D";
}

// Winner-first grading (optimize accuracy of winner before pricing/edge).
// Grade is based on model win probability for the chosen team.
function gradeWinProb(p) {
  const prob = Number(p);
  if (!Number.isFinite(prob)) return "D";
  if (prob >= 0.70) return "A+";
  if (prob >= 0.64) return "A";
  if (prob >= 0.58) return "B";
  if (prob >= 0.54) return "C";
  return "D";
}

function winConfidenceLabel(prob) {
  const p = Number(prob);
  if (!Number.isFinite(p)) return "watch";
  if (p >= 0.66) return "anchor";
  if (p >= 0.58) return "strong";
  return "watch";
}

// Build one row of edges for a single game
function buildGameEdgeRow(ev, matchup, fit) {
  const markets = ev.markets || {};
  const spread = markets.spread || {};
  const total  = markets.total || {};
  const ml     = markets.moneyline || {};

  const sim    = matchup.sim;
  const inputs = matchup.inputs || {};
  const req    = matchup.request || {};

  // Market line inputs
  // Prefer odds-derived market objects, but allow manual overrides via request body:
  //   { market_spread_home: -3.5, market_total: 44.5 }
  //   { market: { spread_home: -3.5, total: 44.5 } }
  //   { market: { spread: { home: { point: -3.5 } }, total: { total: 44.5 } } }
  let marketSpreadHome = Number(spread.home?.point ?? NaN);
  let marketTotal      = Number(total.total ?? NaN);

  if (!Number.isFinite(marketSpreadHome)) {
    marketSpreadHome = Number(
      req.market_spread_home ??
      req.market?.spread_home ??
      req.market?.spread?.home?.point ??
      NaN
    );
  }
  if (!Number.isFinite(marketTotal)) {
    marketTotal = Number(
      req.market_total ??
      req.market?.total ??
      req.market?.total_points ??
      req.market?.total?.total ??
      req.market?.total?.points ??
      NaN
    );
  }
  // Treat non-positive totals as missing (prevents fake 99.999% over when total=0)
  if (Number.isFinite(marketTotal) && marketTotal <= 10) marketTotal = NaN;

  const modelSpread = Number(sim.spread);
  const modelTotal  = Number(sim.total);
  const modelMlHome = Number(sim.ml_home);
  const modelMlAway = Number(sim.ml_away);

  const sigmaS = (fit && fit.sigma && Number.isFinite(fit.sigma.spread)) ? Number(fit.sigma.spread) : 13.5;
  const sigmaT = (fit && fit.sigma && Number.isFinite(fit.sigma.total)) ? Number(fit.sigma.total) : 14.0;

  // Market odds (American)
  const oddsSpreadHome = Number.isFinite(Number(req.market_spread_odds_home ?? req.market?.spread_odds_home))
    ? Number(req.market_spread_odds_home ?? req.market?.spread_odds_home)
    : (Number.isFinite(Number(spread.home?.price)) ? Number(spread.home.price) : -110);
  const oddsSpreadAway = Number.isFinite(Number(req.market_spread_odds_away ?? req.market?.spread_odds_away))
    ? Number(req.market_spread_odds_away ?? req.market?.spread_odds_away)
    : (Number.isFinite(Number(spread.away?.price)) ? Number(spread.away.price) : -110);
  const oddsOver = Number.isFinite(Number(req.market_total_odds_over ?? req.market?.total_odds_over))
    ? Number(req.market_total_odds_over ?? req.market?.total_odds_over)
    : (Number.isFinite(Number(total.over_price)) ? Number(total.over_price) : (Number.isFinite(Number(total.over?.price)) ? Number(total.over.price) : -110));
  const oddsUnder = Number.isFinite(Number(req.market_total_odds_under ?? req.market?.total_odds_under))
    ? Number(req.market_total_odds_under ?? req.market?.total_odds_under)
    : (Number.isFinite(Number(total.under_price)) ? Number(total.under_price) : (Number.isFinite(Number(total.under?.price)) ? Number(total.under.price) : -110));

  const oddsMlHome = Number.isFinite(Number(req.market_ml_home ?? req.market?.ml_home ?? req.market?.ml_odds_home ?? req.market?.ml_odds_home))
    ? Number(req.market_ml_home ?? req.market?.ml_home ?? req.market?.ml_odds_home ?? req.market?.ml_odds_home)
    : (Number.isFinite(Number(ml.home)) ? Number(ml.home) : null);
  const oddsMlAway = Number.isFinite(Number(req.market_ml_away ?? req.market?.ml_away ?? req.market?.ml_odds_away ?? req.market?.ml_odds_away))
    ? Number(req.market_ml_away ?? req.market?.ml_away ?? req.market?.ml_odds_away ?? req.market?.ml_odds_away)
    : (Number.isFinite(Number(ml.away)) ? Number(ml.away) : null);

  // Implied probs from odds (no-vig NOT applied here; consistent/simple)
  const impSpreadHome = americanToImplied(oddsSpreadHome);
  const impSpreadAway = americanToImplied(oddsSpreadAway);
  const impOver = americanToImplied(oddsOver);
  const impUnder = americanToImplied(oddsUnder);
  const impMlHome = oddsMlHome != null ? oddsToImplied(oddsMlHome) : null;
  const impMlAway = oddsMlAway != null ? oddsToImplied(oddsMlAway) : null;

  // Model probabilities (normal approx for ATS/totals; calibrated ML already)
    const zCoverHome = (Number.isFinite(marketSpreadHome) && Number.isFinite(modelSpread) && Number.isFinite(sigmaS) && sigmaS > 0) ? ((modelSpread + marketSpreadHome) / sigmaS) : null;
  const pCoverHome = zCoverHome == null ? null : normCdf(zCoverHome);
  const pCoverAway = pCoverHome == null ? null : (1 - pCoverHome);

    const zOver = (Number.isFinite(marketTotal) && Number.isFinite(modelTotal) && Number.isFinite(sigmaT) && sigmaT > 0) ? ((modelTotal - marketTotal) / sigmaT) : null;
  const pOver = zOver == null ? null : normCdf(zOver);
  const pUnder = pOver == null ? null : (1 - pOver);

  // Prob edges
  const edgeCoverHome = (pCoverHome != null && impSpreadHome != null) ? (pCoverHome - impSpreadHome) : null;
  const edgeCoverAway = (pCoverAway != null && impSpreadAway != null) ? (pCoverAway - impSpreadAway) : null;

  const edgeOver = (pOver != null && impOver != null) ? (pOver - impOver) : null;
  const edgeUnder = (pUnder != null && impUnder != null) ? (pUnder - impUnder) : null;

  const edgeMlHome = (Number.isFinite(modelMlHome) && impMlHome != null) ? (modelMlHome - impMlHome) : null;
  const edgeMlAway = (Number.isFinite(modelMlAway) && impMlAway != null) ? (modelMlAway - impMlAway) : null;

  // EV per 1 unit stake
  const evCoverHome = (pCoverHome != null) ? evPerUnit(pCoverHome, oddsSpreadHome) : null;
  const evCoverAway = (pCoverAway != null) ? evPerUnit(pCoverAway, oddsSpreadAway) : null;
  const evOver = (pOver != null) ? evPerUnit(pOver, oddsOver) : null;
  const evUnder = (pUnder != null) ? evPerUnit(pUnder, oddsUnder) : null;
  const evMlHome = (Number.isFinite(modelMlHome) && oddsMlHome != null) ? evPerUnit(modelMlHome, oddsMlHome) : null;
  const evMlAway = (Number.isFinite(modelMlAway) && oddsMlAway != null) ? evPerUnit(modelMlAway, oddsMlAway) : null;

  // Legacy point-delta edges (debug)
  const edgeSpreadPts = Number.isFinite(marketSpreadHome) ? (modelSpread - marketSpreadHome) : null;
  const edgeTotalPts  = Number.isFinite(marketTotal) ? (modelTotal - marketTotal) : null;

  return {
    event_id: ev.id,
    commence: ev.commence,
    home_name: ev.home,
    away_name: ev.away,
    home: matchup.home,
    away: matchup.away,

    model_spread_home: modelSpread,
    model_total: modelTotal,
    model_ml_home: modelMlHome,
    model_ml_away: modelMlAway,

    market_spread_home: Number.isFinite(marketSpreadHome) ? marketSpreadHome : null,
    market_total: Number.isFinite(marketTotal) ? marketTotal : null,

    market_spread_odds_home: oddsSpreadHome,
    market_spread_odds_away: oddsSpreadAway,
    market_total_odds_over: oddsOver,
    market_total_odds_under: oddsUnder,

    market_ml_home: oddsMlHome,
    market_ml_away: oddsMlAway,

    imp_spread_home: impSpreadHome,
    imp_spread_away: impSpreadAway,
    imp_over: impOver,
    imp_under: impUnder,
    imp_ml_home: impMlHome,
    imp_ml_away: impMlAway,

    p_cover_home: pCoverHome,
    market_spread_home: Number.isFinite(marketSpreadHome) ? marketSpreadHome : null,
    market_total: Number.isFinite(marketTotal) ? marketTotal : null,
    p_cover_away: pCoverAway,
    p_over: pOver,
    p_under: pUnder,
    z_cover_home: zCoverHome,
    z_over: zOver,

    edge_cover_home: edgeCoverHome,
    edge_cover_away: edgeCoverAway,
    edge_over: edgeOver,
    edge_under: edgeUnder,
    edge_ml_home: edgeMlHome,
    edge_ml_away: edgeMlAway,

    ev_cover_home: evCoverHome,
    ev_cover_away: evCoverAway,
    ev_over: evOver,
    ev_under: evUnder,
    ev_ml_home: evMlHome,
    ev_ml_away: evMlAway,

    edge_spread_pts: edgeSpreadPts,
    edge_total_pts: edgeTotalPts,

    grade_spread: edgeSpreadPts == null ? null : gradeEdgePts(edgeSpreadPts),
    grade_total:  edgeTotalPts == null ? null : gradeEdgePts(edgeTotalPts),
    grade_ml_home: edgeMlHome == null ? null : gradeEdgeProb(edgeMlHome),
    grade_ml_away: edgeMlAway == null ? null : gradeEdgeProb(edgeMlAway),

    pace: inputs.pace,
    h_pr: inputs.h_pr,
    a_pr: inputs.a_pr,

    sigma_spread: sigmaS,
    sigma_total: sigmaT,

    model_confidence: matchup.model_confidence ?? null,
    quality: matchup.quality || null
  };
}

// Decide anchors from edges rows


// Eligibility gate: do NOT clamp predictions. Only controls whether something can be labeled an ANCHOR.
// Uses calibrated z-scores vs market (spread/total) to avoid "god-mode" anchors from mismatched lines/data.
function computeAnchorEligibility(row, market, opts = {}) {
  const maxZSpread = Number.isFinite(Number(opts.maxZSpread)) ? Number(opts.maxZSpread) : 2.75;
  const maxZTotal  = Number.isFinite(Number(opts.maxZTotal)) ? Number(opts.maxZTotal) : 2.25;
  const maxDeltaTotal = Number.isFinite(Number(opts.maxDeltaTotal)) ? Number(opts.maxDeltaTotal) : 18; // points
  const maxDeltaSpread = Number.isFinite(Number(opts.maxDeltaSpread)) ? Number(opts.maxDeltaSpread) : 17; // points

  const zS = Number.isFinite(Number(row.z_cover_home)) ? Number(row.z_cover_home) : null;
  const zT = Number.isFinite(Number(row.z_over)) ? Number(row.z_over) : null;

  const reasons = [];

  if (market === "spread") {
    if (zS == null) reasons.push("missing_market_spread");
    else if (Math.abs(zS) > maxZSpread) reasons.push("z_spread_outlier");
    const ms = Number.isFinite(Number(row.model_spread_home)) ? Number(row.model_spread_home) : null;
    const ls = Number.isFinite(Number(row.market_spread_home)) ? Number(row.market_spread_home) : null;
    if (ms != null && ls != null) {
      const d = Math.abs(ms - ls);
      if (d > maxDeltaSpread) reasons.push("delta_spread_outlier");
    }
  } else if (market === "total") {
    if (zT == null) reasons.push("missing_market_total");
    else if (Math.abs(zT) > maxZTotal) reasons.push("z_total_outlier");
    const mt = Number.isFinite(Number(row.model_total)) ? Number(row.model_total) : null;
    const lt = Number.isFinite(Number(row.market_total)) ? Number(row.market_total) : null;
    if (mt != null && lt != null) {
      const d = Math.abs(mt - lt);
      if (d > maxDeltaTotal) reasons.push("delta_total_outlier");
    }
  } else if (market === "ml") {
    // For ML, validate if we have any market-derived z-score. If both missing, don't allow as anchor.
    if (zS == null && zT == null) reasons.push("missing_market_lines");
    if (zS != null && Math.abs(zS) > maxZSpread) reasons.push("z_spread_outlier");
    if (zT != null && Math.abs(zT) > maxZTotal) reasons.push("z_total_outlier");
  }

  return {
    anchor_ok: reasons.length === 0,
    reasons,
    z_spread: zS,
    z_total: zT,
    maxZSpread,
    maxZTotal,
    maxDeltaSpread,
    maxDeltaTotal
  };
}
function classifyAnchorsFromEdges(rows, opts = {}) {
  const totalsBias = Number.isFinite(Number(opts.totalsBias)) ? Number(opts.totalsBias) : 0.85; // downweight totals by default until your totals model backtests strong
  const minEdge = Number.isFinite(Number(opts.minEdge)) ? Number(opts.minEdge) : 0.04;          // 4% prob edge default
  const minEdgeTotals = Number.isFinite(Number(opts.minEdgeTotals)) ? Number(opts.minEdgeTotals) : 0.06; // totals require higher edge
  const minEVTotals = Number.isFinite(Number(opts.minEVTotals)) ? Number(opts.minEVTotals) : 0.06;       // totals require higher EV
  const minProbTotals = Number.isFinite(Number(opts.minProbTotals)) ? Number(opts.minProbTotals) : 0.62;  // totals require higher model prob
  const minConf = Number.isFinite(Number(opts.minConf)) ? Number(opts.minConf) : 0.60;

  const spreadAnchors = [];
  const totalAnchors = [];
  const moneylineAnchors = [];

  for (const row of rows) {
    const conf = Number(row.model_confidence ?? 0.5);
    if (!Number.isFinite(conf) || conf < minConf) continue;

    const qualityTier = row.quality?.tier || null;
    const usedDefaults = row.quality?.used_defaults ?? false;

    // --- Spread: choose side with best EV (home vs away)
    const candSpread = [];
    if (row.ev_cover_home != null && row.edge_cover_home != null && row.imp_spread_home != null) {
      candSpread.push({
        team: "HOME",
        side: "home",
        line: row.market_spread_home,
        odds: row.market_spread_odds_home,
        p_model: row.p_cover_home,
        p_imp: row.imp_spread_home,
        edge: row.edge_cover_home,
        ev: row.ev_cover_home
      });
    }
    if (row.ev_cover_away != null && row.edge_cover_away != null && row.imp_spread_away != null) {
      candSpread.push({
        team: "AWAY",
        side: "away",
        line: (row.market_spread_home != null ? -row.market_spread_home : null),
        odds: row.market_spread_odds_away,
        p_model: row.p_cover_away,
        p_imp: row.imp_spread_away,
        edge: row.edge_cover_away,
        ev: row.ev_cover_away
      });
    }
    candSpread.sort((a, b) => (b.ev - a.ev) || (b.edge - a.edge));
    const bestSpread = candSpread[0];
    const eligSpread = computeAnchorEligibility(row, "spread", opts);
    if (bestSpread && bestSpread.edge >= minEdge && eligSpread.anchor_ok) {
      spreadAnchors.push({
        ...row,
        anchor_type: "spread",
        eligibility: eligSpread,
        pick_market: "spread",
        pick_team: bestSpread.team,
        pick_side: bestSpread.side,
        pick_line: bestSpread.line,
        pick_odds: bestSpread.odds,
        p_model: bestSpread.p_model,
        p_implied: bestSpread.p_imp,
        edge_prob: bestSpread.edge,
        ev: bestSpread.ev,
        anchor_confidence: edgeToConfidence(bestSpread.edge, conf, "spread", bestSpread.ev),
        win_prob: (bestSpread.team === "HOME") ? row.model_ml_home : row.model_ml_away,
        win_grade: gradeWinProb((bestSpread.team === "HOME") ? row.model_ml_home : row.model_ml_away)
      });
    }

    // --- Totals: choose over/under with best EV, downweighted
    const candTotal = [];
    if (row.ev_over != null && row.edge_over != null && row.imp_over != null) {
      candTotal.push({
        side: "over",
        line: row.market_total,
        odds: row.market_total_odds_over,
        p_model: row.p_over,
        p_imp: row.imp_over,
        edge: row.edge_over,
        ev: row.ev_over * totalsBias
      });
    }
    if (row.ev_under != null && row.edge_under != null && row.imp_under != null) {
      candTotal.push({
        side: "under",
        line: row.market_total,
        odds: row.market_total_odds_under,
        p_model: row.p_under,
        p_imp: row.imp_under,
        edge: row.edge_under,
        ev: row.ev_under * totalsBias
      });
    }
    candTotal.sort((a, b) => (b.ev - a.ev) || (b.edge - a.edge));
    const bestTotal = candTotal[0];
    const eligTotal = computeAnchorEligibility(row, "total", opts);
    // Totals are "secondary": we do NOT clamp predictions, but we promote to ANCHOR only under stricter gates.
    const mt = Number.isFinite(Number(row.model_total)) ? Number(row.model_total) : null;
    const lt = Number.isFinite(Number(row.market_total)) ? Number(row.market_total) : null;
    const deltaT = (mt != null && lt != null) ? Math.abs(mt - lt) : null;

    const totalAnchorDelta = Number.isFinite(Number(opts.totalAnchorDelta)) ? Number(opts.totalAnchorDelta) : 14; // pts
    const totalStrongDelta = Number.isFinite(Number(opts.totalStrongDelta)) ? Number(opts.totalStrongDelta) : 18; // pts

    const minEdgeTotalsAnchor = Number.isFinite(Number(opts.minEdgeTotalsAnchor)) ? Number(opts.minEdgeTotalsAnchor) : 0.08;
    const minEVTotalsAnchor   = Number.isFinite(Number(opts.minEVTotalsAnchor)) ? Number(opts.minEVTotalsAnchor) : 0.08;
    const minProbTotalsAnchor = Number.isFinite(Number(opts.minProbTotalsAnchor)) ? Number(opts.minProbTotalsAnchor) : 0.70;

    const minEdgeTotalsStrong = Number.isFinite(Number(opts.minEdgeTotalsStrong)) ? Number(opts.minEdgeTotalsStrong) : minEdgeTotals;
    const minEVTotalsStrong   = Number.isFinite(Number(opts.minEVTotalsStrong)) ? Number(opts.minEVTotalsStrong) : 0.05;
    const minProbTotalsStrong = Number.isFinite(Number(opts.minProbTotalsStrong)) ? Number(opts.minProbTotalsStrong) : minProbTotals;

    let totalTier = null;
    if (bestTotal && eligTotal.anchor_ok && deltaT != null) {
      if (bestTotal.edge >= minEdgeTotalsAnchor && bestTotal.ev >= minEVTotalsAnchor && bestTotal.p_model >= minProbTotalsAnchor && deltaT <= totalAnchorDelta) {
        totalTier = "anchor";
      } else if (bestTotal.edge >= minEdgeTotalsStrong && bestTotal.ev >= minEVTotalsStrong && bestTotal.p_model >= minProbTotalsStrong && deltaT <= totalStrongDelta) {
        totalTier = "strong";
      }
    }

    if (totalTier) {
      totalAnchors.push({
        ...row,
        anchor_type: "total",
        eligibility: { ...eligTotal, delta_total: deltaT, totalTier, totalAnchorDelta, totalStrongDelta },
        pick_market: "total",
        pick_team: "",
        pick_side: bestTotal.side,
        pick_line: bestTotal.line,
        pick_odds: bestTotal.odds,
        p_model: bestTotal.p_model,
        p_implied: bestTotal.p_imp,
        edge_prob: bestTotal.edge,
        ev: bestTotal.ev,
        anchor_confidence: totalTier,
      });
    }// --- Moneyline: choose side with best EV
    const candMl = [];
    if (row.ev_ml_home != null && row.edge_ml_home != null && row.imp_ml_home != null && row.market_ml_home != null) {
      candMl.push({
        team: "HOME",
        side: "home",
        line: row.market_ml_home,
        odds: row.market_ml_home,
        p_model: row.model_ml_home,
        p_imp: row.imp_ml_home,
        edge: row.edge_ml_home,
        ev: row.ev_ml_home
      });
    }
    if (row.ev_ml_away != null && row.edge_ml_away != null && row.imp_ml_away != null && row.market_ml_away != null) {
      candMl.push({
        team: "AWAY",
        side: "away",
        line: row.market_ml_away,
        odds: row.market_ml_away,
        p_model: row.model_ml_away,
        p_imp: row.imp_ml_away,
        edge: row.edge_ml_away,
        ev: row.ev_ml_away
      });
    }
    candMl.sort((a, b) => (b.ev - a.ev) || (b.edge - a.edge));
    const bestMl = candMl[0];
    const eligMl = computeAnchorEligibility(row, "ml", opts);
    if (bestMl && bestMl.edge >= minEdge && eligMl.anchor_ok) {
      moneylineAnchors.push({
        ...row,
        anchor_type: "moneyline",
        eligibility: eligMl,
        pick_market: "ml",
        pick_team: bestMl.team,
        pick_side: bestMl.side,
        pick_line: bestMl.line,
        pick_odds: bestMl.odds,
        p_model: bestMl.p_model,
        p_implied: bestMl.p_imp,
        edge_prob: bestMl.edge,
        ev: bestMl.ev,
        anchor_confidence: edgeToConfidence(bestMl.edge, conf, "ml", bestMl.ev),
        win_prob: bestMl.p_model,
        win_grade: gradeWinProb(bestMl.p_model)
      });
    }
  }

  // Rank by confidence tier then EV
  spreadAnchors.sort((a, b) => (tierRank(b.anchor_confidence) - tierRank(a.anchor_confidence)) || ((b.ev ?? 0) - (a.ev ?? 0)));
  totalAnchors.sort((a, b) => (tierRank(b.anchor_confidence) - tierRank(a.anchor_confidence)) || ((b.ev ?? 0) - (a.ev ?? 0)));
  moneylineAnchors.sort((a, b) => (tierRank(b.anchor_confidence) - tierRank(a.anchor_confidence)) || ((b.ev ?? 0) - (a.ev ?? 0)));

  return { spread: spreadAnchors, totals: totalAnchors, moneyline: moneylineAnchors };
}

function tierRank(conf) {
  const c = String(conf || "").toLowerCase();
  if (c === "anchor") return 3;
  if (c === "strong") return 2;
  if (c === "watch") return 1;
  return 0;
}

function edgeToConfidence(edgeProb, modelConf, market, ev1u) {
  const e = Number(edgeProb);
  const mc = Number(modelConf);
  const ev = Number(ev1u);

  if (!Number.isFinite(e) || !Number.isFinite(mc)) return "watch";

  // Stricter thresholds (prevents low-grade picks showing as ANCHOR just from noisy edge).
  // Market-specific baselines: totals generally need a bigger edge to be trustworthy.
  const base = (market === "total") ? 0.10 : (market === "ml" ? 0.08 : 0.08);

  // If EV isn't provided (or is NaN), treat as 0 (no boost).
  const evOk = Number.isFinite(ev) ? ev : 0;

  // ANCHOR: large probability edge + high model confidence + positive EV
  if (e >= base + 0.12 && mc >= 0.80 && evOk >= 0.15) return "anchor";

  // STRONG: solid edge + decent confidence + at least slightly positive EV
  if (e >= base + 0.08 && mc >= 0.70 && evOk >= 0.05) return "strong";

  // WATCH: small edge (still useful for a lean list)
  if (e >= base + 0.03 && mc >= 0.60) return "watch";

  return "watch";
}



function roundTo(value, digits = 2) {
  if (value === null || value === undefined) return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

function buildAnchorSummary(type, r) {
  const home = r.home;
  const away = r.away;
  const conf = (r.anchor_confidence || "").toUpperCase();

  // Winner-first summary helpers
  const pickIsHome = r.pick_team === "HOME";
  const pickAbbr = pickIsHome ? home : away;
  const pickProb = Number(r.win_prob ?? (pickIsHome ? r.model_ml_home : r.model_ml_away));
  const probPct = Number.isFinite(pickProb) ? roundTo(pickProb * 100, 1) : null;

  if (type === "spread") {
    const modelSpread = roundTo(r.model_spread_home, 1);
    return `${pickAbbr} ${r.pick_line > 0 ? "+" : ""}${r.pick_line} spread (${conf}) — model spread_home ${modelSpread}${probPct !== null ? `, win ${probPct}%` : ""}`;
  }

  if (type === "total") {
    const modelTotal = roundTo(r.model_total, 1);
    const marketTotal = r.market_total;
    const delta = roundTo(Math.abs(Number(modelTotal) - Number(marketTotal)), 1);
    return `${r.pick_side.toUpperCase()} ${r.pick_line} total (${conf}) — model ${modelTotal} vs market ${marketTotal} (Δ ${delta})`;
  }

  // moneyline
  return `${pickAbbr} ML (${conf}) — model win ${probPct !== null ? probPct : "?"}%`;
}

function buildAnchorCard(anchorType, r) {
  const modelHomeWin = r.model_ml_home;
  const modelAwayWin = r.model_ml_away;

  const marketHomeImp = oddsToImplied(r.market_ml_home);
  const marketAwayImp = oddsToImplied(r.market_ml_away);

  let pickGrade;
  if (anchorType === "total") {
    pickGrade = r.grade_total;
  } else {
    // Winner-first: prefer win-prob-based grade if present.
    pickGrade = r.win_grade || (anchorType === "spread" ? r.grade_spread : (r.pick_team === "HOME" ? r.grade_ml_home : r.grade_ml_away));
  }

  // 🔥 NEW: translate raw score → label for UI
  const mc = Number(r.model_confidence ?? 0.5);
  let mc_label = "low";
  if (mc >= 0.80) mc_label = "elite";
  else if (mc >= 0.65) mc_label = "high";
  else if (mc >= 0.55) mc_label = "medium";

  return {
    type: anchorType,
    event_id: r.event_id,
    commence: r.commence,
    home_name: r.home_name,
    away_name: r.away_name,
    home: r.home,
    away: r.away,

    pick: {
      market: anchorType === "moneyline" ? "ml" : anchorType,
      team: r.pick_team || null,
      side: r.pick_side || null,
      line: r.pick_line,
      grade: pickGrade,
      confidence: r.anchor_confidence || null,
    },
    // probability + EV (per 1u) for this pick
    prob_view: {
      p_model:   roundTo(r.p_model, 3),
      p_implied: roundTo(r.p_implied, 3),
      edge_prob: roundTo(r.edge_prob, 3),
      ev_1u:     roundTo(r.ev, 3)
    },

    model_view: {
      spread_home: roundTo(r.model_spread_home, 2),
      total:       roundTo(r.model_total, 1),
      ml_home:     roundTo(modelHomeWin, 3),
      ml_away:     roundTo(modelAwayWin, 3),
    },

    market_view: {
      spread_home: r.market_spread_home,
      total:       r.market_total,
      ml_home:     r.market_ml_home,
      ml_away:     r.market_ml_away,
      imp_home:    roundTo(marketHomeImp, 3),
      imp_away:    roundTo(marketAwayImp, 3),
    },

    edges: {
      spread_pts: roundTo(r.edge_spread_pts, 2),
      total_pts:  roundTo(r.edge_total_pts, 2),
      ml_home:    roundTo(r.edge_ml_home, 3),
      ml_away:    roundTo(r.edge_ml_away, 3),
    },

    // 🔥 NEW: reliability section
    reliability: {
      model_confidence: mc,
      model_confidence_label: mc_label,
      quality_tier: r.quality?.tier || null,
      missing_home: r.quality?.missing_home || [],
      missing_away: r.quality?.missing_away || [],
      used_defaults: r.quality?.used_defaults ?? null
    },

    anchor_summary: buildAnchorSummary(anchorType, r),
  };
}

// GET /edges/games
async function handleGameEdges(req, env, origin) {
  try {
    const season = nflSeasonFromDate(new Date());
    const week = null;

    const fit = await getCalFit(env, season);
    const events = await getGameLines(env);
    const rows = [];

    for (const ev of events || []) {
      const homeAbbr = teamNameToAbbr(ev.home);
      const awayAbbr = teamNameToAbbr(ev.away);
      if (!homeAbbr || !awayAbbr) continue;

      try {
        const matchup = await predictMatchup(env, {
          season, week, home: homeAbbr, away: awayAbbr, mode: "edges"
        });
        rows.push(buildGameEdgeRow(ev, matchup, fit));
      } catch {
        continue;
      }
    }

    rows.sort((a, b) => Math.abs(b.edge_spread_pts ?? 0) - Math.abs(a.edge_spread_pts ?? 0));
    return ok({ season, week, count: rows.length, rows }, {}, origin);
  } catch (e) {
    return fail(`edges_games:${e.message || e}`, {}, 400, origin);
  }
}

async function handleStatus(req, env, origin) {
  // Alias to health so UI buttons never break
  return handleHealth(req, env, origin);
}

// GET /anchors/nfl
async function handleAnchorsNFL(req, env, origin) {
  try {
    const season = nflSeasonFromDate(new Date());
    const week = null;

    const fit = await getCalFit(env, season);
    const events = await getGameLines(env);
    const rows = [];

    for (const ev of events || []) {
      const homeAbbr = teamNameToAbbr(ev.home);
      const awayAbbr = teamNameToAbbr(ev.away);
      if (!homeAbbr || !awayAbbr) continue;

      try {
        const matchup = await predictMatchup(env, {
          season, week, home: homeAbbr, away: awayAbbr, mode: "anchors"
        });
        rows.push(buildGameEdgeRow(ev, matchup, fit));
      } catch {
        continue;
      }
    }

    const classified = classifyAnchorsFromEdges(rows);

    const spreadAnchors    = (classified.spread || []).map(r => buildAnchorCard("spread", r));
    const totalAnchors     = (classified.totals || []).map(r => buildAnchorCard("total", r));
    const moneylineAnchors = (classified.moneyline || []).map(r => buildAnchorCard("moneyline", r));

    return ok(
      {
        season,
        week,
        games_count: rows.length,
        anchors: {
          spread: spreadAnchors,
          totals: totalAnchors,
          moneyline: moneylineAnchors,
        },
        edges: rows,
      },
      {},
      origin
    );
  } catch (e) {
    return fail(`anchors_nfl:${e.message || e}`, {}, 400, origin);
  }
}

// ========= Props scoring =========
function kellyFraction(edgeProb, impliedProb) {
  const p = edgeProb;
  const b = (1 / impliedProb) - 1;
  if (b <= 0) return 0;
  const f = (p * (b + 1) - 1) / b;
  return clamp(f, 0, 1);
}


// --- odds/probability helpers for anchors ---
function americanToImplied(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o === 0) return null;
  if (o < 0) return (-o) / ((-o) + 100);
  return 100 / (o + 100);
}
function americanProfitPer1(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o === 0) return null;
  if (o < 0) return 100 / (-o);
  return o / 100;
}

function evPerUnit(pModel, americanOdds) {
  const p = Number(pModel);
  if (!Number.isFinite(p)) return null;
  const profit = americanProfitPer1(americanOdds);
  if (!Number.isFinite(profit)) return null;
  // Stake = 1 unit: EV = p*profit - (1-p)*1
  return (p * profit) - ((1 - p) * 1);
}

function evPer1Stake(p, odds) {
  const pp = americanProfitPer1(odds);
  if (!Number.isFinite(p) || pp == null) return null;
  return p * pp - (1 - p);
}
function gradeAnchor(edge, zAbs) {
  if (!Number.isFinite(edge)) return null;
  if (edge >= 0.06 && (zAbs == null || zAbs >= 0.55)) return "ANCHOR";
  if (edge >= 0.045) return "A+";
  if (edge >= 0.035) return "A";
  if (edge >= 0.02) return "B";
  return "C";
}

// helpers to pick model values from stored logs
function pickModelSpread(model){
  if (!model) return null;
  if (isFiniteNum(model.spread)) return model.spread;
  if (isFiniteNum(model.spread_model_raw)) return model.spread_model_raw;
  if (model.pure && isFiniteNum(model.pure.spread)) return model.pure.spread;
  return null;
}
function pickModelTotal(model){
  if (!model) return null;
  if (isFiniteNum(model.total)) return model.total;
  if (isFiniteNum(model.total_model_raw)) return model.total_model_raw;
  if (model.pure && isFiniteNum(model.pure.total)) return model.pure.total;
  return null;
}
function pickModelMlHome(model){
  if (!model) return null;
  if (isFiniteNum(model.ml_home)) return model.ml_home;
  if (model.pure && isFiniteNum(model.pure.ml_home)) return model.pure.ml_home;
  return null;
}

// Build a normalized list of anchor candidates from a matchup prediction.
// Used by /anchors/today and /anchors/rows.
function buildAnchorsFromPrediction(pred, market = {}) {
  const home = pred?.data?.home || pred?.home || pred?.data?.home_team || pred?.home_team;
  const away = pred?.data?.away || pred?.away || pred?.data?.away_team || pred?.away_team;
  const season = pred?.data?.season ?? pred?.season ?? null;
  const week = pred?.data?.week ?? pred?.week ?? null;

  // Prefer already-computed anchors if present.
  const anchors =
    (Array.isArray(pred?.data?.anchors) ? pred.data.anchors : null) ||
    (Array.isArray(pred?.anchors) ? pred.anchors : null) ||
    (Array.isArray(pred?.data?.anchors_model) ? pred.data.anchors_model : null) ||
    (Array.isArray(pred?.anchors_model) ? pred.anchors_model : null) ||
    (Array.isArray(pred?.data?.grading_model?.anchors) ? pred.data.grading_model.anchors : null) ||
    (Array.isArray(pred?.grading_model?.anchors) ? pred.grading_model.anchors : null) ||
    (Array.isArray(pred?.data?.grading_market?.anchors) ? pred.data.grading_market.anchors : null) ||
    (Array.isArray(pred?.grading_market?.anchors) ? pred.grading_market.anchors : null) ||
    [];

  const gradeRank = (g) => {
    const s = String(g || '').toUpperCase();
    if (s === 'A+') return 4;
    if (s === 'A') return 3;
    if (s === 'B') return 2;
    if (s === 'C') return 1;
    return 0;
  };

  const norm = (a) => {
    const marketName = a?.market || a?.type || null;
    const side = a?.side || null;
    const line = isFiniteNum(a?.line) ? num(a.line) : null;
    const odds = isFiniteNum(a?.odds) ? num(a.odds) : null;
    const p_model = isFiniteNum(a?.p_model) ? num(a.p_model) : null;
    const edge = isFiniteNum(a?.edge) ? num(a.edge) : null;
    const ev = isFiniteNum(a?.ev) ? num(a.ev) : null;
    const kelly = isFiniteNum(a?.kelly) ? num(a.kelly) : null;
    const grade = a?.grade || null;

    // Attach the market lines we used (when available) so the UI can render context.
    const market_lines = {
      spread_home: isFiniteNum(market?.spread_home) ? num(market.spread_home) : (isFiniteNum(market?.spread) ? num(market.spread) : null),
      total: isFiniteNum(market?.total) ? num(market.total) : null,
      ml_home: isFiniteNum(market?.ml_home) ? num(market.ml_home) : null,
      ml_away: isFiniteNum(market?.ml_away) ? num(market.ml_away) : null,
      spread_odds: isFiniteNum(market?.spread_odds) ? num(market.spread_odds) : null,
      total_odds: isFiniteNum(market?.total_odds) ? num(market.total_odds) : null,
      spread_odds_home: isFiniteNum(market?.spread_odds_home) ? num(market.spread_odds_home) : null,
      spread_odds_away: isFiniteNum(market?.spread_odds_away) ? num(market.spread_odds_away) : null,
      total_odds_over: isFiniteNum(market?.total_odds_over) ? num(market.total_odds_over) : null,
      total_odds_under: isFiniteNum(market?.total_odds_under) ? num(market.total_odds_under) : null
    };

    return {
      season,
      week,
      home,
      away,
      market: marketName,
      side,
      line,
      odds,
      p_model,
      edge,
      ev,
      kelly,
      grade,
      tier_rank: gradeRank(grade),
      market_lines
    };
  };

  return anchors.map(norm).filter(x => x && x.market && x.side && isFiniteNum(x.edge));
}

// LIVE anchors from game-lines + matchup/sim
async function handleAnchorsToday(req, env, origin) {
  try {
    const url = new URL(req.url);
    // For "today", we primarily use upcoming bookmaker lines (Odds API). season/week are used only for teamstats lookup.
    const season = Number(url.searchParams.get("season") || nflSeasonFromDate(new Date()));
    const week = String(url.searchParams.get("week") || nflWeekFromDate(new Date()));
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 40)));

    // getGameLines() already fetches + normalizes Odds API events into an array of {home, away, markets:{spread,total,ml}}
    const events = await getGameLines(env);
    const out = [];

    for (const ev of events || []) {
      if (out.length >= limit) break;

      const home = normalizeTeamAbbr(toTeamAbbr(ev.home));
      const away = normalizeTeamAbbr(toTeamAbbr(ev.away));
      if (!home || !away) continue;

      const mk = ev.markets || {};
      const spreadMk = mk.spread || null;
      const totalMk = mk.total || null;
      const mlMk = mk.ml || null;

      // Market lines (home perspective): spread.home.point is the home line (e.g., -3.5 for home favorite, +3.5 for home dog)
      const market = {
        spread: spreadMk && spreadMk.home ? num(spreadMk.home.point) : null,
        total: totalMk ? num(totalMk.point) : null,
        ml_home: mlMk && mlMk.home ? num(mlMk.home.price) : null,
        ml_away: mlMk && mlMk.away ? num(mlMk.away.price) : null,

        spread_odds_home: spreadMk && spreadMk.home ? num(spreadMk.home.price) : -110,
        spread_odds_away: spreadMk && spreadMk.away ? num(spreadMk.away.price) : -110,
        total_odds_over: totalMk && totalMk.over ? num(totalMk.over.price) : -110,
        total_odds_under: totalMk && totalMk.under ? num(totalMk.under.price) : -110
      };

      // Require at least one market for anchor evaluation
      if (!isFiniteNum(market.spread) && !isFiniteNum(market.total) && !isFiniteNum(market.ml_home)) continue;

      const pred = await predictMatchup(env, {
        season, week, home, away, market,
        modifiers: {
          enabled: true,
          use_non_garbage: true,
          use_early_down: true,
          use_late_down: true,
          use_red_zone: true,
          blend_mode: "dual",
          pure_weight: 0.7,
          mods_weight: 0.3
        }
      });

      const picks = buildAnchorsFromPrediction(pred, market);
      for (const p of picks) {
        out.push(p);
        if (out.length >= limit) break;
      }
    }

    // Rank: anchors first, then EV, then absolute edge
    out.sort((a, b) =>
      (b.tier_rank - a.tier_rank) ||
      (b.ev - a.ev) ||
      (Math.abs(b.edge) - Math.abs(a.edge))
    );

    return ok({ season, week, count: out.length, items: out.slice(0, limit) }, {}, origin);
  } catch (e) {
    return fail(`anchors_today:${e.message || e}`, {}, 500, origin);
  }
}

// BACKTEST anchors using stored calgame logs (basic accuracy by market pick)
async function handleAnchorsBacktest(req, env, origin) {
  try {
    const url = new URL(req.url);
    const season = Number(url.searchParams.get("season") || nflSeasonFromDate(new Date()));

    const ids = await listKeysByPrefix(env, `calgame:${season}:`);
    const logs = [];
    for (const k of ids) {
      const v = await kvGet(env, k);
      if (v) logs.push(v);
    }

    let atsN = 0, atsW = 0;
    let totN = 0, totW = 0;
    let mlN = 0, mlW = 0;

    for (const g of logs) {
      // --- Teams
      const home = normalizeTeamAbbr(toTeamAbbr(g.home || g.home_team));
      const away = normalizeTeamAbbr(toTeamAbbr(g.away || g.away_team));
      if (!home || !away) continue;

      // --- Market
      const m = g.market || {};
      // allow either spread_home/spread_away or spread (home) or {spread:{home,away}}
      const spread_home =
        isFiniteNum(m.spread_home) ? num(m.spread_home) :
        isFiniteNum(m.spread) ? num(m.spread) :
        (m.spread && isFiniteNum(m.spread.home)) ? num(m.spread.home) :
        (m.spread && m.spread.home && isFiniteNum(m.spread.home.point)) ? num(m.spread.home.point) :
        (isFiniteNum(m.spread_away) ? -num(m.spread_away) : null);

      const total_line =
        isFiniteNum(m.total) ? num(m.total) :
        (m.total && isFiniteNum(m.total.point)) ? num(m.total.point) :
        null;

      const ml_home_american =
        isFiniteNum(m.ml_home) ? num(m.ml_home) :
        (m.ml && isFiniteNum(m.ml.home)) ? num(m.ml.home) :
        (m.ml && m.ml.home && isFiniteNum(m.ml.home.price)) ? num(m.ml.home.price) :
        null;

      // --- Result / Final
      const r = g.final || g.result || {};
      const home_pts =
        isFiniteNum(r.home_pts) ? num(r.home_pts) :
        isFiniteNum(r.home_score) ? num(r.home_score) :
        null;
      const away_pts =
        isFiniteNum(r.away_pts) ? num(r.away_pts) :
        isFiniteNum(r.away_score) ? num(r.away_score) :
        null;
      if (!isFiniteNum(home_pts) || !isFiniteNum(away_pts)) continue;

      const margin_home = home_pts - away_pts;
      const total_pts = home_pts + away_pts;

      // --- Model (raw, prefer stored)
      const mo = g.model || {};
      const pure = mo.pure || {};
      const model_spread =
        isFiniteNum(mo.spread) ? num(mo.spread) :
        isFiniteNum(mo.spread_model_raw) ? num(mo.spread_model_raw) :
        isFiniteNum(pure.spread) ? num(pure.spread) :
        null;

      const model_total =
        isFiniteNum(mo.total) ? num(mo.total) :
        isFiniteNum(mo.total_model_raw) ? num(mo.total_model_raw) :
        isFiniteNum(pure.total) ? num(pure.total) :
        null;

      const model_ml_home =
        isFiniteNum(mo.ml_home) ? num(mo.ml_home) :
        isFiniteNum(pure.ml_home) ? num(pure.ml_home) :
        null;

      // ATS
      if (isFiniteNum(spread_home) && isFiniteNum(model_spread)) {
        atsN += 1;
        const home_covers = (margin_home + spread_home) > 0;
        // "model side" pick: choose side with higher cover probability under normal approx using sigma_spread from fit if present, else 13.5
        const fit = await getCalFit(env, season);
        const sigmaS = (fit && fit.sigma && isFiniteNum(fit.sigma.spread)) ? num(fit.sigma.spread) : 13.5;
        const z = (model_spread + spread_home) / sigmaS;
        const pHome = normCdf(z);
        const pickHome = pHome >= 0.5;
        const win = (pickHome && home_covers) || (!pickHome && !home_covers);
        if (win) atsW += 1;
      }

      // Totals
      if (isFiniteNum(total_line) && isFiniteNum(model_total)) {
        totN += 1;
        const over_hits = total_pts > total_line;
        const fit = await getCalFit(env, season);
        const sigmaT = (fit && fit.sigma && isFiniteNum(fit.sigma.total)) ? num(fit.sigma.total) : 14.0;
        const z = (model_total - total_line) / sigmaT;
        const pOver = normCdf(z);
        const pickOver = pOver >= 0.5;
        const win = (pickOver && over_hits) || (!pickOver && !over_hits);
        if (win) totW += 1;
      }

      // ML
      if (isFiniteNum(model_ml_home)) {
        mlN += 1;
        const home_wins = margin_home > 0;
        const pickHome = model_ml_home >= 0.5;
        const win = (pickHome && home_wins) || (!pickHome && !home_wins);
        if (win) mlW += 1;
      }
    }

    const accuracy = {
      ats: atsN ? (atsW / atsN) : null,
      total: totN ? (totW / totN) : null,
      ml: mlN ? (mlW / mlN) : null
    };

    return ok({ season, n_games: logs.length, accuracy, counts: { atsN, totN, mlN } }, {}, origin);
  } catch (e) {
    return fail(`anchors_backtest:${e.message || e}`, {}, 500, origin);
  }
}

function scorePropRow(row) {
  const line = Number(row.line ?? row.prop_line ?? row.value);
  const projection = Number(row.projection ?? row.model_projection ?? row.proj);
  const price = Number(row.price_american ?? row.odds_american ?? row.price);
  const sideRaw = String(row.side || row.pick || "").toLowerCase();

  if (!Number.isFinite(line) || !Number.isFinite(projection) || !Number.isFinite(price)) {
    return { ...row, model_prob: null, implied_prob: null, edge: null, kelly: 0 };
  }

  const implied_prob = oddsToImplied(price);
  const sigma = Math.max(0.1 * Math.abs(line || projection), 3);

  const z = (line - projection) / sigma;
  let model_prob;
  if (sideRaw === "over" || sideRaw === "more") model_prob = 1 - normalCdf(z);
  else if (sideRaw === "under" || sideRaw === "less") model_prob = normalCdf(z);
  else model_prob = 1 - normalCdf(Math.abs(z));

  const edge = model_prob - implied_prob;
  const kelly = kellyFraction(model_prob, implied_prob);

  return {
    ...row,
    implied_prob: Number(implied_prob.toFixed(4)),
    model_prob: Number(model_prob.toFixed(4)),
    edge: Number(edge.toFixed(4)),
    kelly: Number(kelly.toFixed(4))
  };
}

function scorePropsBatch(rows) {
  return rows.map(scorePropRow);
}

// ========= NFL Props Engine (Elite v1) =========

// Small helpers for props
function pickFirstNum(row, keys, fallback = null) {
  for (const k of keys) {
    if (row[k] == null || row[k] === "") continue;
    const v = Number(row[k]);
    if (Number.isFinite(v)) return v;
  }
  return fallback;
}

function inferPropFamily(row) {
  const raw = String(
    row.market || row.stat || row.category || row.prop || row.type || ""
  ).toLowerCase();

  if (!raw) return null;

  if (raw.includes("pass") && raw.includes("yd")) return "pass_yds";
  if (raw.includes("rush") && raw.includes("yd")) return "rush_yds";
  if ((raw.includes("rec") && raw.includes("yd")) || raw.includes("receiving_yards")) return "rec_yds";
  if (raw.includes("receptions") || raw === "rec") return "receptions";

  if (raw.includes("pass") && raw.includes("td")) return "pass_tds";
  if (raw.includes("rush") && raw.includes("td")) return "rush_tds";
  if ((raw.includes("rec") && raw.includes("td")) || raw.includes("receiving_td")) return "rec_tds";

  return null;
}

function inferRowTeamAbbr(row) {
  // Try direct team, then side-based home/away
  const direct = toTeamAbbr(row.team_abbr || row.team || row.Team || "");
  if (direct) return direct;

  const home = toTeamAbbr(row.home_team || row.home || "");
  const away = toTeamAbbr(row.away_team || row.away || "");

  const sideRaw = String(row.team_side || row.side_team || row.side || "").toLowerCase();
  if (sideRaw === "home" && home) return home;
  if (sideRaw === "away" && away) return away;

  // Fallback: if only one team is present
  if (home && !away) return home;
  if (away && !home) return away;

  return direct || home || away || "";
}

function inferRowOppAbbr(row, teamAbbr) {
  const oppDirect = toTeamAbbr(row.opp_abbr || row.opponent || row.opp || "");
  if (oppDirect) return oppDirect;

  const home = toTeamAbbr(row.home_team || row.home || "");
  const away = toTeamAbbr(row.away_team || row.away || "");

  const t = String(teamAbbr || "").toUpperCase();
  if (t && home && away) {
    if (t === home) return away;
    if (t === away) return home;
  }

  return oppDirect || "";
}

function buildNflPropBaseline(row, family) {
  if (!family) return { baseline: null, source: "unknown" };

  // Yardage baselines
  if (family === "pass_yds") {
    const v = pickFirstNum(row, [
      "proj_pass_yds",
      "model_pass_yds",
      "pass_yds_pg",
      "passing_yards_pg",
      "ss_passing_yards_per_game"
    ]);
    return { baseline: v, source: "pass_pg" };
  }

  if (family === "rush_yds") {
    const v = pickFirstNum(row, [
      "proj_rush_yds",
      "model_rush_yds",
      "rush_yds_pg",
      "rushing_yards_pg",
      "ss_rushing_yards_per_game"
    ]);
    return { baseline: v, source: "rush_pg" };
  }

  if (family === "rec_yds") {
    const v = pickFirstNum(row, [
      "proj_rec_yds",
      "model_rec_yds",
      "rec_yds_pg",
      "receiving_yards_pg",
      "ss_receiving_yards_per_game"
    ]);
    return { baseline: v, source: "rec_pg" };
  }

  if (family === "receptions") {
    const v = pickFirstNum(row, [
      "proj_receptions",
      "receptions_pg",
      "rec_pg",
      "ss_receptions_per_game"
    ]);
    return { baseline: v, source: "receptions_pg" };
  }

  // TD baselines (per game)
  if (family === "pass_tds") {
    const v = pickFirstNum(row, [
      "proj_pass_tds",
      "pass_tds_pg",
      "passing_tds_pg",
      "ss_passing_tds_per_game"
    ]);
    return { baseline: v, source: "pass_tds_pg" };
  }

  if (family === "rush_tds") {
    const v = pickFirstNum(row, [
      "proj_rush_tds",
      "rush_tds_pg",
      "rushing_tds_pg",
      "ss_rushing_tds_per_game"
    ]);
    return { baseline: v, source: "rush_tds_pg" };
  }

  if (family === "rec_tds") {
    const v = pickFirstNum(row, [
      "proj_rec_tds",
      "rec_tds_pg",
      "receiving_tds_pg",
      "ss_receiving_tds_per_game"
    ]);
    return { baseline: v, source: "rec_tds_pg" };
  }

  return { baseline: null, source: "unknown" };
}

function buildNflPropAdjustments({ family, baseline, teamStats, oppStats }) {
  const t = teamStats || {};
  const o = oppStats || {};

  const paceTeam = num(t.pace_plays60, 62);
  const paceOpp  = num(o.pace_plays60, 62);
  const paceFactor = clamp(((paceTeam + paceOpp) / 2) / 62, 0.85, 1.15);

  const defEpa = num(o.def_epa_play, 0);
  let defAdj = 1.0;
  if (defEpa > 0) {
    defAdj += clamp(defEpa * 3.0, 0, 0.25); // bad defense → boost
  } else if (defEpa < 0) {
    defAdj -= clamp(-defEpa * 3.0, 0, 0.25); // good defense → cut
  }

  let rzAdj = 1.0;
  if (family && family.endsWith("tds")) {
    const rzOff = num(t.redzone_td_rate_off, 0.55);
    const rzDef = num(o.redzone_td_rate_def, 0.55);

    const rzOffDiff = rzOff - 0.55;
    const rzDefDiff = 0.55 - rzDef;

    rzAdj += clamp((rzOffDiff + rzDefDiff) * 1.2, -0.25, 0.25);
  }

  // Script-lite: use EPA diff to tilt pass vs rush a bit
  let scriptAdj = 1.0;
  const offEpa  = num(t.off_epa_play, 0);
  const oppEpa  = num(o.off_epa_play, 0);
  const epaDiff = offEpa - oppEpa;

  if (Math.abs(epaDiff) > 0.05) {
    const tilt = clamp(epaDiff * 2.5, -0.20, 0.20);

    if (family === "pass_yds" || family === "rec_yds" || family === "receptions") {
      scriptAdj += tilt; // better offense vs opp → more passing volume
    }
    if (family === "rush_yds" || family === "rush_tds") {
      scriptAdj -= tilt * 0.5; // strong pass edge → slightly less pure rush lean
    }
  }

  return {
    paceFactor,
    defAdj,
    rzAdj,
    scriptAdj
  };
}

function computeNflPropQuality({ hasBaseline, hasTeam, hasOpp, usedContext }) {
  let score = 0;

  if (hasBaseline) score += 0.5;
  if (hasTeam)     score += 0.2;
  if (hasOpp)      score += 0.2;
  if (usedContext) score += 0.1;

  const tier =
    score >= 0.85 ? "elite" :
    score >= 0.70 ? "high" :
    score >= 0.50 ? "medium" :
    score >= 0.30 ? "low" : "poor";

  return { tier, score };
}

async function buildNflPropsEngine(env, { season, week, rows }) {
  const seasonNum = Number(season || nflSeasonFromDate(new Date()));
  const weekVal   = week ?? null;

  const teamCache = new Map();

  async function getTeamNorm(abbr) {
    const t = String(abbr || "").toUpperCase();
    if (!t) return null;
    const key = `${seasonNum}:${weekVal ?? "ALL"}:${t}`;
    if (teamCache.has(key)) return teamCache.get(key);

    const raw = await getTeamStats(env, { season: seasonNum, week: weekVal, team: t });
    if (!raw) {
      teamCache.set(key, null);
      return null;
    }
    const normed = normalizeTeamStats(raw.stats || raw);
    teamCache.set(key, normed);
    return normed;
  }

  const out = [];

  for (const row of rows) {
    const family      = inferPropFamily(row);
    const line        = Number(row.line ?? row.prop_line ?? row.value);
    const explicitProj = Number(row.projection ?? row.model_projection ?? row.proj);

    const teamAbbr = inferRowTeamAbbr(row);
    const oppAbbr  = inferRowOppAbbr(row, teamAbbr);

    const hasExplicitProj = Number.isFinite(explicitProj);
    let baselineInfo = { baseline: null, source: "none" };

    if (!hasExplicitProj) {
      baselineInfo = buildNflPropBaseline(row, family);
    }

    const baseline = hasExplicitProj ? explicitProj : baselineInfo.baseline;

    const teamStats = teamAbbr ? await getTeamNorm(teamAbbr) : null;
    const oppStats  = oppAbbr  ? await getTeamNorm(oppAbbr)  : null;

    const hasBaseline = Number.isFinite(baseline);
    const hasTeam     = !!teamStats;
    const hasOpp      = !!oppStats;

    let projection = baseline;
    let adjMeta = null;
    let usedContext = false;

    if (hasBaseline && (teamStats || oppStats)) {
      const adj = buildNflPropAdjustments({
        family,
        baseline,
        teamStats,
        oppStats
      });

      const paceAdj   = adj.paceFactor;
      const defAdj    = adj.defAdj;
      const rzAdj     = adj.rzAdj;
      const scriptAdj = adj.scriptAdj;

      let multiplier = paceAdj * defAdj * scriptAdj;
      if (family && family.endsWith("tds")) {
        multiplier *= rzAdj;
      }

      projection = baseline * multiplier;
      usedContext = true;

      adjMeta = {
        pace_factor: paceAdj,
        def_adj: defAdj,
        rz_adj: rzAdj,
        script_adj: scriptAdj,
        multiplier
      };
    }

    // If we STILL don't have projection, fall back to line (zero-edge anchor)
    if (!Number.isFinite(projection) && Number.isFinite(line)) {
      projection = line;
    }

    const quality = computeNflPropQuality({
      hasBaseline,
      hasTeam,
      hasOpp,
      usedContext
    });

    const scored = scorePropRow({
      ...row,
      line,
      projection
    });

    out.push({
      ...scored,
      sport: row.sport || "nfl",
      league: row.league || "NFL",
      season: seasonNum,
      week: weekVal,
      team_abbr: teamAbbr || row.team_abbr || row.team || null,
      opp_abbr: oppAbbr || row.opp_abbr || row.opponent || null,
      prop_family: family,
      projection_source: hasExplicitProj ? "explicit" : baselineInfo.source,
      projection_base: baseline,
      projection_final: projection,
      projection_context: adjMeta,
      prop_quality: quality
    });
  }

  return {
    season: seasonNum,
    week: weekVal,
    count: out.length,
    rows: out
  };
}

// POST /props/nfl/sim  { season?, week?, rows:[...] }
async function handleNflPropsSim(req, env, origin) {
  try {
    const body  = await readJson(req);
    const rows  = Array.isArray(body.rows) ? body.rows : [];
    const season = body.season || nflSeasonFromDate(new Date());
    const week   = body.week ?? null;

    if (!rows.length) {
      return fail("nfl_props_sim:no_rows", {}, 400, origin);
    }

    const result = await buildNflPropsEngine(env, { season, week, rows });

    // Cache last slate under a separate key so we don’t collide with generic props
    await saveLastSlate(env, "props_nfl", result.rows);

    return ok(result, {}, origin);
  } catch (e) {
    return fail(`nfl_props_sim:${e.message || e}`, {}, 400, origin);
  }
}

// ========= Last slate cache =========
const LAST_SLATE_TTL = 6 * 3600;

async function saveLastSlate(env, kind, rows) {
  const key = `brain:v1:nfl:last-slate:${kind}`;
  await kvPut(env, key, { kind, rows }, LAST_SLATE_TTL);
  return { key, kind, count: rows.length };
}

async function getLastSlate(env, kind = "props") {
  const key = `brain:v1:nfl:last-slate:${kind}`;
  return kvGet(env, key);
}

// ========= Handlers =========
async function handleHealth(req, env, origin) {
  return ok(
    {
      now: new Date().toISOString(),
      sport: SPORT,
      routes: [
        "/health",
        "/game-lines",
        "/teams/ingest",
        "/teams/get",
        "/injuries/ingest",
        "/matchup/sim",
        "/edges/games",
        "/anchors/nfl",
        "/anchors/rows",
        "/props",
        "/props/cache",
        "/ingest",
        "/score",
        "/props/sim",
        "/csv/sim",
        "/teams/export.csv",
        "/props/export.csv",
        "/predict",
        "/debug/elite-team",
        "/debug/elite-matchup",
        "/cal/ingest",
        "/cal/summary",
        "/cal/rebuild-lines-v2",
        "/cal/set",
        "/cal/game/log",
        "/cal/game/list"
      ]
    },
    {},
    origin
  );
}

async function handleGameLinesGet(req, env, origin) {
  try {
    const data = await getGameLines(env);
    return ok({ sport: SPORT, events: data }, {}, origin);
  } catch (e) {
    return fail(`game_lines:${e.message || e}`, {}, 500, origin);
  }
}

// Full name -> abbr map (lowercase keys)
const TEAM_FULL_TO_ABBR = {
  "arizona cardinals": "ARI",
  "atlanta falcons": "ATL",
  "baltimore ravens": "BAL",
  "buffalo bills": "BUF",
  "carolina panthers": "CAR",
  "chicago bears": "CHI",
  "cincinnati bengals": "CIN",
  "cleveland browns": "CLE",
  "dallas cowboys": "DAL",
  "denver broncos": "DEN",
  "detroit lions": "DET",
  "green bay packers": "GB",
  "houston texans": "HOU",
  "indianapolis colts": "IND",
  "jacksonville jaguars": "JAX",
  "kansas city chiefs": "KC",
  "las vegas raiders": "LV",
  "los angeles chargers": "LAC",
  "los angeles rams": "LAR",
  "miami dolphins": "MIA",
  "minnesota vikings": "MIN",
  "new england patriots": "NE",
  "new orleans saints": "NO",
  "new york giants": "NYG",
  "new york jets": "NYJ",
  "philadelphia eagles": "PHI",
  "pittsburgh steelers": "PIT",
  "san francisco 49ers": "SF",
  "seattle seahawks": "SEA",
  "tampa bay buccaneers": "TB",
  "tennessee titans": "TEN",
  "washington commanders": "WAS",
};

// Convert anything team-ish -> abbr
function toTeamAbbr(raw) {
  if (!raw) return "";

  const s = String(raw).trim();
  if (!s) return "";

  // Already looks like an abbr
  const up = s.toUpperCase();
  if (up.length <= 4 && /^[A-Z]+$/.test(up)) return up;

  // Try your existing Odds/API name mapper first
  const fromOddsName = teamNameToAbbr(s);
  if (fromOddsName) return fromOddsName;

  // Try full-name map
  const k = s.toLowerCase();
  if (TEAM_FULL_TO_ABBR[k]) return TEAM_FULL_TO_ABBR[k];

  return "";
}

// POST /teams/ingest  (CSV or JSON; supports bulk JSON)
async function handleTeamStatsIngest(req, env, origin) {
  const url = new URL(req.url);
  const warnings = [];
  const seasonDefault = Number(url.searchParams.get("season") || nflSeasonFromDate(new Date()));
  const weekDefault = url.searchParams.get("week") || null;
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  const isMultipart = ctype.includes("multipart/form-data");
  const isCsvLike = isMultipart || ctype.includes("text/csv") || ctype.includes("text/plain") || ctype.includes("application/octet-stream");

  // Patch mode: add-on without wiping base
  const mergeRaw = String(url.searchParams.get("merge") || "").toLowerCase();
  const merge = ["1", "true", "yes", "on"].includes(mergeRaw);

  // ✅ Guardrails / debug-friendly diagnostics
  const guardMeta = {
    ctype,
    merge,
    seasonDefault,
    weekDefault
  };

  const safeNormalizeTeamStats = (obj, teamTag) => {
    try {
      return normalizeTeamStats(obj || {});
    } catch (e) {
      const msg = String((e && e.message) || e || 'unknown_error');
      warnings.push({ team: teamTag || null, error: msg });
      try {
        const base = normalizeTeamStats({});
        if (base && typeof base === 'object') {
          base.extras = { ...(base.extras || {}), ingest_error: msg };
          const du = Array.isArray(base.extras.defaults_used) ? base.extras.defaults_used : [];
          base.extras.defaults_used = Array.from(new Set([...du, 'ingest_error']));
        }
        return base;
      } catch (_) {
        return {};
      }
    }
  };


  try {
    let teams = [];
    let patched_keys = {};

    // ---------- CSV ingest (tolerant: text/csv OR multipart form-data OR raw text) ----------
    if (isCsvLike) {
      let text = "";
      // 1) If UI sends FormData, Cloudflare will mark content-type as multipart/form-data; read the file safely.
      if (ctype.includes("multipart/form-data")) {
        const fd = await req.formData();
        // try common keys first, else take the first File
        const maybe = fd.get("file") || fd.get("csv") || fd.get("upload") || fd.get("teams") || null;
        let file = (maybe && typeof maybe === "object" && "text" in maybe) ? maybe : null;
        if (!file) {
          for (const v of fd.values()) {
            if (v && typeof v === "object" && "text" in v) { file = v; break; }
          }
        }
        if (!file) return fail("teamstats_ingest:no_file_in_formdata", guardMeta, 400, origin);
        text = await file.text();
      } else {
        // 2) Otherwise just read raw body as text (works for text/csv and many browsers/tools)
        text = await req.text();
      }
      let rows = parseCsvLight(text);
      if (!rows.length) return fail("teamstats_ingest:no_rows", guardMeta, 400, origin);
      // Hard guardrail: don't poison KV with defaults if parsing is wrong
      const _teamsSeen = Array.from(new Set(rows.map(r => String(r.team_abbr || r.team || r.Team || "").toUpperCase()).filter(Boolean)));
      if (_teamsSeen.length && _teamsSeen.length < 28) {
        guardMeta.teams_seen = _teamsSeen.length;
        guardMeta.teams_preview = _teamsSeen.slice(0, 10);
        return fail("teamstats_ingest:too_few_teams_parsed", guardMeta, 400, origin);
      }

      // Normalize team identity early (handles full names)
      rows = rows.map(r => {
        const teamRaw = r.team_abbr || r.team || r.TEAM || r.Team || "";
        const abbr = toTeamAbbr(teamRaw);
        return abbr ? { ...r, team_abbr: abbr } : r;
      });

      const first = rows[0] || {};
const keySet = new Set(Object.keys(first).map(k => String(k).toLowerCase()));

const isSumerLong =
  keySet.has("section") &&
  keySet.has("metric") &&
  (keySet.has("value") || keySet.has("values"));


      // --- Sumer long CSV ---
      if (isSumerLong) {
        const bundles = buildSumerTeamStats(rows, seasonDefault, weekDefault);
        if (!bundles.length) {
          return fail("teamstats_ingest:sumer_long_no_teams", guardMeta, 400, origin);
        }

        for (const b of bundles) {
          if (merge) {
            const existing = await getTeamStats(env, { season: b.season, week: b.week, team: b.team });
            const base = existing?.stats || existing || {};
            const nextStats = safeNormalizeTeamStats({ ...base, ...(b.stats || {}) }, b.team);

            await saveTeamStats(env, { season: b.season, week: b.week, team: b.team, stats: nextStats, raw_dotted: null, raw_nested: null, source: "csv_long" });

            patched_keys[b.team] = Object.keys(b.stats || {});
          } else {
            await saveTeamStats(env, { ...b, raw_dotted: null, raw_nested: null, source: "csv_long" });
          }

          teams.push(b.team);
        }
      }
      // --- Simple 1-row-per-team CSV ---
      else {
        for (const row of rows) {
          const teamRaw = row.team_abbr || row.team || row.TEAM || row.Team || "";
          const abbr = toTeamAbbr(teamRaw);
          if (!abbr) continue;

          const norm = normalizeTeamCsvRow({ ...row, team_abbr: abbr }, seasonDefault, weekDefault);
          if (!norm) continue;

          // ✅ Ensure season/week are defined for this row (prevents ReferenceError in wide CSV ingest)
          const season = Number(norm.season ?? seasonDefault);
          const week = (norm.week ?? weekDefault ?? null);
          // --- Merge vs Replace behavior (merge=true keeps existing KV stats and overlays incoming)
          // Build normalized core stats from this CSV row (and keep raw dotted/nested if present)
          const incomingNorm = safeNormalizeTeamStats(norm.stats || {}, abbr);
          // NOTE: normalizeTeamStats() returns the *core* object (pace_plays60, off_epa_play, etc) — not {core:...}.
          // Older versions returned { core }, so we support both shapes safely.
          const coreCandidate =
            (incomingNorm && typeof incomingNorm === "object" && incomingNorm.core && typeof incomingNorm.core === "object")
              ? incomingNorm.core
              : incomingNorm;

          // Raw payloads (for audit / UI)
          let raw_dotted = (incomingNorm && incomingNorm.raw_dotted) || (norm.meta && norm.meta.raw_dotted) || null;
          let raw_nested = (incomingNorm && incomingNorm.raw_nested) || (norm.meta && norm.meta.raw_nested) || null;

          // Build a "present keys" set so merge uploads don't zero-out fields that weren't included in the CSV.
          const present = new Set();
          for (const [k, v] of Object.entries(row || {})) {
            const kk = String(k || "").trim();
            const vv = (v === null || v === undefined) ? "" : String(v).trim();
            if (!kk) continue;
            if (vv !== "") present.add(kk);
          }
          const presentNorm = new Set();
          for (const k of present) presentNorm.add(String(k).trim().toLowerCase());

          const allowOverride = (field) => {
            // Accept either flat or dotted headers, case-insensitive.
            const has = (name) => presentNorm.has(String(name).toLowerCase());
            switch (field) {
              case "pace_plays60": return has("pace_plays60") || has("pace.plays_per_game_off") || has("pace.pace_plays60") || has("plays_per_game_off");
              case "pass_rate": return has("pass_rate") || has("tendencies.pass_rate_off") || has("pass_rate_off");
              case "off_epa_play": return has("off_epa_play") || has("efficiency.off_epa_play");
              case "def_epa_play": return has("def_epa_play") || has("efficiency.def_epa_play");
              case "yards_per_play": return has("yards_per_play") || has("yards_per_play_off") || has("efficiency.yards_per_play_off");
              case "points_per_drive": return has("points_per_drive") || has("points_per_drive_off") || has("efficiency.points_per_drive_off");
              case "down_conversion_rate": return has("down_conversion_rate") || has("third_down_conv_rate_off") || has("conversion.third_down_conv_rate_off");
              case "takeaways_per_game": return has("takeaways_per_game") || has("turnovers.takeaways_per_game");
              case "giveaways_per_game": return has("giveaways_per_game") || has("turnovers.giveaways_per_game");
              case "penalties_per_game": return has("penalties_per_game") || has("penalties.penalties_per_game");
              case "redzone_td_rate_off": return has("redzone_td_rate_off") || has("redzone.redzone_td_rate_off");
              case "redzone_td_rate_def": return has("redzone_td_rate_def") || has("redzone.redzone_td_rate_def");
              case "pressure_rate": return has("pressure_rate") || has("pass.pressure_rate_allowed_off") || has("pass.pressure_rate_def");
              case "def_success": return has("def_success") || has("def_success_rate") || has("efficiency.def_success_rate");
              case "sack_rate_allowed": return has("sack_rate_allowed") || has("pass.sack_rate_taken_off");
              case "explosive_play_rate": return has("explosive_play_rate") || has("explosives.explosive_efficiency_off") || has("explosive_efficiency_off");
              default: return true; // non-core extras can override
            }
          };

          if (merge) {
            const existing = await getTeamStats(env, { season, week, team: norm.team });
            const base = (existing && existing.stats) ? existing.stats : (existing || {});

            const patch = {};
            for (const [k, v] of Object.entries(coreCandidate || {})) {
              if (!allowOverride(k)) continue; // don't wipe fields that weren't present in this CSV
              patch[k] = v;
            }

            const mergedCore = { ...(base || {}), ...(patch || {}) };
            const mergedRawDotted = raw_dotted || (existing && existing.raw_dotted) || null;
            const mergedRawNested = raw_nested || (existing && existing.raw_nested) || null;

            // Re-normalize to keep defaults/guards consistent (returns core object)
            const nextCore = normalizeTeamStats(mergedCore);

            await saveTeamStats(env, {
              season, week, team: norm.team,
              stats: nextCore || mergedCore,
              raw_dotted: mergedRawDotted,
              raw_nested: mergedRawNested,
              asOf: new Date().toISOString(),
            });

            patched_keys[norm.team] = Object.keys(nextCore || mergedCore);
          } else {
            await saveTeamStats(env, {
              season, week, team: norm.team,
              stats: coreCandidate || {},
              raw_dotted,
              raw_nested,
              asOf: new Date().toISOString(),
            });
            patched_keys[norm.team] = Object.keys(coreCandidate || {});
          }

          teams.push(norm.team);
        }
      }
    }

    // ---------- JSON ingest ----------
    else {
      const body = await readJson(req);

      let items = [];
      if (Array.isArray(body)) items = body;
      else if (Array.isArray(body.items)) items = body.items;
      else if (Array.isArray(body.rows)) items = body.rows;
      else if (body && typeof body === "object") items = [body];

      if (!items.length) return fail("teamstats_ingest:no_items", guardMeta, 400, origin);

      for (const it of items) {
        if (!it || typeof it !== "object") continue;

        const teamRaw = it.team || it.team_abbr || it.TEAM || it.Team;
        const team = toTeamAbbr(teamRaw);
        if (!team) continue;

        const season = Number(it.season || seasonDefault);
        const week   = it.week ?? weekDefault;

        // ✅ Support patch-like shapes explicitly:
        // { team, season, patch:{...} }
        // { team, season, stats_patch:{...} }
        // { team, season, stats:{...} }
        const patch =
          it.patch ||
          it.stats_patch ||
          it.stats ||
          it;

        let stats;

        if (merge) {
          const existing = await getTeamStats(env, { season, week, team });
          const base = existing?.stats || existing || {};
          stats = normalizeTeamStats({ ...base, ...patch });
        } else {
          // Non-merge expects it.stats or the object itself
          stats = normalizeTeamStats(it.stats || it);
        }

        await saveTeamStats(env, { season, week, team, stats, raw_dotted: flattenToDotted(it), raw_nested: it, source: "json" });

        teams.push(String(team).toUpperCase());
        patched_keys[String(team).toUpperCase()] = Object.keys(patch || {});
      }
    }

    teams = Array.from(new Set(teams));
    if (warnings.length) {
      guardMeta.warnings = warnings.slice(0, 100);
      guardMeta.warnings_count = warnings.length;
    }

    if (!teams.length) return fail("teamstats_ingest:no_saved_teams", guardMeta, 400, origin);

    return ok(
      {
        season: seasonDefault,
        week: weekDefault,
        saved_count: teams.length,
        teams,
        merge,
        patched_keys
      },
      guardMeta,
      origin
    );
  } catch (e) {
    return fail(`teamstats_ingest:${e.message || e}`, guardMeta, 400, origin);
  }
}

// POST /teams/upload  (multipart or raw text/csv)
async function handleTeamsUpload(req, env, origin) {
  const url = new URL(req.url);
  const ctype = (req.headers.get("content-type") || "").toLowerCase();

  const season = url.searchParams.get("season") || "";
  let week = url.searchParams.get("week");
  if (week === undefined || week === "") week = null;
  if (week && String(week).toLowerCase() === "all") week = null;

  const mergeRaw = String(url.searchParams.get("merge") || "").toLowerCase();
  const merge = ["1", "true", "yes", "on"].includes(mergeRaw);

  const guardMeta = { ctype, season, week, merge, mode: "teams_upload" };

  try {
    let csvText = "";

    if (ctype.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");

      if (!file) {
        return fail("teams_upload:missing_file_field", guardMeta, 400, origin);
      }

      csvText = typeof file.text === "function" ? await file.text() : String(file || "");
    } else {
      csvText = await req.text();
    }

    csvText = String(csvText || "").trim();
    if (!csvText) {
      return fail("teams_upload:no_csv_body", guardMeta, 400, origin);
    }

    const ingestUrl = new URL(req.url);
    ingestUrl.pathname = "/teams/ingest";

    if (season) ingestUrl.searchParams.set("season", season);
    if (week) ingestUrl.searchParams.set("week", week);
    if (merge) ingestUrl.searchParams.set("merge", "true");

    const ingestReq = new Request(ingestUrl.toString(), {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: csvText
    });

    return handleTeamStatsIngest(ingestReq, env, origin);
  } catch (e) {
    return fail(`teams_upload:${e.message || e}`, guardMeta, 400, origin);
  }
}

// GET /teams/get

// GET /teams/audit
// Returns missing/default-like core fields and (optionally) unmapped raw keys per team.
// Query:
//   season=2025 (required)
//   week=17 (optional; if omitted uses ALL fallback behavior)
//   teams=TB,ATL (optional; default: all 32)
//   include_raw=1 (optional; include raw key counts + sample unmapped keys)
//   tol=0.0005 (optional; default tolerance for "default-like" comparisons)
const NFL_TEAM_ABBRS = [
  "ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB","HOU","IND","JAX","KC",
  "LAC","LAR","LV","MIA","MIN","NE","NO","NYG","NYJ","PHI","PIT","SEA","SF","TB","TEN","WAS"
];

function _toNum(v) {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function _isMissing(v) {
  const n = _toNum(v);
  return n === null;
}

function _approxEq(a, b, tol) {
  const na = _toNum(a);
  const nb = _toNum(b);
  if (na === null || nb === null) return false;
  return Math.abs(na - nb) <= tol;
}

function _defaultMap() {
  // Keep in sync with defaultTeamStats()
  return defaultTeamStats();
}

async function handleTeamsAudit(req, env, origin) {
  const url = new URL(req.url);
  const season = url.searchParams.get("season") || "";
  let week = url.searchParams.get("week");
  if (week === undefined || week === "") week = null;
  if (week && String(week).toLowerCase() === "all") week = null;

  const includeRaw = ["1","true","yes","on"].includes(String(url.searchParams.get("include_raw") || "").toLowerCase());

const includeSplits = url.searchParams.get("include_splits") === "1" || url.searchParams.get("splits") === "1";
  const tol = _toNum(url.searchParams.get("tol")) ?? 0.0005;

  const teamsParam = (url.searchParams.get("teams") || "").trim();
  const teams = teamsParam
    ? teamsParam.split(",").map(s => normalizeTeamAbbr(s.trim())).filter(Boolean)
    : NFL_TEAM_ABBRS.slice();

  if (!season) {
    return jsonResponse(400, { ok:false, data:null, error:"season is required" }, origin);
  }

  const defaults = _defaultMap();
  const results = [];
  let missingTeams = 0;

  for (const t of teams) {
    const rec = await getTeamStats(env, { season, week, team: t });
    if (!rec || !rec.stats) {
      missingTeams++;
      results.push({ team: t, found:false, missing_core: CORE_KEYS.slice(), default_like: [], notes:["teamstats_missing"] });
      continue;
    }

    const s = rec.stats;
    const missing_core = [];
    const default_like = [];

    for (const k of CORE_KEYS) {
      if (_isMissing(s[k])) missing_core.push(k);
      else if (_approxEq(s[k], defaults[k], tol)) default_like.push(k);
    }

    const row = {
      team: t,
      found: true,
      missing_core,
      default_like,
      used_defaults: !!(rec.quality && rec.quality.used_defaults),
      tier: rec.quality ? rec.quality.tier : null,
      confidence: rec.quality ? rec.quality.confidence_score : null
    };

    if (includeRaw) {
      // Provide raw coverage insight if present
      const raw = rec.raw_dotted || rec.raw_nested || null;
      if (raw && typeof raw === "object") {
        const keys = Object.keys(raw);
        // Heuristic: "unmapped" = keys not in CORE_KEYS and not in known dotted groups that we already ingest into extras
        const known = new Set(CORE_KEYS);
        // dotted raw keys may include canonical dotted names; keep them visible
        const unmapped = keys.filter(k => !known.has(k));
        row.raw_key_count = keys.length;
        row.unmapped_key_count = unmapped.length;
        row.unmapped_key_sample = unmapped.slice(0, 30);
      } else {
        row.raw_key_count = 0;
        row.unmapped_key_count = 0;
        row.unmapped_key_sample = [];
      }
    }

    results.push(row);
  }

  // Summary
  const totals = {
    season: parseInt(season, 10) || season,
    week,
    teams_requested: teams.length,
    teams_missing: missingTeams,
    teams_found: teams.length - missingTeams,
    tol
  };

  // High-level rollups
  const missCountByKey = {};
  const defaultCountByKey = {};
  for (const r of results) {
    if (!r.found) continue;
    for (const k of (r.missing_core || [])) missCountByKey[k] = (missCountByKey[k] || 0) + 1;
    for (const k of (r.default_like || [])) defaultCountByKey[k] = (defaultCountByKey[k] || 0) + 1;
  }

  return jsonResponse(200, {
    ok: true,
    data: {
      ...totals,
      missCountByKey,
      defaultCountByKey,
      results
    },
    error: null
  }, origin);
}



async function handleStatsRegistry(req, env, origin) {
  const url = new URL(req.url);
  const include = (url.searchParams.get("include") || "").trim();
  const season = url.searchParams.get("season") || "";
  let week = url.searchParams.get("week");
  if (week === undefined || week === "") week = null;
  if (week && String(week).toLowerCase() === "all") week = null;
  const team = normalizeTeamAbbr(url.searchParams.get("team") || url.searchParams.get("abbr") || "");

  // include=core -> CORE_KEYS only
  if (include && include.toLowerCase() === "core") {
    const out = {};
    for (const k of CORE_KEYS) if (STAT_REGISTRY[k]) out[k] = STAT_REGISTRY[k];
    return jsonResponse(200, { ok:true, data:{ registry: out, count:Object.keys(out).length }, error:null }, origin);
  }

  // Default registry: static core + known extras
  let registry = { ...STAT_REGISTRY };

  // If a team is provided, enrich with all raw_dotted keys so every stat is weightable.
  if (season && team) {
    const rec = await getTeamStats(env, { season, week, team });
    if (rec && rec.raw_dotted) {
      const dyn = buildDynamicRegistryFromRaw(rec.raw_dotted);
      registry = { ...registry, ...dyn };
    }
  }

  return jsonResponse(200, { ok:true, data:{ registry, count:Object.keys(registry).length }, error:null }, origin);
}


async function handleStatsWeightsGet(req, env, origin) {
  const url = new URL(req.url);
  const season = url.searchParams.get("season");
  let week = url.searchParams.get("week");
  if (week === undefined || week === "") week = null;
  if (week && String(week).toLowerCase() === "all") week = null;
  const name = url.searchParams.get("name") || "default";
  if (!season) return jsonResponse(400, { ok:false, data:null, error:"season is required" }, origin);

  const rec = await loadWeights(env, { season, week, name });
  return jsonResponse(200, { ok:true, data: rec, error:null }, origin);
}

async function handleStatsWeightsPost(req, env, origin) {
  const url = new URL(req.url);
  const body = await readJson(req);
  const season = body?.season ?? url.searchParams.get("season");
  let week = body?.week ?? url.searchParams.get("week");
  if (week === undefined || week === "") week = null;
  if (week && String(week).toLowerCase() === "all") week = null;
  const name = body?.name ?? url.searchParams.get("name") ?? "default";
  const weights = body?.weights ?? body?.cal ?? body ?? null;

  if (!season) return jsonResponse(400, { ok:false, data:null, error:"season is required" }, origin);
  if (!weights || typeof weights !== "object") return jsonResponse(400, { ok:false, data:null, error:"weights object is required" }, origin);

  const saved = await saveWeights(env, { season, week, name, weights });
  return jsonResponse(200, { ok:true, data: saved, error:null }, origin);
}


async function handleTeamsFeatures(req, env, origin) {
  const url = new URL(req.url);
  const season = url.searchParams.get("season") || "";
  let week = url.searchParams.get("week");
  if (week === undefined || week === "") week = null;
  if (week && String(week).toLowerCase() === "all") week = null;

  const team = normalizeTeamAbbr(url.searchParams.get("team") || url.searchParams.get("abbr") || "");
  const weightsName = url.searchParams.get("weights") || url.searchParams.get("name") || "default";
  const only = (url.searchParams.get("only") || "").trim(); // comma list of stat ids
  const includeRaw = ["1","true","yes","on"].includes(String(url.searchParams.get("include_raw") || "").toLowerCase());
  const include = (url.searchParams.get("include") || "all").toLowerCase(); // all|core
  const maxRows = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "350", 10) || 350, 10), 2000);

  if (!season || !team) return jsonResponse(400, { ok:false, data:null, error:"season and team are required" }, origin);

  const rec = await getTeamStats(env, { season, week, team });
  if (!rec) return jsonResponse(404, { ok:false, data:null, error:"teamstats_not_found" }, origin);

  const wrec = await loadWeights(env, { season, week, name: weightsName });
  const W = (wrec?.weights && typeof wrec.weights === "object") ? wrec.weights : {};
  const multAll = _asFloat(W["mult"]) ?? 1.0;

  // Build the id list
  let ids = [];
  if (only) {
    ids = only.split(",").map(s=>s.trim()).filter(Boolean);
  } else {
    if (include === "core") {
      ids = [...CORE_KEYS];
    } else {
      const rawKeys = rec.raw_dotted ? Object.keys(rec.raw_dotted).filter(k => k && k.includes(".") && k !== "team" && k !== "team_abbr") : [];
      ids = [...new Set([...CORE_KEYS, ...rawKeys])];
    }
  }

  // Dynamic registry for this team (core + all raw)
  const dyn = rec.raw_dotted ? buildDynamicRegistryFromRaw(rec.raw_dotted) : {};
  const REG = { ...STAT_REGISTRY, ...dyn };

  const rows = [];
  for (const id of ids) {
    const def = REG[id];
    if (!def) continue;

    // value resolution
    let value = null;
    let source = null;
    let defaulted = false;

    // Core ids resolve from rec.stats via computeFeatureValue()
    if (STAT_REGISTRY[id] && !id.includes(".")) {
      const fv = computeFeatureValue(rec, id);
      value = fv.value;
      source = fv.source;
      defaulted = fv.defaulted;
    } else {
      // Raw dotted id resolves from raw_dotted
      value = parseAnyNumber(rec.raw_dotted?.[id]);
      source = id;
      defaulted = (value === null || value === undefined);
    }

    const z = standardizeDynamic(id, (value == null ? null : Number(value)), def);

    // weights: per-stat overrides group
    const wStat = _asFloat(W[id]);
    const wGroup = _asFloat(W["group."+ (def.group || inferGroupFromStatId(id)) ]);
    const weight = (wStat != null ? wStat : (wGroup != null ? wGroup : 0));
    const contrib = (z != null && weight != null) ? z * weight * multAll : null;

    rows.push({
      stat_id: id,
      group: def.group || inferGroupFromStatId(id),
      value,
      z,
      weight,
      contribution: contrib,
      defaulted,
      source,
      desc: def.desc || null
    });

    if (rows.length >= maxRows) break;
  }

  const score = rows.reduce((a,r)=>a + (r.contribution ?? 0), 0);

  const data = {
    season: Number(season),
    week: week ?? null,
    team,
    weights_name: weightsName,
    weights_key: wrec?.key ?? null,
    mult: multAll,
    score,
    features: rows
  };

  if (includeRaw) data.raw_dotted = rec.raw_dotted ?? null;

  return jsonResponse(200, { ok:true, data, error:null }, origin);
}


async function handleTeamStatsGet(req, env, origin) {
  const url = new URL(req.url);
  const season = Number(url.searchParams.get("season"));
  let week = url.searchParams.get("week");
  const team = url.searchParams.get("team") || url.searchParams.get("abbr") || "";

  if (week === undefined || week === "") week = null;

  if (!season || !team) {
    return fail("teamstats_get:missing_params", { season, week, team }, 400, origin);
  }

  const payload = await getTeamStats(env, { season, week, team });
  if (!payload) return fail("teamstats_get:not_found", {}, 404, origin);

const format = String(url.searchParams.get("format") || "brain").toLowerCase(); // brain | canonical | both
const includeRaw = url.searchParams.get("include_raw") === "1" || url.searchParams.get("raw") === "1";
const includeSplits = url.searchParams.get("include_splits") === "1" || url.searchParams.get("include_splits") === "true" || url.searchParams.get("includeSplits") === "1" || url.searchParams.get("includeSplits") === "true" || url.searchParams.get("splits") === "1";

const base = payload.stats || payload;
const normed = normalizeTeamStats(base);
const audit = validateEliteTeamStats(normed);

// canonical view: prefer raw_nested (JSON uploads), else reconstruct from raw_dotted (CSV uploads)
const canonical = (() => {
  if (payload.raw_nested && typeof payload.raw_nested === "object") return payload.raw_nested;
  const dotted = payload.raw_dotted && typeof payload.raw_dotted === "object" ? payload.raw_dotted : {};
  const nested = undotToNested(dotted);
  return { team: payload.team, ...nested };
})();

if (format === "canonical") {
  return ok(
    includeRaw ? { ...payload, canonical } : { season: payload.season, week: payload.week, team: payload.team, canonical },
    {},
    origin
  );
}

if (format === "both") {
  return ok(
    includeRaw
      ? { ...payload, stats: normed, audit, canonical }
      : { season: payload.season, week: payload.week, team: payload.team, stats: normed, audit, canonical },
    {},
    origin
  );
}

// default: brain shape (normalized)
{
  const baseOut = includeRaw
    ? { ...payload, stats: normed, audit }
    : { season: payload.season, week: payload.week, team: payload.team, stats: normed, audit };

  if (includeSplits) {
    baseOut.splits = payload.splits ?? (canonical && canonical.splits) ?? null;
    baseOut.splits_meta = payload.splits_meta ?? null;
  }

  return ok(baseOut, {}, origin);
}
}


// POST /injuries/ingest
async function handleInjuriesIngest(req, env, origin) {
  const url = new URL(req.url);
  const season = Number(url.searchParams.get("season") || nflSeasonFromDate(new Date()));
  const week = url.searchParams.get("week") || null;

  try {
    const body = await readJson(req);

    const teamsInj = aggregateInjuriesFromFeed(body);
    const updated = await mergeInjuriesIntoTeams(env, { season, week, teamsInj });

    if (!updated.length) return fail("injuries_ingest:no_matching_teams", {}, 400, origin);

    const w = week == null || week === "" ? "ALL" : String(week);
    const key = `injuries:${season}:${w}`;

    await kvPut(env, key, {
      season,
      week,
      updated_count: updated.length,
      teams: updated
    });

    return ok({ season, week, updated_count: updated.length, teams: updated }, {}, origin);
  } catch (e) {
    return fail(`injuries_ingest:${e.message || e}`, {}, 400, origin);
  }
}

// =========================
// INJURIES (NFL): pull from ESPN (current report) and cache in KV
// =========================

function espnHeaders() {
  // ESPN endpoints are unofficial; these headers generally help reduce 403s.
  return {
    'accept': 'application/json,text/plain,*/*',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'user-agent': 'Mozilla/5.0 (compatible; RTPBrain/1.0; +https://rtp-brain-v2.kbroxton23.workers.dev)'
  };
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { ok: res.ok, status: res.status, json, text_head: (text || '').slice(0, 240) };
}

// =========================
// INJURIES (NFL): Ball Don't Lie (BDL) — player_injuries
// Docs: https://nfl.balldontlie.io/#get-all-player-injuries
// =========================

async function bdlFetchNFL(env, path) {
  const base = 'https://api.balldontlie.io/nfl/v1';
  const url = base + path;
  const key = env?.BDL_NFL_API_KEY || '';
  if (!key) return { ok: false, status: 500, error: 'missing_BDL_NFL_API_KEY' };

  const r = await fetch(url, {
    headers: {
      'Authorization': key,
      'Accept': 'application/json'
    },
    cf: { cacheTtl: 60, cacheEverything: false }
  });

  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok) return { ok: false, status: r.status, error: 'bdl_http_error', body_head: (text || '').slice(0, 240) };
  return { ok: true, status: r.status, json };
}

async function fetchAllBdlPlayerInjuries(env, perPage = 100, maxPages = 60) {
  let cursor = null;
  let pages = 0;
  const all = [];

  while (pages < maxPages) {
    const qs = new URLSearchParams();
    qs.set('per_page', String(perPage));
    if (cursor) qs.set('cursor', String(cursor));

    const res = await bdlFetchNFL(env, `/player_injuries?${qs.toString()}`);
    if (!res.ok) return { ok: false, status: res.status, error: res.error, meta: res };

    const items = Array.isArray(res?.json?.data) ? res.json.data : [];
    all.push(...items);

    const next = res?.json?.meta?.next_cursor ?? null;
    pages += 1;
    if (!next) break;
    cursor = next;
  }

  return { ok: true, pages, count: all.length, data: all };
}

function normalizeBdlStatusToEspnBucket(s) {
  const x = String(s || '').toLowerCase();
  if (!x) return null;
  if (x.includes('out')) return 'out';
  if (x.includes('doubt')) return 'doubtful';
  if (x.includes('quest')) return 'questionable';
  if (x.includes('prob')) return 'probable';
  if (x.includes('reserve') || x === 'ir' || x.includes('injured reserve')) return 'ir';
  if (x.includes('pup')) return 'ir';
  return 'other';
}

function buildBdlTeamInjuryMap(items) {
  const out = {};
  for (const it of items || []) {
    const player = it?.player || {};
    const teamAbbr = normalizeTeamAbbr(player?.team?.abbreviation || player?.team?.abbr || it?.team?.abbreviation || it?.team_abbr);
    if (!teamAbbr) continue;

    const statusRaw = it?.status || it?.designation || it?.injury_status || '';
    const bucket = normalizeBdlStatusToEspnBucket(statusRaw);

    const name = player?.full_name || [player?.first_name, player?.last_name].filter(Boolean).join(' ') || player?.display_name || null;
    const pos = player?.position || player?.position_abbreviation || null;
    const detail = it?.comment || it?.description || it?.injury || null;
    const date = it?.date || null;

    if (!out[teamAbbr]) out[teamAbbr] = { counts: { out: 0, doubtful: 0, questionable: 0, probable: 0, ir: 0, other: 0 }, players: [] };

    out[teamAbbr].players.push({ name, pos, status: bucket, status_raw: statusRaw || null, detail, date });
    if (bucket && out[teamAbbr].counts[bucket] != null) out[teamAbbr].counts[bucket] += 1;
    else out[teamAbbr].counts.other += 1;
  }
  return out;
}

async function mateoFetchInjuries(env) {
  // Optional: if you have a Mateo feed URL, we can ingest it too.
  // Expected response (suggested): { teams: { "CHI": { counts:{...}, players:[...] }, ... } }
  const url = (env?.MATEO_INJURY_URL || '').trim();
  if (!url) return { ok: false, error: 'mateo_not_configured' };
  const headers = {
    'accept': 'application/json,text/plain,*/*'
  };
  if (env?.MATEO_API_KEY) headers['authorization'] = env.MATEO_API_KEY;

  const r = await fetchJson(url, { headers });
  if (!r.ok) return { ok: false, status: r.status, error: 'mateo_http_error', head: r.text_head };
  return { ok: true, status: r.status, json: r.json };
}

async function espnGetTeamsAbbrToId() {
  const url = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams';
  const r = await fetchJson(url, { headers: espnHeaders() });
  const items = r?.json?.sports?.[0]?.leagues?.[0]?.teams || r?.json?.teams || [];
  const map = {};
  for (const t of items) {
    const team = t?.team || t;
    const abbr = team?.abbreviation;
    const id = team?.id;
    if (abbr && id) map[String(abbr).toUpperCase()] = String(id);
  }
  return { ok: Object.keys(map).length > 0, map, meta: { status: r.status } };
}

function normalizeEspnInjuryStatus(s) {
  const x = String(s || '').toLowerCase();
  if (x.includes('out')) return 'out';
  if (x.includes('doubt')) return 'doubtful';
  if (x.includes('quest')) return 'questionable';
  if (x.includes('prob')) return 'probable';
  if (x.includes('ir')) return 'ir';
  return x || null;
}

function buildInjurySummary(items) {
  const counts = { out: 0, doubtful: 0, questionable: 0, probable: 0, ir: 0, other: 0 };
  const players = [];
  for (const it of items || []) {
    const name = it?.athlete?.displayName || it?.athlete?.fullName || it?.player?.fullName || it?.player?.displayName || it?.name;
    const statusRaw = it?.status?.name || it?.status || it?.injuryStatus || it?.availability || it?.type || '';
    const status = normalizeEspnInjuryStatus(statusRaw);
    const detail = it?.details || it?.description || it?.comment || it?.injury?.type || it?.injuryType || null;
    const pos = it?.athlete?.position?.abbreviation || it?.position?.abbreviation || it?.position || null;
    const entry = { name, pos, status, detail };
    players.push(entry);
    if (status && counts[status] != null) counts[status] += 1;
    else counts.other += 1;
  }
  return { counts, players };
}

function injuryPenaltyFromCounts(counts) {
  // Conservative penalty so we don't blow up cal; you can tune later.
  // - OUT: 0.35, DOUBT: 0.25, Q: 0.15, PROB: 0.05, IR: 0.25
  const c = counts || {};
  const p = (c.out || 0) * 0.35 + (c.doubtful || 0) * 0.25 + (c.questionable || 0) * 0.15 + (c.probable || 0) * 0.05 + (c.ir || 0) * 0.25;
  return Number.isFinite(p) ? p : 0;
}

async function espnFetchTeamInjuries(teamId) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/injuries`;
  const r = await fetchJson(url, { headers: espnHeaders() });
  const list = r?.json?.injuries || r?.json?.items || r?.json?.athletes || [];
  return { ok: r.ok, status: r.status, list, text_head: r.text_head };
}

function injuriesCacheKey(season, week, source) {
  const w = (week && String(week).trim()) ? String(week).trim() : 'current';
  const s = String(source || 'espn').toLowerCase();
  // Back-compat: keep the original key for ESPN so existing clients don't break.
  if (s === 'espn') return `nfl:injuries:${season}:${w}:v1`;
  return `nfl:injuries:${season}:${w}:${s}:v1`;
}

async function handleInjuriesBuild(req, env, origin) {
  const url = new URL(req.url);
  const season = Number(url.searchParams.get('season') || '') || null;
  const week = String(url.searchParams.get('week') || '').trim() || null;
  const source = String(url.searchParams.get('source') || 'espn').toLowerCase();
  if (!env?.RTP_CACHE) return jsonResponse({ ok: false, data: null, meta: { source }, error: 'missing_kv' }, { origin, status: 500 });
  if (!season) return jsonResponse({ ok: false, data: null, meta: { source }, error: 'injuries_build:missing_season' }, { origin, status: 400 });

  const out = {};
  const errors = [];

  if (source === 'bdl') {
    const bdl = await fetchAllBdlPlayerInjuries(env, 100, 80);
    if (!bdl.ok) {
      return jsonResponse({ ok: false, data: null, meta: { source, status: bdl.status }, error: 'injuries_build:bdl_fetch_failed' }, { origin, status: 502 });
    }
    const map = buildBdlTeamInjuryMap(bdl.data);
    for (const abbr of Object.keys(map)) {
      const summary = map[abbr];
      const inj_total = injuryPenaltyFromCounts(summary.counts);
      out[abbr] = {
        inj_total,
        injuries_summary: summary,
        _injury_penalty: inj_total,
        source: { vendor: 'bdl', pages: bdl.pages, count: bdl.count }
      };
    }
  } else if (source === 'mateo') {
    const m = await mateoFetchInjuries(env);
    if (!m.ok) {
      return jsonResponse({ ok: false, data: null, meta: { source, status: m.status }, error: 'injuries_build:mateo_fetch_failed' }, { origin, status: 502 });
    }
    // Expected: { teams: { "CHI": { counts:{...}, players:[...] }, ... } }
    const teams = m?.json?.teams && typeof m.json.teams === 'object' ? m.json.teams : null;
    if (!teams) {
      return jsonResponse({ ok: false, data: null, meta: { source }, error: 'injuries_build:mateo_bad_shape' }, { origin, status: 400 });
    }
    for (const k of Object.keys(teams)) {
      const abbr = normalizeTeamAbbr(k);
      const summary = teams[k] || {};
      const counts = summary.counts || summary?.injuries_summary?.counts || {};
      const players = summary.players || summary?.injuries_summary?.players || [];
      const normalized = { counts: { out:0, doubtful:0, questionable:0, probable:0, ir:0, other:0, ...counts }, players: Array.isArray(players) ? players : [] };
      const inj_total = injuryPenaltyFromCounts(normalized.counts);
      out[abbr] = {
        inj_total,
        injuries_summary: normalized,
        _injury_penalty: inj_total,
        source: { vendor: 'mateo' }
      };
    }
  } else {
    // default ESPN
    const teams = await espnGetTeamsAbbrToId();
    if (!teams.ok) {
      return jsonResponse({ ok: false, data: null, meta: { source, ...teams.meta }, error: 'injuries_build:teams_lookup_failed' }, { origin, status: 502 });
    }

    const abbrToId = teams.map;
    const abbrs = Object.keys(abbrToId);

    // Sequential fetch keeps ESPN happier; still fast enough.
    for (const abbr of abbrs) {
      const id = abbrToId[abbr];
      const r = await espnFetchTeamInjuries(id);
      if (!r.ok) {
        errors.push({ team: abbr, id, status: r.status, head: r.text_head });
        continue;
      }
      const summary = buildInjurySummary(r.list);
      const inj_total = injuryPenaltyFromCounts(summary.counts);
      out[abbr] = {
        inj_total,
        injuries_summary: summary,
        _injury_penalty: inj_total,
        source: { vendor: 'espn', team_id: id }
      };
    }
  }

  const key = injuriesCacheKey(season, week, source);
  const payload = {
    season,
    week: week || null,
    asOf: new Date().toISOString(),
    vendor: source,
    teams: out
  };
  await env.RTP_CACHE.put(key, JSON.stringify(payload), { expirationTtl: 60 * 60 }); // 1h

  return jsonResponse({
    ok: true,
    data: { season, week: week || null, vendor: source, teams: Object.keys(out).length, cache_key: key, errors: errors.slice(0, 5) },
    meta: { build: BUILD, source }
  }, { origin });
}

async function handleInjuriesGet(req, env, origin) {
  const url = new URL(req.url);
  const season = Number(url.searchParams.get('season') || '') || null;
  const week = String(url.searchParams.get('week') || '').trim() || null;
  const source = String(url.searchParams.get('source') || 'espn').toLowerCase();
  const team = String(url.searchParams.get('team') || '').trim().toUpperCase();
  if (!season) return jsonResponse({ ok: false, data: null, meta: {}, error: 'injuries_get:missing_season' }, { origin, status: 400 });
  if (!team) return jsonResponse({ ok: false, data: null, meta: {}, error: 'injuries_get:missing_team' }, { origin, status: 400 });
  const key = injuriesCacheKey(season, week, source);
  const raw = await env.RTP_CACHE.get(key);
  if (!raw) return jsonResponse({ ok: false, data: null, meta: { key }, error: 'injuries_get:not_found' }, { origin, status: 404 });
  const j = safeJsonParse(raw);
  return jsonResponse({ ok: true, data: { season, week: week || null, source, team, injuries: j?.teams?.[team] || null }, meta: { build: BUILD, key } }, { origin });
}

async function handleInjuriesAll(req, env, origin) {
  const url = new URL(req.url);
  const season = Number(url.searchParams.get('season') || '') || null;
  const week = String(url.searchParams.get('week') || '').trim() || null;
  const source = String(url.searchParams.get('source') || 'espn').toLowerCase();
  if (!season) return jsonResponse({ ok: false, data: null, meta: {}, error: 'injuries_all:missing_season' }, { origin, status: 400 });
  const key = injuriesCacheKey(season, week, source);
  const raw = await env.RTP_CACHE.get(key);
  if (!raw) return jsonResponse({ ok: false, data: null, meta: { key }, error: 'injuries_all:not_found' }, { origin, status: 404 });
  const j = safeJsonParse(raw);
  return jsonResponse({ ok: true, data: j, meta: { build: BUILD, key, source } }, { origin });
}

// /matchup/sim
async function handleMatchupSim(req, env, origin) {
  try {
    const url = new URL(req.url);
    let season, week, home, away, weightsName;
    let modifiers = null;
    let bodyObj = null;
    let manual_market_spread_home = null;
    let manual_market_total = null;
    // Optional: kickoff time for weather attachment (ISO 8601). If omitted, we use "now".
    let kickoffISO = null;
    let weatherEnabled = true;
    // Optional UI-driven split modifiers (non-garbage / early-down / late-down / red-zone).
    // The UI can send these even if the worker does not apply them.
    // We echo them back in the response for visibility.

    if (req.method === "GET") {
      season = Number(url.searchParams.get("season") || nflSeasonFromDate(new Date()));
      week = url.searchParams.get("week");
      if (week === undefined || week === "") week = null;
      home = url.searchParams.get("home") || url.searchParams.get("h") || "";
      away = url.searchParams.get("away") || url.searchParams.get("a") || "";
      weightsName = url.searchParams.get("weights") || url.searchParams.get("w") || null;
      kickoffISO = url.searchParams.get("kickoff") || url.searchParams.get("kickoff_iso") || url.searchParams.get("ko") || null;
      const we = url.searchParams.get("weather");
      if (we != null) weatherEnabled = !(String(we).toLowerCase() === "0" || String(we).toLowerCase() === "false" || String(we).toLowerCase() === "off");
      manual_market_spread_home = num(
        url.searchParams.get("market_spread_home") ??
        url.searchParams.get("market_spread") ??
        url.searchParams.get("spread_home") ??
        url.searchParams.get("spread") ??
        url.searchParams.get("msh") ??
        null,
        null
      );
      manual_market_total = num(
        url.searchParams.get("market_total") ??
        url.searchParams.get("total") ??
        url.searchParams.get("mt") ??
        null,
        null
      );
    } else if (req.method === "POST") {
      const body = await req.json(); // or readJson(req) if you prefer
      bodyObj = body;
      season = Number(body.season || nflSeasonFromDate(new Date()));
      week = body.week ?? null;
      home = (body.home || body.h || "").toString();
      away = (body.away || body.a || "").toString();
      weightsName = body.weights || body.w || null;
      modifiers = body.modifiers || body.mods || null;
      kickoffISO = body.kickoff || body.kickoff_iso || body.ko || body.weather?.kickoff || null;
      if (body.weather && typeof body.weather === "object" && body.weather.enabled != null) {
        weatherEnabled = !!body.weather.enabled;
      }
      // Full market support: allow simplified market fields in body or body.market
      manual_market_spread_home = num(
        body.market_spread_home ??
        body.spread_home ??
        body.spread ??
        body.market?.spread_home ??
        body.market?.spread ??
        body.market?.spread_home_point ??
        body.market?.spread?.home?.point ??
        body.market?.spread?.home_point ??
        null,
        null
      );
      manual_market_total = num(
        body.market_total ??
        body.total ??
        body.market?.total ??
        body.market?.total_points ??
        body.market?.total?.total ??
        body.market?.total?.points ??
        null,
        null
      );
    }

    home = normalizeTeamAbbr(home);
    away = normalizeTeamAbbr(away);
    // Guard: treat non-real totals as missing (UI defaults often send 0)
    if (manual_market_total != null && manual_market_total <= 10) manual_market_total = null;
if (!home || !away) return fail("matchup_sim:missing_teams", {}, 400, origin);


    // Optional: pull market lines for this matchup (totals/spread/ml) to stabilize totals projection
let market = null;
try {
  const linesRaw = await getGameLines(env, season, week);
  const lines = normalizeGameLines(linesRaw);
  const ev = (lines.items || []).find(e => {
    const ha = normalizeTeamAbbr(toTeamAbbr(e.home_team));
    const aa = normalizeTeamAbbr(toTeamAbbr(e.away_team));
    return (ha === home && aa === away) || (ha === away && aa === home);
  });
  if (ev) {
    const ha = normalizeTeamAbbr(toTeamAbbr(ev.home_team));
    const aa = normalizeTeamAbbr(toTeamAbbr(ev.away_team));
    if (ha === home && aa === away) {
      market = { spread: ev.spread, total: ev.total, ml_home: ev.ml_home, ml_away: ev.ml_away };
    } else if (ha === away && aa === home) {
      market = { spread: -ev.spread, total: ev.total, ml_home: ev.ml_away, ml_away: ev.ml_home };
    }
  }
} catch (e) {
  market = null;
}

// Manual market overrides (for old games where Odds API lines are unavailable)
// If caller provides a full market object (POST), merge it on top of Odds API market.
if (bodyObj && bodyObj.market && typeof bodyObj.market === "object") {
  market = market && typeof market === "object" ? market : {};
  const m = bodyObj.market;
  // Common flat keys
  for (const k of ["spread_home","total","ml_home","ml_away","spread_odds_home","spread_odds_away","total_odds_over","total_odds_under","ml_odds_home","ml_odds_away"]) {
    if (m[k] !== undefined && m[k] !== null) market[k] = m[k];
  }
  // Allow Odds-API-ish nested shapes too
  if (m.spread && market.spread === undefined) market.spread = m.spread;
  if (m.total && market.totalObj === undefined) market.totalObj = m.total;
}

if (Number.isFinite(manual_market_spread_home) || Number.isFinite(manual_market_total)) {
  market = market && typeof market === 'object' ? market : {};
  if (Number.isFinite(manual_market_spread_home)) market.spread_home = Number(manual_market_spread_home);
  if (Number.isFinite(manual_market_total)) market.total = Number(manual_market_total);
}

const data = await predictMatchup(env, { season, week, home, away, mode:"matchup", market, weights: weightsName, modifiers })

    // ---- Weather attach (read-only) ----
    // Always attach weather by default (unless explicitly disabled). Time is surfaced in Eastern.
    if (weatherEnabled) {
      try {
        const st = NFL_STADIUM && NFL_STADIUM[home] ? NFL_STADIUM[home] : null;
        const ko = kickoffISO || new Date().toISOString();
        const kickoff_et = fmtTZ(ko, "America/New_York");
        let wx = null;
        if (st) {
          if (st.dome) {
            wx = { ok: true, source: "dome", note: "indoor" };
          } else {
            wx = await fetchOpenMeteoWeather(st, ko);
          }
        }

        const risk = computeWeatherRisk(wx);
        const at_et = wx && wx.at ? fmtTZ(wx.at, "America/New_York") : null;
        const current_et = wx && wx.current && wx.current.time ? fmtTZ(wx.current.time, "America/New_York") : null;

        data.weather = {
          enabled: true,
          timezone_display: "America/New_York",
          kickoff: ko,
          kickoff_et,
          team: home,
          stadium: st ? st.name : null,
          dome: st ? !!st.dome : null,
          weather: wx,
          times: {
            kickoff_et,
            at_et,
            current_et
          },
          risk
        };
      } catch (e) {
        data.weather = {
          enabled: true,
          timezone_display: "America/New_York",
          kickoff: kickoffISO || null,
          kickoff_et: kickoffISO ? fmtTZ(kickoffISO, "America/New_York") : null,
          team: home,
          stadium: null,
          dome: null,
          weather: { ok: false, error: "weather_attach_failed", detail: String(e?.message || e) },
          risk: { level: "UNKNOWN", score: 0, tags: ["WEATHER_ATTACH_FAILED"] }
        };
      }
    } else {
      data.weather = { enabled: false, timezone_display: "America/New_York" };
    }
    // Echo manual market inputs for verification
    if (Number.isFinite(manual_market_spread_home) || Number.isFinite(manual_market_total)) {
      data.request = data.request || {};
      data.request.market = data.request.market || {};
      if (Number.isFinite(manual_market_spread_home)) data.request.market.spread_home = Number(manual_market_spread_home);
      if (Number.isFinite(manual_market_total)) data.request.market.total = Number(manual_market_total);
    }

    // Echo provided full market (POST) and/or resolved Odds API market in a normalized shape
    if (market && typeof market === "object") {
      data.request = data.request || {};
      data.request.market = data.request.market || {};
      const m = market;
      if (m.spread_home !== undefined && m.spread_home !== null) data.request.market.spread_home = Number(m.spread_home);
      if (m.total !== undefined && m.total !== null) data.request.market.total = Number(m.total);
      if (m.ml_home !== undefined && m.ml_home !== null) data.request.market.ml_home = Number(m.ml_home);
      if (m.ml_away !== undefined && m.ml_away !== null) data.request.market.ml_away = Number(m.ml_away);
      if (m.spread_odds_home !== undefined && m.spread_odds_home !== null) data.request.market.spread_odds_home = Number(m.spread_odds_home);
      if (m.spread_odds_away !== undefined && m.spread_odds_away !== null) data.request.market.spread_odds_away = Number(m.spread_odds_away);
      if (m.total_odds_over !== undefined && m.total_odds_over !== null) data.request.market.total_odds_over = Number(m.total_odds_over);
      if (m.total_odds_under !== undefined && m.total_odds_under !== null) data.request.market.total_odds_under = Number(m.total_odds_under);
      if (m.ml_odds_home !== undefined && m.ml_odds_home !== null) data.request.market.ml_odds_home = Number(m.ml_odds_home);
      if (m.ml_odds_away !== undefined && m.ml_odds_away !== null) data.request.market.ml_odds_away = Number(m.ml_odds_away);
    }
    // Echo requested modifiers for verification. (Worker may or may not apply them.)
    if (modifiers) {
      data.request = data.request || {};
      data.request.modifiers = modifiers;
      data.quality = data.quality || {};
      // Unless the core model explicitly reports otherwise, assume not applied.
      if (typeof data.quality.modifiers_applied !== "boolean") data.quality.modifiers_applied = false;
      data.warnings = Array.isArray(data.warnings) ? data.warnings : [];
      if (data.quality.modifiers_applied === false) data.warnings.push("modifiers_requested_but_not_applied");
    }

    // --- Weather attach (read-only) ---
    // Adds a `weather` block and `weather_risk` badge to the matchup payload.
    // Does NOT change scoring/totals yet.
    if (weatherEnabled) {
      try {
        const st = NFL_STADIUM[home];
        const kickoffUse = kickoffISO || new Date().toISOString();
        let wx = null;
        if (st) {
          if (st.dome) {
            wx = { ok: true, source: "dome", stadium: st.name, kickoff: kickoffUse, note: "indoor" };
          } else {
            wx = await fetchOpenMeteoWeatherCached(env, home, st, kickoffUse);
          }
        }

        const risk = computeWeatherRisk(wx);
        const kickoffET = fmtTZ(kickoffUse, "America/New_York");
        const kickoffLocal = st && st.tz ? fmtTZ(kickoffUse, st.tz) : null;
        const atET = wx && wx.at ? fmtTZ(wx.at, "America/New_York") : null;
        const atLocal = (wx && wx.at && st && st.tz) ? fmtTZ(wx.at, st.tz) : null;
        const currentET = (wx && wx.current && wx.current.time) ? fmtTZ(wx.current.time, "America/New_York") : null;
        const currentLocal = (wx && wx.current && wx.current.time && st && st.tz) ? fmtTZ(wx.current.time, st.tz) : null;

        data.weather = {
          enabled: true,
          team: home,
          stadium: st ? st.name : null,
          dome: st ? !!st.dome : null,
          kickoff: kickoffISO || null,
          tz_display: "America/New_York",
          times: {
            kickoff_et: kickoffET,
            kickoff_local: kickoffLocal,
            hour_at_et: atET,
            hour_at_local: atLocal,
            current_et: currentET,
            current_local: currentLocal
          },
          weather: wx
        };

        data.weather_risk = {
          level: risk.level,
          score: risk.score,
          tags: risk.tags,
          note: (risk.level === "HIGH")
            ? "High weather risk for totals: gusts/cold/precip can create drive-kill + missed kick environments."
            : (risk.level === "MED")
              ? "Moderate weather risk for totals."
              : (risk.level === "UNKNOWN")
                ? "Weather unavailable (rate limit or upstream error). Use extra caution on totals."
                : "Low weather risk."
        };

        data.request = data.request || {};
        data.request.weather = { enabled: true, kickoff: kickoffISO || null, tz: "America/New_York" };
      } catch (e) {
        data.warnings = Array.isArray(data.warnings) ? data.warnings : [];
        data.warnings.push("weather_attach_failed");
        data.weather = { enabled: true, ok: false, error: String(e?.message || e) };
        data.weather_risk = { level: "UNKNOWN", score: 0, tags: ["WEATHER_ERROR"] };
      }
    }

    // --- probability block (read-only) ---
    try {
      const sim = data && data.sim ? data.sim : null;
      const marketLine = (data && data.market) ? data.market : ((data && data.request && data.request.market) ? data.request.market : null);
      const calfit = (sim && sim.calfit) ? sim.calfit : (data && data.calfit ? data.calfit : null);

      const sigmaS = (calfit && calfit.sigma && isFiniteNum(calfit.sigma.spread)) ? calfit.sigma.spread
        : (sim && isFiniteNum(sim.sigma_spread) ? sim.sigma_spread : null);
      const sigmaT = (calfit && calfit.sigma && isFiniteNum(calfit.sigma.total)) ? calfit.sigma.total
        : (sim && isFiniteNum(sim.sigma_total_effective) ? sim.sigma_total_effective : (sim && isFiniteNum(sim.sigma_total) ? sim.sigma_total : null));

      const muM = (sim && isFiniteNum(sim.spread_cal)) ? sim.spread_cal
        : (sim && isFiniteNum(sim.spread) ? sim.spread : null);
      const muTot = (sim && isFiniteNum(sim.total_cal)) ? sim.total_cal
        : (sim && isFiniteNum(sim.total) ? sim.total : null);

      const pWinHome = (sim && isFiniteNum(sim.ml_home_cal)) ? sim.ml_home_cal
        : (sim && isFiniteNum(sim.ml_home) ? sim.ml_home : null);

      // market spread might be stored as spread_home (home line) or spread (legacy)
      const lineHome = marketLine && (isFiniteNum(marketLine.spread_home) ? marketLine.spread_home : (isFiniteNum(marketLine.spread) ? marketLine.spread : null));
      const totalLine = marketLine && (isFiniteNum(marketLine.total) ? marketLine.total : null);

      const zCoverHome = (muM!=null && sigmaS!=null && lineHome!=null) ? ((muM + lineHome)/sigmaS) : null;
      const pCoverHome = (zCoverHome==null) ? null : normCdf(zCoverHome);

      const zOver = (muTot!=null && sigmaT!=null && totalLine!=null) ? ((muTot - totalLine)/sigmaT) : null;
      const pOver = (zOver==null) ? null : normCdf(zOver);

      data.probabilities = {
        win_home: pWinHome,
        win_away: (pWinHome==null)? null : (1 - pWinHome),
        cover_home: pCoverHome,
        cover_away: (pCoverHome==null)? null : (1 - pCoverHome),
        over: pOver,
        under: (pOver==null)? null : (1 - pOver),
        z_cover_home: zCoverHome,
        z_over: zOver,
        sigma_spread: sigmaS,
        sigma_total: sigmaT,
        market_spread_home: lineHome,
        market_total: totalLine
      };
    } catch (e) {
      // do not fail production if probabilities block errors
      data.warnings = Array.isArray(data.warnings) ? data.warnings : [];
      data.warnings.push("probabilities_failed");
    }

    

    // --- Elite grading + anchors (model-only and/or with market) ---
    try {
      const sim = data.sim || {};
      const cal = data.cal || {};
      const req = (data.request || {});
      const reqMarket = (req.market || {});
      const gradeMode = (req.grade_mode || "both"); // "model" | "market" | "both"
      const gradeFlags = (req.grade && typeof req.grade === "object") ? req.grade : null;
      const wantModel = gradeFlags ? !!gradeFlags.with_model : (gradeMode === "both" || gradeMode === "model");
      const wantMarket = gradeFlags ? !!gradeFlags.with_market : (gradeMode === "both" || gradeMode === "market");

      const SIG_SPREAD = Number(sim.sigma_spread ?? cal.sigma_spread ?? null);
      const SIG_TOTAL  = Number(sim.sigma_total_effective ?? sim.sigma_total ?? cal.sigma_total ?? null);

      // model grading uses provided lines (if any) but default odds (-110). No fake reference lines.
      const MODEL_REF_SPREAD = null;
      const MODEL_REF_TOTAL = null;
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
      function normCdf(z){
        // Abramowitz & Stegun approximation for erf
        const t = 1 / (1 + 0.2316419 * Math.abs(z));
        const d = 0.3989423 * Math.exp(-z*z/2);
        let p = d*t*(0.3193815 + t*(-0.3565638 + t*(1.781478 + t*(-1.821256 + t*1.330274))));
        if (z > 0) p = 1 - p;
        return p;
      }
      function probCoverHome(meanMargin, sigma, lineHome){
        if (!isFinite(meanMargin) || !isFinite(sigma) || sigma <= 0 || !isFinite(lineHome)) return null;
        // P( (home_margin - lineHome) > 0 ) = 1 - Phi((lineHome - mean)/sigma)
        const z = (lineHome - meanMargin) / sigma;
        return clamp01(1 - normCdf(z));
      }
      function probOver(meanTotal, sigma, lineTotal){
        if (!isFinite(meanTotal) || !isFinite(sigma) || sigma <= 0 || !isFinite(lineTotal)) return null;
        const z = (lineTotal - meanTotal) / sigma;
        return clamp01(1 - normCdf(z));
      }
      function zScoreOver(meanTotal, sigma, lineTotal){
        if (!isFinite(meanTotal) || !isFinite(sigma) || sigma <= 0 || !isFinite(lineTotal)) return null;
        return (meanTotal - lineTotal) / sigma;
      }
      function zScoreCover(meanMargin, sigma, lineHome){
        if (!isFinite(meanMargin) || !isFinite(sigma) || sigma <= 0 || !isFinite(lineHome)) return null;
        return (meanMargin - lineHome) / sigma;
      }

      function americanToDecimal(odds){
        const o = Number(odds);
        if (!isFinite(o) || o === 0) return null;
        return o > 0 ? (1 + o/100) : (1 + 100/Math.abs(o));
      }
      function impliedProbFromAmerican(odds){
        const o = Number(odds);
        if (!isFinite(o) || o === 0) return null;
        return o > 0 ? (100/(o+100)) : (Math.abs(o)/(Math.abs(o)+100));
      }
      function evPerUnit(p, odds){
        const dec = americanToDecimal(odds);
        if (!isFinite(p) || !isFinite(dec)) return null;
        const win = (dec - 1);
        const lose = 1;
        return p*win - (1-p)*lose;
      }
      function kellyFrac(p, odds){
        const dec = americanToDecimal(odds);
        if (!isFinite(p) || !isFinite(dec)) return 0;
        const b = dec - 1;
        const q = 1 - p;
        const f = (b*p - q)/b;
        return Math.max(0, Math.min(1, f));
      }

      function gradePick(p_model, odds, rules){
        const p_imp = impliedProbFromAmerican(odds) ?? (rules.defaultOdds ? impliedProbFromAmerican(rules.defaultOdds) : 0.5238095238);
        const edge = (p_model ?? 0) - (p_imp ?? 0);
        const ev = evPerUnit(p_model, odds ?? rules.defaultOdds);
        const k = kellyFrac(p_model, odds ?? rules.defaultOdds);
        let grade = "C";
        if ((rules.minConf ?? 0) > 0 && (data.model_confidence ?? 0) < rules.minConf) grade = "C";
        else if (edge >= 0.15 && (ev ?? 0) >= 0.15) grade = "A+";
        else if (edge >= 0.10 && (ev ?? 0) >= 0.08) grade = "A";
        else if (edge >= 0.06 && (ev ?? 0) >= 0.04) grade = "B";
        else if (edge >= (rules.minEdge ?? 0.04) && (ev ?? 0) >= (rules.minEV ?? 0.02)) grade = "B-";
        else grade = "C";
        return { p_implied: p_imp, edge, ev, kelly: k, grade };
      }

                  function buildGrading(marketLines, label, opts){
        const rules = {
          minConf: 0.7,
          minEdge: 0.04,
          minEV: 0.02,
          defaultOdds: -110
        };

        const useMarketOdds = !!(opts && opts.useMarketOdds);
        const defaultOdds = (opts && typeof opts.defaultOdds === "number" && isFinite(opts.defaultOdds)) ? opts.defaultOdds : rules.defaultOdds;

        const lineSpreadHome = (marketLines && typeof marketLines.spread_home === "number") ? marketLines.spread_home : null;
        const totalLine = (marketLines && typeof marketLines.total === "number" && marketLines.total > 0) ? marketLines.total : null;

        const oddsSpread = useMarketOdds ? Number((marketLines && (marketLines.spread_odds ?? marketLines.odds_spread ?? marketLines.odds)) ?? defaultOdds) : defaultOdds;
        const oddsTotal  = useMarketOdds ? Number((marketLines && (marketLines.total_odds  ?? marketLines.odds_total  ?? marketLines.odds)) ?? defaultOdds) : defaultOdds;

        const meanMargin = Number(sim.spread_cal ?? sim.spread ?? 0);
        const meanTotal  = Number(sim.total_cal ?? sim.total ?? 0);

        const picks = [];
        const anchors = [];

        // Spread picks only if we have a spread line
        if (lineSpreadHome !== null){
          const p_home = probCoverHome(meanMargin, SIG_SPREAD, lineSpreadHome);
          const p_away = (typeof p_home === "number") ? clamp01(1 - p_home) : null;

          const g_home = gradePick(p_home, oddsSpread, rules);
          const g_away = gradePick(p_away, oddsSpread, rules);

          picks.push({
            market: "spread", side: "home", line: lineSpreadHome, odds: oddsSpread,
            p_model: p_home, ...g_home
          });
          picks.push({
            market: "spread", side: "away", line: -lineSpreadHome, odds: oddsSpread,
            p_model: p_away, ...g_away
          });

          if (g_home.grade === "A+" || g_home.grade === "A") anchors.push(picks[picks.length-2]);
          if (g_away.grade === "A+" || g_away.grade === "A") anchors.push(picks[picks.length-1]);
        }

        // Total picks only if we have a total line
        if (totalLine !== null){
          const p_over = probOver(meanTotal, SIG_TOTAL, totalLine);
          const p_under = (typeof p_over === "number") ? clamp01(1 - p_over) : null;

          const g_over = gradePick(p_over, oddsTotal, rules);
          const g_under = gradePick(p_under, oddsTotal, rules);

          picks.push({
            market: "total", side: "over", line: totalLine, odds: oddsTotal,
            p_model: p_over, ...g_over
          });
          picks.push({
            market: "total", side: "under", line: totalLine, odds: oddsTotal,
            p_model: p_under, ...g_under
          });

          if (g_over.grade === "A+" || g_over.grade === "A") anchors.push(picks[picks.length-2]);
          if (g_under.grade === "A+" || g_under.grade === "A") anchors.push(picks[picks.length-1]);
        }

        // Probability summaries (only when lines exist)
        const probSummary = {
          cover_home: null, cover_away: null, over: null, under: null,
          z_cover_home: null, z_over: null,
          sigma_spread: (isFinite(SIG_SPREAD) ? SIG_SPREAD : null),
          sigma_total: (isFinite(SIG_TOTAL) ? SIG_TOTAL : null)
        };

        if (lineSpreadHome !== null){
          const p_home = probCoverHome(meanMargin, SIG_SPREAD, lineSpreadHome);
          probSummary.cover_home = p_home;
          probSummary.cover_away = (typeof p_home === "number") ? clamp01(1 - p_home) : null;
          probSummary.z_cover_home = zScoreCover(meanMargin, SIG_SPREAD, lineSpreadHome);
        }

        if (totalLine !== null){
          const p_over = probOver(meanTotal, SIG_TOTAL, totalLine);
          probSummary.over = p_over;
          probSummary.under = (typeof p_over === "number") ? clamp01(1 - p_over) : null;
          probSummary.z_over = zScoreOver(meanTotal, SIG_TOTAL, totalLine);
        }

        return {
          label,
          confidence: data.model_confidence ?? null,
          rules,
          market_lines: {
            spread_home: lineSpreadHome,
            total: totalLine,
            spread_odds: oddsSpread,
            total_odds: oddsTotal
          },
          probabilities: probSummary,
          picks,
          anchors
        };
      }

      const hasMarketSpread = typeof reqMarket.spread_home === "number";
      const hasMarketTotal  = (typeof reqMarket.total === "number" && reqMarket.total > 0);
// Build both grading sets
      const grading_model = wantModel ? buildGrading({
        spread_home: hasMarketSpread ? reqMarket.spread_home : null,
        total: hasMarketTotal ? reqMarket.total : null,
        spread_odds: -110,
        total_odds: -110
      }, "model", { useMarketOdds: false, defaultOdds: -110 }) : null;
const grading_market = (wantMarket && (hasMarketSpread || hasMarketTotal)) ? buildGrading({
        spread_home: hasMarketSpread ? reqMarket.spread_home : null,
        total: hasMarketTotal ? reqMarket.total : null,
        spread_odds: (typeof reqMarket.spread_odds === "number" ? reqMarket.spread_odds : -110),
        total_odds: (typeof reqMarket.total_odds === "number" ? reqMarket.total_odds : -110)
      }, "market", { useMarketOdds: true, defaultOdds: -110 }) : null;
data.grading_model = grading_model;
      data.anchors_model = grading_model ? (grading_model.anchors || []) : [];

      data.grading_market = grading_market;
      data.anchors_market = grading_market ? (grading_market.anchors || []) : [];

      // Back-compat fields (always safe even if one grading set is disabled)
      const safeModel = grading_model || { confidence: (data.model_confidence ?? null), rules: { defaultOdds: -110 }, picks: [], anchors: [] };
      const safeMarket = grading_market || null;
      if (gradeMode === "model" || !safeMarket){
        data.grading = { confidence: safeModel.confidence, rules: safeModel.rules, picks: safeModel.picks };
        data.anchors = safeModel.anchors;
      } else {
        data.grading = { confidence: safeMarket.confidence, rules: safeMarket.rules, picks: safeMarket.picks };
        data.anchors = safeMarket.anchors;
      }

      // Ensure probabilities include market lines for UI display
      data.probabilities = data.probabilities || {};
      data.probabilities.market_spread_home = (hasMarketSpread ? reqMarket.spread_home : null);
      data.probabilities.market_total = (hasMarketTotal ? reqMarket.total : null);


      // When market missing, don't output fake "over/under" in top-level probabilities unless we used model mode.
      if (!hasMarketTotal && gradeMode !== "model"){
        data.probabilities.over = null;
        data.probabilities.under = null;
        data.probabilities.z_over = null;
      }
    } catch (e2) {
      data.warnings = Array.isArray(data.warnings) ? data.warnings : [];
      data.warnings.push("grading_failed");
    }

return ok(data, {}, origin);
  
  } catch (e) {
    return fail(`matchup_sim:${e.message || e}`, {}, 400, origin);
  }
}

// POST /score  { rows:[...props...] }
async function handleScore(req, env, origin) {
  try {
    const body = await readJson(req);
    if (!Array.isArray(body.rows)) return fail("score:missing_rows", {}, 400, origin);

    const rows = scorePropsBatch(body.rows);
    await saveLastSlate(env, "props", rows);
    return ok({ rows }, {}, origin);
  } catch (e) {
    return fail(`score:${e.message || e}`, {}, 400, origin);
  }
}

function handleTeamsExportCsv(req, env, origin) {
  return TeamsExportCsv(req, env, origin);
}

// GET /teams/export.csv?season=2025&week=ALL
async function TeamsExportCsv(req, env, origin) {
  try {
    const url = new URL(req.url);
    const season = Number(url.searchParams.get("season") || nflSeasonFromDate(new Date()));
    const week = String(url.searchParams.get("week") || "ALL").toUpperCase();

    // Reuse shared headers (do NOT redeclare `headers` in this scope)
    const headers = {
      "content-type": "text/csv; charset=utf-8",
      "access-control-allow-origin": origin || "*",
      "access-control-allow-headers": "Content-Type, Authorization, X-Requested-With",
      "access-control-allow-methods": "GET,POST,OPTIONS"
    };

    // KV key formats vary across versions. Try a few realistic prefixes.
    const candidates = [
      `teamstats:${BUILD}:${season}:${week}:`,
      `teamstats:${BUILD}:${season}:ALL:`,
      `teamstats:${season}:${week}:`,
      `teamstats:${season}:ALL:`,
      `teamstats:${BUILD}:${season}:`,
      `teamstats:${season}:`
    ];

    let keys = [];
    let prefixUsed = candidates[0];
    for (const p of candidates) {
      const k = await listAllKeys(env, p);
      if (k && k.length) { keys = k; prefixUsed = p; break; }
    }

    const headerLine = "team,season,week,pace_plays60,pass_rate,off_epa_play,def_epa_play,redzone_td_rate_off,redzone_td_rate_def,pressure_rate,def_success,sack_rate_allowed,explosive_play_rate,inj_total\n";

    if (!keys.length) {
      // Header-only CSV (explicitly signals empty snapshot)
      return new Response(headerLine, { headers });
    }

    const rows = [];
    for (const { name } of keys) {
      const raw = await env.RTP_CACHE.get(name);
      if (!raw) continue;

      let payload;
      try { payload = JSON.parse(raw); } catch { continue; }

      // Support both {team, stats:{...}} and flat payloads
      const team = (payload.team || payload.abbr || payload.team_abbr || "").toString().toUpperCase();
      const stats = normalizeTeamStats(payload.stats || payload);

      const inj_total =
        Number(payload.inj_total ?? payload.injury_penalty ?? payload.injury_total ?? 0) || 0;

      rows.push([
        team,
        season,
        week,
        num(stats.pace_plays60),
        num(stats.pass_rate),
        num(stats.off_epa_play),
        num(stats.def_epa_play),
        num(stats.redzone_td_rate_off),
        num(stats.redzone_td_rate_def),
        num(stats.pressure_rate),
        num(stats.def_success),
        num(stats.sack_rate_allowed),
        num(stats.explosive_play_rate),
        num(inj_total)
      ].join(","));
    }

    // Keep deterministic ordering (team asc)
    rows.sort((a, b) => (a.split(",")[0] || "").localeCompare((b.split(",")[0] || "")));

    // Add some helpful meta in a comment line (CSV-safe for most parsers)
    const metaLine = `# prefix=${prefixUsed}\n`;

    return new Response(metaLine + headerLine + rows.join("\n") + "\n", { headers });
  } catch (err) {
    return json({ ok: false, data: null, meta: { build: BUILD }, error: `internal_error:${err?.message || String(err)}` }, 500, origin);
  }
}

// GET /props and /props/cache
async function handlePropsGet(req, env, origin) {
  const slate = await getLastSlate(env, "props");
  if (!slate) return fail("props:not_found", {}, 404, origin);
  return ok(slate, {}, origin);
}

// ======================================================
// RTP NFL Props Engine — v1 wiring (no 404s, all endpoints live)
// ======================================================

// KV key helpers
const PROPS_LATEST_KEY = "props:latest"; // meta for last upload

function propsKeyRaw(season, date) {
  return `props:raw:${season || "any"}:${date || "any"}`;
}

function propsKeyExport(season, date) {
  return `props:export:${season || "any"}:${date || "any"}`;
}

// Small helper: safely parse JSON body
async function readJsonSafe(req) {
  try {
    return await req.json();
  } catch (e) {
    return null;
  }
}

// Small helper: basic CSV stats (rows/cols) without caring about schema
function summarizeCsv(csvText) {
  if (!csvText || !csvText.trim()) {
    return { rows: 0, cols: 0 };
  }
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) {
    return { rows: 0, cols: 0 };
  }
  const header = lines[0];
  const cols = header.split(",").length;
  // treat everything after header as "rows"
  const rows = Math.max(0, lines.length - 1);
  return { rows, cols };
}

// Naive enrichment: pass-through CSV but append 3 columns if possible.
//
// - If CSV detected, append: rtp_proj, rtp_edge, rtp_flag
// - For now, rtp_proj = original line if we can locate a "line"-ish column,
//   rtp_edge = 0, rtp_flag = "stub" (placeholder hook for future elite logic).
//
function enrichPropsCsv(csvText) {
  if (!csvText || !csvText.trim()) return csvText || "";

  const lines = csvText.split(/\r?\n/);
  if (lines.length === 0) return csvText;

  const header = lines[0];
  const cols = header.split(",");
  const lowerHeader = cols.map(c => c.trim().toLowerCase());

  // Try to find a "line" column index, but it's optional.
  let lineIdx = lowerHeader.findIndex(h =>
    h === "line" ||
    h === "prop_line" ||
    h.endsWith("line") ||
    h.includes("total")
  );

  const extendedHeader = header + ",rtp_proj,rtp_edge,rtp_flag";
  const outLines = [extendedHeader];

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const parts = raw.split(",");

    let proj = "";
    if (lineIdx >= 0 && lineIdx < parts.length) {
      const maybeNum = parseFloat(parts[lineIdx]);
      if (!Number.isNaN(maybeNum)) proj = String(maybeNum);
    }

    const edge = "0";         // placeholder, ready for real edge logic
    const flag = "stub";      // placeholder marker

    outLines.push(raw + `,${proj},${edge},${flag}`);
  }

  return outLines.join("\n");
}

// ------------------------------------------------------
// /props/upload  (POST)
// Body can be:
//   - JSON: { season, date, raw }  OR
//   - raw text/CSV (with season/date in query string)
// Stores raw text in KV and marks it as "latest".
// ------------------------------------------------------
async function handlePropsUpload(request, env, url, origin) {
  const method = request.method;
  if (method !== "POST") {
    return fail("invalid_method", { expected: "POST", got: method }, 405, origin);
  }

  const search = url.searchParams;
  const ctype = (request.headers.get("content-type") || "").toLowerCase();

  let season = search.get("season") || "";
  let date = search.get("date") || "";

  let raw = "";
  if (ctype.includes("application/json")) {
    const body = await readJsonSafe(request);
    if (!body || typeof body !== "object") {
      return fail("props_upload_bad_json", { ctype }, 400, origin);
    }
    if (!season && body.season) season = String(body.season);
    if (!date && body.date) date = String(body.date);
    raw = body.raw || body.text || "";
  } else if (ctype.includes("multipart/form-data")) {
    const fd = await request.formData();
    const txt = (fd.get("text") || "").toString().trim();
    const file = fd.get("file");

    if (!season && fd.get("season")) season = String(fd.get("season"));
    if (!date && fd.get("date")) date = String(fd.get("date"));

    if (file && typeof file.text === "function") {
      raw = (await file.text()).trim();
    } else {
      raw = txt;
    }
  } else {
    // Treat body as plain text / CSV
    raw = await request.text();
  }

  if (!season) season = "2025";
  // If UI didn't provide a date, default to today (YYYY-MM-DD) so KV keys are stable
  if (!date || date === "unknown") date = new Date().toISOString().slice(0, 10);

  if (!raw || !raw.trim()) {
    return fail("props_upload_empty", { season, date }, 400, origin);
  }

  const rawKey = propsKeyRaw(season, date);

  await env.RTP_CACHE.put(rawKey, raw);
  await env.RTP_CACHE.put(
    PROPS_LATEST_KEY,
    JSON.stringify({
      season,
      date,
      rawKey,
      ts: new Date().toISOString()
    })
  );

  const stats = summarizeCsv(raw);

  return ok(
    {
      season,
      date,
      key: rawKey,
      rows: stats.rows,
      cols: stats.cols
    },
    { path: "/props/upload" }, origin
  );
}

// ------------------------------------------------------
// /props/list (GET)
// Returns whatever the latest raw upload is (or specific season/date by query).
// ------------------------------------------------------
async function handlePropsList(request, env, url, origin) {
  const search = url.searchParams;
  let season = search.get("season");
  let date = search.get("date");

  let meta;
  if (!season || !date) {
    const latest = await env.RTP_CACHE.get(PROPS_LATEST_KEY);
    if (!latest) {
      return fail("props_not_found", 404, { reason: "no latest" }, origin);
    }
    meta = JSON.parse(latest);
    season = meta.season;
    date = meta.date;
  } else {
    meta = {
      season,
      date,
      rawKey: propsKeyRaw(season, date)
    };
  }

  const rawKey = meta.rawKey || propsKeyRaw(season, date);
  const raw = await env.RTP_CACHE.get(rawKey);

  if (!raw) {
    return fail("props_not_found", 404, { season, date, key: rawKey }, origin);
  }

  const stats = summarizeCsv(raw);

  return ok(
    { season, date, key: rawKey, rows: stats.rows, cols: stats.cols, raw },
    { path: "/props/list" },
    origin
  );

}

// ------------------------------------------------------
// /props/export.csv (GET)
// Returns enriched CSV if available, else raw CSV as text/csv.
// Query: ?season=&date=  (optional; falls back to latest).
// ------------------------------------------------------
async function handlePropsExportCsv(request, env, url, origin) {
  const search = url.searchParams;
  let season = search.get("season");
  let date = search.get("date");

  let meta;
  if (!season || !date) {
    const latest = await env.RTP_CACHE.get(PROPS_LATEST_KEY);
    if (!latest) {
      return new Response("no props uploaded", {
        status: 404,
        headers: { "content-type": "text/plain", "access-control-allow-origin": origin || "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "Content-Type, Authorization, X-Requested-With" }
      });
    }
    meta = JSON.parse(latest);
    season = meta.season;
    date = meta.date;
  } else {
    meta = {
      season,
      date
    };
  }

  const exportKey = propsKeyExport(season, date);
  let csv = await env.RTP_CACHE.get(exportKey);

  if (!csv) {
    // fall back to raw
    const rawKey = propsKeyRaw(season, date);
    csv = await env.RTP_CACHE.get(rawKey);
    if (!csv) {
      return new Response("no props found for export", {
        status: 404,
        headers: { "content-type": "text/plain", "access-control-allow-origin": origin || "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "Content-Type, Authorization, X-Requested-With" }
      });
    }
  }

  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="rtp_props_${season}_${date}.csv"`,
      "access-control-allow-origin": origin || "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization, X-Requested-With"
    }
  });
}

// ------------------------------------------------------
// /props/sim (POST)
// Runs a light "sim" pass:
//   - loads raw CSV
//   - runs enrichPropsCsv
//   - saves to export key
//   - returns summary + meta
// Body (JSON) or query: { season, date }.
// ------------------------------------------------------
// ======== PROPS SIM — ELITE ENGINE V1 ========
async function handlePropsSim(request, env, origin, url) {
  try {
    let cfg = {};
    const ctype = (request.headers.get("content-type") || "").toLowerCase();

    if (ctype.includes("application/json")) {
      const body = await readJsonSafe(request);
      if (body && typeof body === "object") cfg = body;
    } else if (ctype.includes("multipart/form-data")) {
      const fd = await request.formData();
      cfg.use_latest = (fd.get("use_latest") || "").toString() === "1";
      cfg.season = (fd.get("season") || "").toString();
      cfg.date = (fd.get("date") || "").toString();
    } else {
      const t = (await request.text()).trim();
      if (t) {
        try { cfg = JSON.parse(t); } catch (e) { cfg = {}; }
      }
    }

    let season = cfg.season || "";
    let date = cfg.date || cfg.game_date || "";

    // If UI asked to use latest (or season/date missing), fall back to PROPS_LATEST_KEY
    if ((!season || !date) || cfg.use_latest) {
      const latest = await env.RTP_CACHE.get(PROPS_LATEST_KEY);
      if (latest) {
        try {
          const meta = JSON.parse(latest);
          season = season || meta.season;
          date = date || meta.date;
        } catch {}
      }
    }

    if (!season) season = String(new Date().getFullYear());
    if (!date) return fail("props_sim:missing_date", { season, date }, 400, origin);


    const kv = env.RTP_CACHE;

    // Auto-heal legacy uploads that were stored under date="unknown"
    if (date === "unknown") {
      const today = new Date().toISOString().slice(0, 10);
      const unknownRawKey = `props:raw:${season}:unknown`;
      const unknownRaw = await kv.get(unknownRawKey, "text");
      if (unknownRaw) {
        const healedRawKey = `props:raw:${season}:${today}`;
        await kv.put(healedRawKey, unknownRaw);

        const unknownExportKey = `props:export:${season}:unknown`;
        const unknownExport = await kv.get(unknownExportKey, "text");
        if (unknownExport) {
          const healedExportKey = `props:export:${season}:${today}`;
          await kv.put(healedExportKey, unknownExport);
        }

        date = today;
        await kv.put(PROPS_LATEST_KEY, JSON.stringify({
          season,
          date,
          rawKey: `props:raw:${season}:${date}`,
          exportKey: `props:export:${season}:${date}`,
          healedFrom: "unknown"
        }));
      }
    }
    const rawKey = `props:raw:${season}:${date}`;
    const rawCsv = await kv.get(rawKey, "text");

    if (!rawCsv) {
      return fail("props_sim:no_raw_csv_found", 404, { season, date, rawKey }, origin);
    }

    const { headers, rows } = parseCsvBasic(rawCsv);

    if (!rows.length) {
      return fail("props_sim:empty_csv", 400, { season, date, rawKey }, origin);
    }

    // ensure we have our extra columns in the header
    const extraCols = [
      "rtp_market_key",
      "rtp_proj",
      "rtp_sigma",
      "rtp_edge",
      "rtp_prob_over",
      "rtp_prob_under",
      "rtp_best_side",
      "rtp_best_prob",
      "rtp_best_kelly",
      "rtp_grade",
      "rtp_anchor_score"
    ];
    for (const c of extraCols) {
      if (!headers.includes(c)) headers.push(c);
    }

    const enrichedRows = rows.map(row => {
      const r = { ...row };
      const score = projectPropRow(r);

      r.rtp_market_key    = score.marketKey;
      r.rtp_proj          = score.mean.toFixed(3);
      r.rtp_sigma         = score.sigma.toFixed(3);
      r.rtp_edge          = score.edge.toFixed(3);
      r.rtp_prob_over     = score.pOver.toFixed(4);
      r.rtp_prob_under    = score.pUnder.toFixed(4);
      r.rtp_best_side     = score.bestSide;
      r.rtp_best_prob     = score.bestProb.toFixed(4);
      r.rtp_best_kelly    = score.bestKelly.toFixed(4);
      r.rtp_grade         = score.grade;
      r.rtp_anchor_score  = score.anchorScore.toFixed(2);

      return r;
    });

    const outCsv = stringifyCsvBasic(headers, enrichedRows);
    const exportKey = `props:export:${season}:${date}`;
    await kv.put(exportKey, outCsv);

    const grades = { A: 0, B: 0, C: 0, D: 0 };
    let topAnchor = null;

    for (const r of enrichedRows) {
      const g = (r.rtp_grade || "D").toUpperCase();
      if (grades[g] !== undefined) grades[g] += 1;
      const as = Number(r.rtp_anchor_score || 0);
      if (!topAnchor || as > topAnchor.anchorScore) {
        topAnchor = {
          player: r.player_name || r.player || "",
          team: r.team_abbr || r.team || "",
          market: r.market || r.prop_market || "",
          line: Number(r.line ?? r.prop_line ?? 0),
          side: r.rtp_best_side,
          proj: Number(r.rtp_proj || 0),
          prob: Number(r.rtp_best_prob || 0),
          kelly: Number(r.rtp_best_kelly || 0),
          grade: r.rtp_grade || "D",
          anchorScore: as,
        };
      }
    }
// Build top-N anchors (keep backward compatible top_anchor)
const topN = Math.max(1, Math.min(10, Number(cfg?.top_n || url?.searchParams?.get("top_n") || 5)));

const anchorCandidates = enrichedRows
  .map(r => {
    const as = Number(r.rtp_anchor_score || 0);
    return {
      _k: `${(r.player_name || r.player || "").trim()}|${(r.rtp_market_label || r.market || r.rtp_market_key || "").trim()}`,
      player: r.player_name || r.player || null,
      team: r.team_abbr || r.team || null,
      market: r.rtp_market_label || r.market || r.rtp_market_key || null,
      line: Number(r.line || r.prop_line || r.rtp_line || 0),
      side: r.rtp_best_side || null,
      proj: Number(r.rtp_proj || 0),
      prob: Number(r.rtp_best_prob || 0),
      kelly: Number(r.rtp_best_kelly || 0),
      grade: r.rtp_grade || "D",
      anchorScore: as,
    };
  })
  .filter(a =>
    a && Number.isFinite(a.anchorScore) && a.anchorScore > 0 &&
    Number.isFinite(a.prob) && a.prob >= 0.55 &&
    Number.isFinite(a.kelly) && a.kelly > 0 &&
    (a.grade === "A" || a.grade === "B" || a.grade === "C")
  )
  .sort((a, b) => (b.anchorScore - a.anchorScore) || (b.kelly - a.kelly) || (b.prob - a.prob));

// De-dupe by (player, market)
const seen = new Set();
const topAnchors = [];
for (const a of anchorCandidates) {
  if (!a.player || !a.market) continue;
  if (seen.has(a._k)) continue;
  seen.add(a._k);
  delete a._k;
  topAnchors.push(a);
  if (topAnchors.length >= topN) break;
}


    return jsonResponse(200, {
      ok: true,
      data: {
        season,
        date,
        status: "props_sim_elite_v1",
        rawKey,
        exportKey,
        rows: enrichedRows.length,
        cols: headers.length,
        grades,
        top_anchor: topAnchor,
        top_anchors: topAnchors,
        top_n: topN,
      },
      meta: { path: "/props/sim" },
      error: null
    }, origin);
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      data: null,
      meta: { path: "/props/sim" },
      error: `props_sim_error:${err && err.message ? err.message : String(err)}`
    }, origin);
  }
}

// ------------------------------------------------------
// /props/grade (GET)
// Placeholder: returns a structured "not implemented" result
// instead of a 404, so your UI stays happy.
// ------------------------------------------------------
async function handlePropsGrade(request, env, url, origin) {
  const latest = await env.RTP_CACHE.get(PROPS_LATEST_KEY);
  let season = null;
  let date = null;
  if (latest) {
    const meta = JSON.parse(latest);
    season = meta.season;
    date = meta.date;
  }

  return ok(
    {
      season,
      date,
      status: "grade_stub",
      message:
        "Props grading hook is wired but not doing box-score grading yet."
    },
    { path: "/props/grade" }, origin
  );
}

// ------------------------------------------------------
// /props/eval (POST)
// Placeholder: returns a synthetic evaluation summary based
// on whatever was last sim'd. No more 404s.
// ------------------------------------------------------
// ======== PROPS EVAL — SUMMARY & ANCHORS ========
async function handlePropsEval(request, env, origin, url) {
  try {
    let cfg = {};
    const ctype = (request.headers.get("content-type") || "").toLowerCase();

    if (ctype.includes("application/json")) {
      const body = await readJsonSafe(request);
      if (body && typeof body === "object") cfg = body;
    } else if (ctype.includes("multipart/form-data")) {
      const fd = await request.formData();
      cfg.use_latest = (fd.get("use_latest") || "").toString() === "1";
      cfg.season = (fd.get("season") || "").toString();
      cfg.date = (fd.get("date") || "").toString();
    } else {
      const t = (await request.text()).trim();
      if (t) {
        try { cfg = JSON.parse(t); } catch {}
      }
    }

    let season = cfg.season || "";
    let date = cfg.date || cfg.game_date || "";

    if ((!season || !date) || cfg.use_latest) {
      const latest = await env.RTP_CACHE.get(PROPS_LATEST_KEY);
      if (latest) {
        try {
          const meta = JSON.parse(latest);
          season = season || meta.season;
          date = date || meta.date;
        } catch {}
      }
    }

    if (!season) season = String(new Date().getFullYear());
    if (!date) return fail("props_eval:missing_date", { season, date }, 400, origin);


    const kv = env.RTP_CACHE;
    const exportKey = `props:export:${season}:${date}`;
    const csv = await kv.get(exportKey, "text");

    if (!csv) {
      return jsonResponse(200, {
        ok: false,
        data: null,
        meta: { season, date, exportKey },
        error: "props_eval:no_export_csv_found_run_sim_first"
      }, 404);
    }

    const { headers, rows } = parseCsvBasic(csv);
    if (!rows.length) {
      return fail("props_eval:empty_export", 400, { season, date, exportKey }, origin);
    }

    const byGrade = { A: [], B: [], C: [], D: [] };
    const counts = { A: 0, B: 0, C: 0, D: 0 };

    for (const r of rows) {
      const grade = (r.rtp_grade || "D").toUpperCase();
      if (counts[grade] === undefined) counts[grade] = 0;
      counts[grade] += 1;

      const anchorScore = Number(r.rtp_anchor_score || 0);
      const item = {
        player: r.player_name || r.player || "",
        team: r.team_abbr || r.team || "",
        opp: r.opp_abbr || r.opp || "",
        market: r.market || r.prop_market || "",
        line: Number(r.line ?? r.prop_line ?? 0),
        proj: Number(r.rtp_proj || 0),
        side: r.rtp_best_side || "",
        prob: Number(r.rtp_best_prob || 0),
        kelly: Number(r.rtp_best_kelly || 0),
        anchorScore,
        grade,
      };

      if (!byGrade[grade]) byGrade[grade] = [];
      byGrade[grade].push(item);
    }

    // sort inside each grade by anchor score descending
    for (const g of Object.keys(byGrade)) {
      byGrade[g].sort((a, b) => b.anchorScore - a.anchorScore);
    }

    // global top board (top 15 plays)
    const allPlays = Object.values(byGrade).flat();
    allPlays.sort((a, b) => b.anchorScore - a.anchorScore);
    const top = allPlays.slice(0, 15);

    return jsonResponse(500, {
      ok: true,
      data: {
        season,
        date,
        exportKey,
        status: "props_eval_elite_v1",
        counts,
        top,
        byGrade: {
          A: byGrade.A.slice(0, 20),
          B: byGrade.B.slice(0, 20),
          C: byGrade.C.slice(0, 20),
          D: byGrade.D.slice(0, 20),
        }
      },
      meta: { path: "/props/eval" },
      error: null
    }, origin);
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      data: null,
      meta: { path: "/props/eval" },
      error: `props_eval_error:${err && err.message ? err.message : String(err)}`
    }, origin);
  }
}


// POST /csv/sim (props CSV -> scored CSV)
async function handleCsvSim(req, env, origin) {
  try {
    const text = await req.text();
    const rows = parseCsvLight(text);
    const hasDottedHeaders = rows.length && Object.keys(rows[0] || {}).some(k => k.includes('.'));
    const items = hasDottedHeaders ? buildTeamsFromWide(rows, season, week) : null;
    if (!rows.length) return fail("csv_sim:no_rows", {}, 400, origin);

    const scored = scorePropsBatch(rows);

    const baseHeader = Object.keys(rows[0] || {});
    const extraHeader = ["implied_prob", "model_prob", "edge", "kelly"];
    const header = baseHeader.concat(extraHeader);
    const lines = [header.join(",")];

    for (const row of scored) {
      const line = header.map(k => {
        const v = row[k];
        if (v == null) return "";
        const s = String(v);
        if (s.includes(",") || s.includes('"')) return `"${s.replace(/"/g, '""')}"`;
        return s;
      }).join(",");
      lines.push(line);
    }

    const csv = lines.join("\n");
    const headers = {
      "content-type": "text/csv; charset=utf-8",
      "access-control-allow-origin": origin || "*",
      "access-control-allow-headers": "Content-Type, Authorization, X-Requested-With",
      "access-control-allow-methods": "GET,POST,OPTIONS"
    };

    await saveLastSlate(env, "props_csv", scored);
    return new Response(csv, { status: 200, headers });
  } catch (e) {
    return fail(`csv_sim:${e.message || e}`, {}, 400, origin);
  }
}

// POST /ingest  (props slate CSV or JSON) -> cache raw slate
async function handleIngest(req, env, origin) {
  const ctype = req.headers.get("content-type") || "";
  try {
    let rows = [];
    if (ctype.includes("text/csv")) {
      const text = await req.text();
      rows = parseCsvLight(text);
    } else {
      const body = await readJson(req);
      if (Array.isArray(body.rows)) rows = body.rows;
      else if (Array.isArray(body)) rows = body;
    }

    if (!rows.length) return fail("ingest:no_rows", {}, 400, origin);

    await saveLastSlate(env, "props_raw", rows);
    return ok({ kind: "props_raw", count: rows.length }, {}, origin);
  } catch (e) {
    return fail(`ingest:${e.message || e}`, {}, 400, origin);
  }
}

// GET /predict -> alias to latest scored props
async function handlePredict(req, env, origin) {
  const slate = await getLastSlate(env, "props");
  if (!slate) return fail("predict:not_found", {}, 404, origin);
  return ok(slate, {}, origin);
}

// POST /anchors/rows  { rows:[{home_team,away_team,...}] }
function attachAnchorsToRow(row, events) {
  const home = String(row.home_team || row.home || "").toLowerCase();
  const away = String(row.away_team || row.away || "").toLowerCase();
  if (!home || !away) return row;

  const match = events.find(ev => {
    const h = String(ev.home || "").toLowerCase();
    const a = String(ev.away || "").toLowerCase();
    return (h.includes(home) && a.includes(away)) || (h.includes(away) && a.includes(home));
  });
  if (!match) return row;

  const spread = match.markets.spread || {};
  const total  = match.markets.total  || {};
  return { ...row, anchor_spread: spread.home?.point ?? "", anchor_total: total.total ?? "" };
}

async function handleAnchorsForRows(req, env, origin) {
  try {
    const body = await readJson(req);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return fail("anchors_rows:no_rows", {}, 400, origin);

    const events = await getGameLines(env);
    const out = rows.map(r => attachAnchorsToRow(r, events));
    return ok({ rows: out }, {}, origin);
  } catch (e) {
    return fail(`anchors_rows:${e.message || e}`, {}, 400, origin);
  }
}

// Debug endpoints
async function handleEliteTeamDebug(req, env, origin) {
  const url = new URL(req.url);
  const season = Number(url.searchParams.get("season"));
  const week = url.searchParams.get("week") || null;
  const team = url.searchParams.get("team") || url.searchParams.get("abbr") || "";
  if (!season || !team) return fail("elite_team:missing_params", {}, 400, origin);

  const ts = await getTeamStats(env, { season, week, team });
  if (!ts) return fail("elite_team:not_found", {}, 404, origin);

  const norm = normalizeTeamStats(ts.stats || ts);
  const audit = validateEliteTeamStats(norm);

  return ok(
    { season, week, team: ts.team || team.toUpperCase(), stats: norm, audit },
    {},
    origin
  );
}

async function handleEliteMatchupDebug(req, env, origin) {
  try {
    const body   = await readJson(req);
    const season = Number(body.season || nflSeasonFromDate(new Date()));
    const week   = body.week ?? null;
    const home   = body.home;
    const away   = body.away;

    if (!home || !away) return fail("elite_matchup:missing_teams", {}, 400, origin);

    const cal = await getCal(env);

    const [h, a] = await Promise.all([
      getTeamStats(env, { season, week, team: home }),
      getTeamStats(env, { season, week, team: away })
    ]);

    if (!h || !a) return fail("elite_matchup:missing_team_stats", {}, 400, origin);

    const inputs = buildMatchupInputs(h.stats || h, a.stats || a, cal);
    const sim = simGameOutcome(inputs, cal);
  const sim_mc = simGameOutcomeMC(inputs);

  // --- Elite ML: prefer Monte Carlo win-prob over spread-only logistic
  // Spread->ML can be miscalibrated when totals/variance/turnover context swing.
  // We blend a small portion of spread-based ML for stability, but anchor to MC.
  if (sim_mc && isFinite(sim_mc.home_win_prob) && isFinite(sim_mc.away_win_prob)) {
    const mc_home = clamp(sim_mc.home_win_prob + 0.5 * (sim_mc.tie_prob || 0), 0, 1);
    const mc_away = clamp(sim_mc.away_win_prob + 0.5 * (sim_mc.tie_prob || 0), 0, 1);
    const sp_home = clamp(sim.ml_home ?? 0.5, 0, 1);
    const sp_away = clamp(sim.ml_away ?? 0.5, 0, 1);

    const w_mc = 0.75; // heavier weight to MC for winner/ML
    const w_sp = 1 - w_mc;

    // Blend then re-normalize to avoid tiny drift from clamps/floats
    let pH = w_mc * mc_home + w_sp * sp_home;
    let pA = w_mc * mc_away + w_sp * sp_away;
    pH = clamp(pH, 0.01, 0.99);
    pA = clamp(pA, 0.01, 0.99);
    const s = pH + pA;
    sim.ml_home = clamp(pH / (s || 1), 0.01, 0.99);
    sim.ml_away = 1 - sim.ml_home;

    // Winner by blended ML
    sim.winner = sim.ml_home > sim.ml_away ? "HOME" : "AWAY";
  }


    return ok({ season, week, home: String(home).toUpperCase(), away: String(away).toUpperCase(), inputs, sim, sim_mc, cal }, {}, origin);
  } catch (e) {
    return fail(`elite_matchup:${e.message || e}`, {}, 400, origin);
  }
}

// ========= Calibration ingest/summary/rebuild-lines-v2/set/game log/list =========


// Debug: show whether split payloads exist for a matchup (used by UI modifiers)
// GET /debug/modifiers?season=2025&week=17&home=ATL&away=LAR
async function handleDebugModifiers(req, env, origin) {
  try {
    const url = new URL(req.url);
    const season = Number(url.searchParams.get('season') || nflSeasonFromDate(new Date()));
    const week = url.searchParams.get('week') || null;
    const home = normalizeTeamAbbr((url.searchParams.get('home') || url.searchParams.get('h') || '').toString());
    const away = normalizeTeamAbbr((url.searchParams.get('away') || url.searchParams.get('a') || '').toString());

    // Be forgiving: the UI may call this endpoint before teams/week are selected.
    // Return guidance (ok:true) instead of throwing a hard error.
    if (!home || !away) {
      return ok({
        season,
        week,
        received: {
          season,
          week,
          home: home || null,
          away: away || null
        },
        help: {
          usage: 'GET /debug/modifiers?season=2025&week=17&home=ATL&away=LAR',
          params: {
            season: 'NFL season (e.g., 2025)',
            week: 'NFL week number (optional; used for reading cached teamwell)',
            home: 'Home team abbr (e.g., ATL)',
            away: 'Away team abbr (e.g., LAR)'
          },
          note:
            'This endpoint inspects whether split/modifier data is present in the cached team-well payload. If your payload does not include splits (early_down/late_down/red_zone/non_garbage), modifiers will show as unavailable.'
        }
      }, origin);
    }

    if (!week) {
      return ok({
        season,
        week: null,
        received: {
          season,
          week: null,
          home,
          away
        },
        help: {
          usage: 'GET /debug/modifiers?season=2025&week=17&home=ATL&away=LAR',
          note:
            'Week is required for debug/modifiers because split/modifier availability is stored per week in the cached team-well payload.'
        }
      }, origin);
    }

    const h = await getTeamStats(env, { season, week, team: home });
    const a = await getTeamStats(env, { season, week, team: away });

    const hRaw = h?.raw_nested || null;
    const aRaw = a?.raw_nested || null;

    const hSplits = (hRaw && hRaw.splits && typeof hRaw.splits === 'object') ? Object.keys(hRaw.splits) : [];
    const aSplits = (aRaw && aRaw.splits && typeof aRaw.splits === 'object') ? Object.keys(aRaw.splits) : [];

    const hHasAny = hSplits.length > 0;
    const aHasAny = aSplits.length > 0;

    return ok({
      season,
      week,
      home,
      away,
      home_has_splits: hHasAny,
      away_has_splits: aHasAny,
      home_split_keys: hSplits,
      away_split_keys: aSplits,
      note: (!hHasAny || !aHasAny)
        ? 'If split keys are empty, the KV team payload does not include split-derived stats (non_garbage/early_down/late_down/red_zone). Modifiers cannot be applied until those splits are present in the stored team payload.'
        : 'Split keys present. Modifiers can be applied.'
    }, origin);
  } catch (e) {
    return fail('debug_modifiers:exception', { message: String(e?.message || e) }, 500, origin);
  }
}
// Debug: show whether split payloads exist for a matchup (used by UI modifiers)
// GET /debug/modifiers?season=2025&week=17&home=ATL&away=LAR

async function handleCalIngest(req, env, origin) {
  try {
    const url = new URL(req.url);
    const season = Number(url.searchParams.get("season") || nflSeasonFromDate(new Date()));

    const payload = await readJson(req);

    let events = null;
    if (Array.isArray(payload.events)) events = payload.events;
    else if (payload.data && Array.isArray(payload.data.events)) events = payload.data.events;

    if (!events || !events.length) {
      return fail("cal_ingest:no_events_in_body", { hint: "POST JSON with {events:[...]} or {data:{events:[...]}}" }, 400, origin);
    }

    let linesFromEvents = 0;

    for (const ev of events) {
      if (!ev) continue;

      const markets = ev.markets || {};
      const spread  = markets.spread || {};
      const total   = markets.total  || {};
      const ml      = markets.moneyline || {};

      const market_spread_home = spread.home && spread.home.point != null ? Number(spread.home.point) : null;
      const market_total = total.total != null ? Number(total.total) : null;
      const market_ml_home = ml.home != null ? Number(ml.home) : null;
      const market_ml_away = ml.away != null ? Number(ml.away) : null;

      const hasAny =
        Number.isFinite(market_spread_home) ||
        Number.isFinite(market_total) ||
        Number.isFinite(market_ml_home) ||
        Number.isFinite(market_ml_away);

      if (!hasAny) continue;

      const lineKey = `cal:v1:lines:${season}:${ev.id}`;
      const existing = await env.RTP_CACHE.get(lineKey);
      if (existing) continue;

      const line = {
        season,
        event_id: ev.id,
        commence: ev.commence,
        home: ev.home,
        away: ev.away,
        market_spread_home: Number.isFinite(market_spread_home) ? market_spread_home : null,
        market_total:       Number.isFinite(market_total) ? market_total : null,
        market_ml_home:     Number.isFinite(market_ml_home) ? market_ml_home : null,
        market_ml_away:     Number.isFinite(market_ml_away) ? market_ml_away : null,
        source: "rtp_snapshot_manual"
      };

      await env.RTP_CACHE.put(lineKey, JSON.stringify(line));
      linesFromEvents++;
    }

    return ok({ season, events_received: events.length, lines_from_events: linesFromEvents }, {}, origin);
  } catch (e) {
    return fail(`cal_ingest:${e.message || e}`, {}, 500, origin);
  }
}

async function loadAllCalLines(env, season) {
  const prefix = `cal:v1:lines:${season}:`;
  const keys = await listAllKeys(env, prefix);

  const lines = [];
  for (const k of keys) {
    const raw = await env.RTP_CACHE.get(k.name);
    if (!raw) continue;
    try { lines.push(JSON.parse(raw)); } catch {}
  }
  return lines;
}

async function handleCalSummary(req, env, origin) {
  try {
    const url = new URL(req.url);
    const season = Number(url.searchParams.get("season") || nflSeasonFromDate(new Date()));
    const prefix = `cal:v1:lines:${season}:`;

    const keys = await listAllKeys(env, prefix);
    if (!keys || keys.length === 0) {
      return ok({ season, games: 0, teams: [], range: null, lines: [] }, {}, origin);
    }

    const lines = [];
    const teamSet = new Set();
    let earliest = null;
    let latest = null;

    for (const { name } of keys) {
      const raw = await env.RTP_CACHE.get(name);
      if (!raw) continue;

      let line;
      try { line = JSON.parse(raw); } catch { continue; }

      lines.push(line);
      if (line.home) teamSet.add(line.home);
      if (line.away) teamSet.add(line.away);

      if (line.commence) {
        const iso = new Date(line.commence).toISOString();
        if (!earliest || iso < earliest) earliest = iso;
        if (!latest || iso > latest) latest = iso;
      }
    }

    return ok(
      {
        season,
        games: lines.length,
        teams: Array.from(teamSet).sort(),
        range: earliest ? { earliest, latest } : null,
        lines
      },
      {},
      origin
    );
  } catch (e) {
    return fail(`cal_summary:${e.message || e}`, {}, 500, origin);
  }
}

// least squares fit
function fitLinearAB(xs, ys) {
  const n = xs.length;
  if (!n || n !== ys.length) return null;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  let used = 0;

  for (let i = 0; i < n; i++) {
    const x = Number(xs[i]);
    const y = Number(ys[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    used++;
    sumX  += x; sumY  += y; sumXY += x * y; sumX2 += x * x;
  }

  if (used < 3) return null;

  const denom = used * sumX2 - sumX * sumX;
  if (denom === 0) return null;

  const b = (used * sumXY - sumX * sumY) / denom;
  const a = (sumY - b * sumX) / used;
  return { a, b, used };
}

function isFiniteNum(x) { return Number.isFinite(Number(x)); }

function acceptSpreadFit(a, b) {
  if (!isFiniteNum(a) || !isFiniteNum(b)) return false;
  if (b < 0.80 || b > 1.05) return false;
  if (a < -2.5 || a > 2.5) return false;
  return true;
}

function acceptTotalFit(a, b) {
  if (!isFiniteNum(a) || !isFiniteNum(b)) return false;
  if (b < 0.92 || b > 1.05) return false;
  if (a < -12 || a > 8) return false;
  return true;
}

async function buildModelForLine(env, line, cal) {
  const season = Number(line.season || nflSeasonFromDate(new Date()));
  const week = null;

  const homeAbbr = teamNameToAbbr(line.home);
  const awayAbbr = teamNameToAbbr(line.away);
  if (!homeAbbr || !awayAbbr) return null;

  const h = await getTeamStats(env, { season, week, team: homeAbbr });
  const a = await getTeamStats(env, { season, week, team: awayAbbr });
  if (!h || !a) return null;

  const inputs = buildMatchupInputs(h.stats || h, a.stats || a, cal);
  const sim = simGameOutcome(inputs, cal);

  return { home: homeAbbr, away: awayAbbr, model_spread_home: sim.spread, model_total: sim.total };
}

// POST /cal/rebuild-lines-v2
async function handleCalRebuildFromLinesV2(req, env, origin) {
  try {
    const url = new URL(req.url);
    const season = Number(url.searchParams.get("season") || nflSeasonFromDate(new Date()));
    const week = null;

    const cal = await getCal(env);

    const lines = await loadAllCalLines(env, season);
    if (!lines.length) return fail("cal_rebuild_lines_v2:no_lines", { season }, 404, origin);

    const xsSpread = [], ysSpread = [];
    const xsTotal  = [], ysTotal  = [];

    let used = 0, skipped = 0;

    for (const line of lines) {
      const mkSpread = Number(line.market_spread_home);
      const mkTotal  = Number(line.market_total);

      const model = await buildModelForLine(env, line, cal);
      if (!model) { skipped++; continue; }

      const ms = Number(model.model_spread_home);
      const mt = Number(model.model_total);

      let okPair = false;

      if (isFiniteNum(ms) && isFiniteNum(mkSpread)) {
        xsSpread.push(ms); ysSpread.push(mkSpread); okPair = true;
      }
      if (isFiniteNum(mt) && isFiniteNum(mkTotal)) {
        xsTotal.push(mt); ysTotal.push(mkTotal); okPair = true;
      }

      if (okPair) used++; else skipped++;
    }

    const old = {
      spread_a: cal.spread_a, spread_b: cal.spread_b,
      total_a: cal.total_a, total_b: cal.total_b
    };

    if (xsSpread.length < 6 && xsTotal.length < 6) {
      return ok(
        { season, week, lines_total: lines.length, used, skipped, fit_pairs: { spread: xsSpread.length, total: xsTotal.length }, old, next: old, message: "cal_rebuild_lines_v2:too_few_pairs" },
        {},
        origin
      );
    }

    let next = { ...cal };
    let spread_fit_applied = false;
    let total_fit_applied = false;

    if (xsSpread.length >= 6) {
      const fitS = fitLinearAB(xsSpread, ysSpread);
      if (fitS && acceptSpreadFit(fitS.a, fitS.b)) {
        next.spread_a = fitS.a; next.spread_b = fitS.b; spread_fit_applied = true;
      }
    }

    if (xsTotal.length >= 6) {
      const fitT = fitLinearAB(xsTotal, ysTotal);
      if (fitT && acceptTotalFit(fitT.a, fitT.b)) {
        next.total_a = fitT.a; next.total_b = fitT.b; total_fit_applied = true;
      }
    }

    if (!spread_fit_applied) { next.spread_a = cal.spread_a; next.spread_b = cal.spread_b; }
    if (!total_fit_applied)  { next.total_a  = cal.total_a;  next.total_b  = cal.total_b; }

    await kvPut(env, "calibration:params", next);

    return ok(
      {
        season,
        week,
        lines_total: lines.length,
        used,
        skipped,
        fit_pairs: { spread: xsSpread.length, total: xsTotal.length },
        old,
        next: { spread_a: next.spread_a, spread_b: next.spread_b, total_a: next.total_a, total_b: next.total_b },
        message: "cal_rebuild_lines_v2:fit_applied_with_guardrails",
        debug: { spread_fit_applied, total_fit_applied }
      },
      {},
      origin
    );
  } catch (e) {
    return fail(`cal_rebuild_lines_v2:${e.message || e}`, {}, 400, origin);
  }
}

async function handleCalSetManual(req, env, origin) {
  try {
    const body = await readJson(req);
    if (!body || typeof body !== "object") return fail("cal_set_manual:missing_body", {}, 400, origin);

    const next = { ...CAL_DEFAULTS, ...body };
    await kvPut(env, "calibration:params", next);
    return ok({ message: "cal_set_manual:applied", next }, {}, origin);
  } catch (e) {
    return fail(`cal_set_manual:${e.message || e}`, {}, 400, origin);
  }
}

// ========= Cal game log v2 =========
function toAbbrMaybe(x) {
  if (!x) return "";
  const s = String(x).toUpperCase().trim();
  if (s.length <= 4) return s;
  const fromName = teamNameToAbbr(String(x));
  return fromName || s;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sanitizeModel(model = {}) {
  // Accept multiple schemas:
  // - { spread, total, ml_home, ml_away }
  // - { spread_model_raw, total_model_raw, pure:{spread,total,ml_home,ml_away}, ml_home_cal, ml_away_cal, spread_cal, total_cal }
  const spread = numOrNull(
    model.spread ??
    model.spread_model_raw ??
    model.spread_model ??
    model.spread_cal ??
    model.pure?.spread
  );

  const total = numOrNull(
    model.total ??
    model.total_model_raw ??
    model.total_model ??
    model.total_cal ??
    model.pure?.total
  );

  const ml_home = numOrNull(
    model.ml_home ??
    model.ml_home_cal ??
    model.pure?.ml_home
  );

  const ml_away = numOrNull(
    model.ml_away ??
    model.ml_away_cal ??
    model.pure?.ml_away
  );

  let mh = ml_home, ma = ml_away;
  if (mh != null && ma == null) ma = 1 - mh;
  if (ma != null && mh == null) mh = 1 - ma;

  return { spread, total, ml_home: mh, ml_away: ma };
}



function deriveModelStd(log = {}) {
  // Normalizes different payload schemas into a single "model_std" snapshot used for calibration/backtesting.
  const spread_home_pts =
    numOrNull(log.model?.spread) ??
    numOrNull(log.model?.spread_model_raw) ??
    numOrNull(log.model?.pure?.spread) ??
    null;

  const total_pts =
    numOrNull(log.model?.total) ??
    numOrNull(log.model?.total_model_raw) ??
    numOrNull(log.model?.pure?.total) ??
    null;

  const ml_home =
    numOrNull(log.model?.ml_home) ??
    numOrNull(log.model?.ml_home_cal) ??
    numOrNull(log.model?.pure?.ml_home) ??
    null;

  const ml_away =
    numOrNull(log.model?.ml_away) ??
    numOrNull(log.model?.ml_away_cal) ??
    numOrNull(log.model?.pure?.ml_away) ??
    (ml_home != null ? (1 - ml_home) : null);

  return { spread_home_pts, total_pts, ml_home, ml_away };
}

function sanitizeMarket(market = {}) {
  const spread_home = numOrNull(market.spread_home ?? market.spread);
  const total       = numOrNull(market.total);
  const ml_home = numOrNull(market.ml_home);
  const ml_away = numOrNull(market.ml_away);
  return { spread_home, total, ml_home, ml_away };
}

function sanitizeFinal(final = {}) {
  const home_pts = numOrNull(final.home_pts ?? final.home_score);
  const away_pts = numOrNull(final.away_pts ?? final.away_score);

  const spread_home = (home_pts != null && away_pts != null) ? home_pts - away_pts : null;
  const total = (home_pts != null && away_pts != null) ? home_pts + away_pts : null;

  return { home_pts, away_pts, spread_home, total };
}

async function handleCalGameLogV2(req, env, origin) {
  try {
    const body = await readJson(req);

    const season = Number(body.season || nflSeasonFromDate(new Date()));
    const week   = body.week ?? null;

    const home = toAbbrMaybe(body.home ?? body.home_team ?? body.homeTeam ?? body.home_abbr ?? body.homeAbbr ?? body.home_name ?? body.homeName);
    const away = toAbbrMaybe(body.away ?? body.away_team ?? body.awayTeam ?? body.away_abbr ?? body.awayAbbr ?? body.away_name ?? body.awayName);

    if (!season || !home || !away) {
      return fail("cal_game_log_v2:missing_fields", { required: ["season", "home", "away"] }, 400, origin);
    }

    const model  = sanitizeModel(body.model || {});
    const market = sanitizeMarket(body.market || {});
    const final  = sanitizeFinal(body.final || {});
    const model_std = deriveModelStd({ model: body.model || {} }) || null;

    const hasModel =
      model.spread != null || model.total != null || model.ml_home != null || model.ml_away != null;
    const hasMarket =
      market.spread_home != null || market.total != null || market.ml_home != null || market.ml_away != null;
    const hasFinal = final.home_pts != null || final.away_pts != null;

    if (!hasModel && !hasMarket && !hasFinal) {
      return fail("cal_game_log_v2:no_useful_payload", { hint: "Send model and/or market and/or final blocks." }, 400, origin);
    }

    const payload = {
      season,
      week,
      event_id: body.event_id || null,
      commence: body.commence || null,
      home: String(home).toUpperCase(),
      away: String(away).toUpperCase(),
      model,
      model_std,
      market,
      final,
      pairs: {
        spread: (model.spread != null && market.spread_home != null) ? [model.spread, market.spread_home] : null,
        total:  (model.total != null && market.total != null) ? [model.total, market.total] : null,
        spread_vs_final: (model.spread != null && final.spread_home != null) ? [model.spread, final.spread_home] : null,
        total_vs_final:  (model.total != null && final.total != null) ? [model.total, final.total] : null
      },
      source: body.source || "manual_log_v2"
    };

    const saved = await saveCalGame(env, payload, i);

    return ok(
      {
        message: "cal_game_log_v2:saved",
        season,
        week,
        home,
        away,
        key: saved.key,
        has: { model: hasModel, market: hasMarket, final: hasFinal }
      },
      {},
      origin
    );
  } catch (e) {
    return fail(`cal_game_log_v2:${e.message || e}`, {}, 400, origin);
  }
}

// GET /cal/game/list

async function handleCalGameDelete(req, env, origin) {
  try {
    const body = await req.json().catch(() => ({}));
    const items = Array.isArray(body?.items) ? body.items : null;

    const toDelete = [];

    if (items) {
      for (const it of items) {
        const key = (it && typeof it === "object" ? it.key : null) || calGameKey(it?.season, it?.week, it?.home_team || it?.home, it?.away_team || it?.away, it?.event_id, '');
        if (key) toDelete.push({ key });
      }
    } else {
      const key = body?.key || calGameKey(body?.season, body?.week, body?.home_team || body?.home, body?.away_team || body?.away, body?.event_id, '');
      if (key) toDelete.push({ key });
    }

    if (!toDelete.length) {
      return jsonResponse({ ok: false, data: null, meta: { build: BUILD }, error: "cal_game_delete:missing_key" }, 400, origin);
    }

    const out = [];
    for (let i = 0; i < toDelete.length; i++) {
      const k = toDelete[i].key;
      try {
        await env.RTP_CACHE.delete(k);
        out.push({ i, ok: true, key: k });
      } catch (e) {
        out.push({ i, ok: false, key: k, error: String(e?.message || e) });
      }
    }

    return jsonResponse({ ok: true, data: { message: "cal_game_delete:done", deleted: out.filter(x => x.ok).length, items: out }, meta: { build: BUILD }, error: null }, 200, origin);
  } catch (e) {
    return jsonResponse({ ok: false, data: null, meta: { build: BUILD }, error: `internal_error:cal_game_delete:${String(e?.message || e)}` }, 500, origin);
  }
}

async function handleCalGameList(req, env, origin) {
  try {
    const url = new URL(req.url);
    const season = url.searchParams.get("season") ? Number(url.searchParams.get("season")) : undefined;
    const week = url.searchParams.get("week") ?? undefined;
    const wantDebug = ["1","true","yes"].includes(String(url.searchParams.get("debug") ?? "").toLowerCase());

    const games = await loadAllCalGames(env, { season, week });

    games.sort((a, b) => {
      const aa = a.commence ? new Date(a.commence).getTime() : 0;
      const bb = b.commence ? new Date(b.commence).getTime() : 0;
      return aa - bb;
    });

    return ok({ season: season ?? null, week: week ?? null, count: games.length, games }, {}, origin);
  } catch (e) {
    return fail(`cal_game_list:${e.message || e}`, {}, 400, origin);
  }
}

// ========= Matchup entrypoint (ELITE + RELIABILITY + CONFIDENCE) =========


// ========= League context (z-scores) + power-prior =========
const TEAMS32 = ["ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GB","HOU","IND","JAX","KC","LAC","LAR","LV","MIA","MIN","NE","NO","NYG","NYJ","PHI","PIT","SEA","SF","TB","TEN","WAS"];


// GET /cal/metrics
// Computes calibration quality + suggested sigmas from /cal/game/log history.
async function handleCalMetrics(req, env, origin) {
  try {
    const url = new URL(req.url);
    const season = url.searchParams.get("season") ? Number(url.searchParams.get("season")) : undefined;
    const week = url.searchParams.get("week") ?? undefined;
    const wantDebug = ["1","true","yes"].includes(String(url.searchParams.get("debug") ?? "").toLowerCase());

    const games = await loadAllCalGames(env, { season, week });

    const spreadResiduals = [];
    const totalResiduals = [];
    const spreadAbs = [];
    const totalAbs = [];

    for (const g of games) {
      const svf = g?.pairs?.spread_vs_final;
      if (Array.isArray(svf) && svf.length === 2) {
        const model = Number(svf[0]);
        const fin = Number(svf[1]);
        if (Number.isFinite(model) && Number.isFinite(fin)) {
          const r = model - fin;
          spreadResiduals.push(r);
          spreadAbs.push(Math.abs(r));
        }
      }
      const tvf = g?.pairs?.total_vs_final;
      if (Array.isArray(tvf) && tvf.length === 2) {
        const model = Number(tvf[0]);
        const fin = Number(tvf[1]);
        if (Number.isFinite(model) && Number.isFinite(fin)) {
          const r = model - fin;
          totalResiduals.push(r);
          totalAbs.push(Math.abs(r));
        }
      }
    }

    const spread_rmse = spreadResiduals.length ? Math.sqrt(_mean(spreadResiduals.map(x => x*x))) : null;
    const total_rmse  = totalResiduals.length ? Math.sqrt(_mean(totalResiduals.map(x => x*x))) : null;

    const spread_mae = spreadAbs.length ? _mean(spreadAbs) : null;
    const total_mae  = totalAbs.length ? _mean(totalAbs) : null;

    const spread_sigma = spreadResiduals.length >= 8 ? _std(spreadResiduals) : null;
    const total_sigma  = totalResiduals.length >= 8 ? _std(totalResiduals) : null;

    return ok(
      {
        season: season ?? null,
        week: week ?? null,
        games: games.length,
        with_final_spread: spreadResiduals.length,
        with_final_total: totalResiduals.length,
        metrics: { spread_rmse, spread_mae, total_rmse, total_mae },
        suggested: {
          // Use learned sigma when we have enough samples; otherwise keep null and the model should fall back to defaults.
          margin_sigma: spread_sigma,
          total_sigma: total_sigma
        }
      },
      {},
      origin
    );
  } catch (e) {
    return fail(`cal_metrics:${e.message || e}`, {}, 400, origin);
  }
}




/**
 * Ridge-regularized affine fit: y ≈ a + b*x
 * Minimizes: Σ(y - (a + b x))^2 + λ[(a-a0)^2 + (b-b0)^2]
 * Returns {a,b}. Safe for small/degenerate samples.
 */
function fitAffineRidge(pairs, opts = {}) {
  const a0 = Number.isFinite(opts.a0) ? opts.a0 : 0;
  const b0 = Number.isFinite(opts.b0) ? opts.b0 : 1;
  const lambda = Number.isFinite(opts.lambda) ? Math.max(0, opts.lambda) : 0;

  if (!Array.isArray(pairs) || !pairs.length) return { a: a0, b: b0, n: 0 };

  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pairs) {
    if (!p || p.length < 2) continue;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    n += 1;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  if (n < 2) return { a: a0, b: b0, n };

  // Solve:
  // (n+λ)a + (sx)b = sy + λ a0
  // (sx)a + (sxx+λ)b = sxy + λ b0
  const A11 = n + lambda;
  const A12 = sx;
  const A21 = sx;
  const A22 = sxx + lambda;

  const B1 = sy + lambda * a0;
  const B2 = sxy + lambda * b0;

  const det = A11 * A22 - A12 * A21;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    // Degenerate x variance; fall back to intercept-only around prior
    const a = (B1 / (A11 || 1));
    return { a, b: b0, n };
  }

  const a = (B1 * A22 - B2 * A12) / det;
  const b = (A11 * B2 - A21 * B1) / det;

  return { a, b, n };
}

// POST or GET /cal/fit
// Fits affine calibration for spread & total and temperature scaling for ML from /cal/game/log history.
// Stores result in KV at `calfit:${season}`.
// cal/fit global guard: prevent ReferenceError if local helper missing
function skip(reason, row) { /* global guard */ }

async function handleCalFit(req, env, origin) {
  try {
    const url = new URL(req.url);

    // Support both query params and POST JSON body (keeps UI + curl flexible)
    let body = {};
    if (req.method === "POST") {
      try { body = await readJson(req.clone()); } catch (_) { body = {}; }
    }

    const season =
      (url.searchParams.get("season") ? Number(url.searchParams.get("season")) : null) ??
      (body && body.season != null ? Number(body.season) : null) ??
      nflSeasonFromDate(new Date());

    const week =
      (url.searchParams.get("week") ?? undefined) ??
      (body && body.week != null ? body.week : undefined);

    const wantDebug =
      ["1","true","yes"].includes(String(url.searchParams.get("debug") ?? "").toLowerCase()) ||
      body.debug === true;

    const games = await loadAllCalGames(env, { season, week });

    if (!games.length) {
      return fail("cal_fit:no_games", { season, week }, 404, origin);
    }

    // Collect pairs
    const spreadPairs = []; // [pred, actual_margin_home]
    const totalPairs  = []; // [pred, actual_total]
    const mlPairs     = []; // [p_home, y_home_win]

    // Track usage & skips (debug-friendly, prevents undefined errors)
    const used = { spreadN: 0, totalN: 0, mlN: 0 };
    const skipped = { missing_model_ml: 0 };
    const debugRows = [];
    function skip(reason, row) {
      skipped[reason] = (skipped[reason] || 0) + 1;
      if (wantDebug && row) debugRows.push({ reason, ...row });
    }


    
const n = (v) => num(v, null);

for (const g of games) {
  const home_score =
    n(g?.result?.home_score) ??
    n(g?.result?.home_pts) ??
    n(g?.result?.home_points) ??
    n(g?.final?.home_pts) ??
    n(g?.final?.home_score) ??
    null;
  const away_score =
    n(g?.result?.away_score) ??
    n(g?.result?.away_pts) ??
    n(g?.result?.away_points) ??
    n(g?.final?.away_pts) ??
    n(g?.final?.away_score) ??
    null;
  const y_margin = home_score - away_score;
  const y_total = home_score + away_score;

  const pSpread = g?.pairs?.spread;
  const pTotal = g?.pairs?.total;

  const x_spread =
    (Number.isFinite(n(pSpread?.[0])) ? n(pSpread?.[0]) : null) ??
    n(g?.model?.spread_model_raw) ??
    n(g?.model?.pure?.spread) ??
    n(g?.model?.spread) ??
    null;

  const x_total =
    (Number.isFinite(n(pTotal?.[0])) ? n(pTotal?.[0]) : null) ??
    n(g?.model?.total_model_raw) ??
    n(g?.model?.pure?.total) ??
    n(g?.model?.total) ??
    null;

  const p_home =
    n(g?.model?.pure?.ml_home) ??
    n(g?.model?.ml_home_cal) ??
    n(g?.model?.ml_home) ??
    n(g?.model?.p_home) ??
    n(g?.model?.home_win_prob) ??
    null;

  const row = wantDebug ? ({
    key: g?._key ?? null,
    event_id: g?.event_id ?? null,
    week: g?.week ?? null,
    home: g?.home ?? g?.home_team ?? null,
    away: g?.away ?? g?.away_team ?? null,
    hs: isFinite(home_score) ? home_score : null,
    as: isFinite(away_score) ? away_score : null,
    y_margin: isFinite(y_margin) ? y_margin : null,
    y_total: isFinite(y_total) ? y_total : null,
    x_spread: isFinite(x_spread) ? x_spread : null,
    x_total: isFinite(x_total) ? x_total : null,
    p_home: isFinite(p_home) ? p_home : null,
    market_spread_home: num(g?.market?.spread_home),
    market_total: num(g?.market?.total)
  }) : null;

  if (!isFinite(y_margin) || !isFinite(y_total)) { skip("missing_scores", row); continue; }
  if (!isFinite(x_spread)) { skip("missing_model_spread", row); continue; }
  if (!isFinite(x_total)) { skip("missing_model_total", row); continue; }

  if (Math.abs(y_margin) > 80) { skip("bad_margin", row); continue; }
  if (y_total < 10 || y_total > 100) { skip("bad_total", row); continue; }

  // Guardrail: model outputs should live in realistic NFL ranges
  if (Math.abs(x_spread) > 40) { skip("bad_model_spread", row); continue; }
  if (x_total < 10 || x_total > 100) { skip("bad_model_total", row); continue; }

  spreadPairs.push([x_spread, y_margin]);
  totalPairs.push([x_total, y_total]);
  used.spreadN += 1;
  used.totalN += 1;
// ML pair (optional; do not block spread/total)
if (Number.isFinite(p_home) && p_home > 0 && p_home < 1) {
    mlPairs.push([p_home, y_margin > 0 ? 1 : 0]);
    used.mlN += 1;
  } else {
    skipped.missing_model_ml = (skipped.missing_model_ml || 0) + 1;
  }

}


    // Fit spread & total
    const spreadFit = fitAffineRidge(spreadPairs, { a0:0, b0:1, lambda: Math.max(8, 40 - spreadPairs.length) });
    const totalFit  = fitAffineRidge(totalPairs,  { a0:0, b0:1, lambda: Math.max(8, 40 - totalPairs.length) });

    // Sigma estimates from residuals after affine fit
    function sigmaFromPairs(pairs, a, b) {
      const n = pairs.length;
      if (!n) return null;
      let se=0;
      for (const [x,y] of pairs) {
        const e = y - (a + b*x);
        se += e*e;
      }
      return Math.sqrt(se/n);
    }
    const sigma_spread = sigmaFromPairs(spreadPairs, spreadFit.a, spreadFit.b);
    const sigma_total  = sigmaFromPairs(totalPairs,  totalFit.a,  totalFit.b);

    // ML loss helpers (log loss + Brier) with temperature scaling on the logit
    function clamp01(p, eps=1e-6) {
      if (!Number.isFinite(p)) return 0.5;
      if (p < eps) return eps;
      if (p > 1-eps) return 1-eps;
      return p;
    }
    function logit(p) {
      const q = clamp01(p);
      return Math.log(q/(1-q));
    }
    function sigmoid(z) {
      return 1/(1+Math.exp(-z));
    }
    function mlLoss(tau) {
      const t = (Number.isFinite(tau) && tau > 0) ? tau : 1.12;
      let ll=0, br=0, n=0;
      for (const [p0, y] of mlPairs) {
        const p = clamp01(sigmoid(logit(p0)/t));
        // log loss
        ll += -(y ? Math.log(p) : Math.log(1-p));
        const d = p - (y ? 1 : 0);
        br += d*d;
        n += 1;
      }
      if (!n) return { ll: null, brier: null, n: 0 };
      return { ll: ll/n, brier: br/n, n };
    }

    // Temperature fit (grid search, shrink towards current/default tau=1.12)
    let bestTau = 1.12, best = null;
    if (mlPairs.length >= 4) {
      for (let tau=0.70; tau<=1.90; tau+=0.05) {
        const m = mlLoss(tau);
        if (!best || m.ll < best.ll) { best = m; bestTau = Number(tau.toFixed(2)); }
      }
    } else {
      best = mlPairs.length ? mlLoss(bestTau) : { ll:null, brier:null };
    }

    // Multi-objective “balanced” score (40/40/20)
    // - ATS: spread Brier using sigma_spread (if available)
    // - Total: over Brier using sigma_total (if available)
    // - ML: log loss using bestTau
    function normCdf(x) {
      // Abramowitz-Stegun approximation
      const t = 1/(1+0.2316419*Math.abs(x));
      const d = 0.3989423*Math.exp(-x*x/2);
      let prob = d*t*(0.3193815 + t*(-0.3565638 + t*(1.781478 + t*(-1.821256 + t*1.330274))));
      if (x > 0) prob = 1 - prob;
      return prob;
    }
    function coverProb(mu, line, sigma) {
      if (!sigma || sigma <= 1e-9) return mu + line > 0 ? 1 : 0;
      return 1 - normCdf((0 - (mu + line))/sigma);
    }
    function overProb(muTotal, totalLine, sigma) {
      if (!sigma || sigma <= 1e-9) return muTotal > totalLine ? 1 : 0;
      return 1 - normCdf((totalLine - muTotal)/sigma);
    }

    let atsBrier=null, ouBrier=null;
    if (spreadPairs.length && sigma_spread) {
      let s=0;
      for (const g of games) {
        const model = g?.model || {};
        const market = g?.market || {};
        const result = g?.result || g?.final || {};
        const pred = spreadFit.a + spreadFit.b * num(model?.spread);
        const line = num(market?.spread_home);
        const margin = num(result?.margin_home);
        if (!isFinite(pred) || !isFinite(line) || !isFinite(margin)) continue;
        const p = coverProb(pred, line, sigma_spread);
        const y = (margin + line) > 0 ? 1 : 0;
        const d = p - y;
        s += d*d;
      }
      atsBrier = s / Math.max(1, games.length);
    }
    if (totalPairs.length && sigma_total) {
      let s=0;
      for (const g of games) {
        const model = g?.model || {};
        const market = g?.market || {};
        const result = g?.result || g?.final || {};
        const predT = totalFit.a + totalFit.b * num(model?.total);
        const lineT = num(market?.total);
        const total = num(result?.total_points);
        if (!isFinite(predT) || !isFinite(lineT) || !isFinite(total)) continue;
        const p = overProb(predT, lineT, sigma_total);
        const y = total > lineT ? 1 : 0;
        const d = p - y;
        s += d*d;
      }
      ouBrier = s / Math.max(1, games.length);
    }

    const fit = {
      season,
      week: week ?? null,
      asOf: new Date().toISOString(),
      n_games: games.length,
      spread: spreadFit,
      total: totalFit,
      sigma: { spread: sigma_spread, total: sigma_total },
      ml: { n: mlPairs.length, best_tau: bestTau, ...best },
      balanced: { w_ats:0.40, w_total:0.40, w_ml:0.20, ats_brier: atsBrier, total_brier: ouBrier, ml_logloss: best?.ll ?? null }
    };

    await env.RTP_CACHE.put(`calfit:${season}`, JSON.stringify(fit), { expirationTtl: 86400 * 365 });

    return ok({ version: CALFIT_VERSION, fit_key: `calfit:${season}`, fit, used, skipped, ...(wantDebug ? { debug_rows: debugRows } : {}) }, {}, origin);
  } catch (e) {
    return fail(`cal_fit:${e.message || e}`, {}, 400, origin);
  }
}

// GET /cal/fit/latest?season=2025
async function handleCalFitLatest(req, env, origin) {
  try {
    const url = new URL(req.url);
    const season = url.searchParams.get("season") ? Number(url.searchParams.get("season")) : nflSeasonFromDate(new Date());
    const raw = await env.RTP_CACHE.get(`calfit:${season}`);
    if (!raw) return fail("cal_fit_latest:not_found", { season }, 404, origin);
    return ok({ fit: JSON.parse(raw) }, {}, origin);
  } catch (e) {
    return fail(`cal_fit_latest:${e.message || e}`, {}, 400, origin);
  }
}

// GET /schema/check
// Audits the current TeamStats snapshot in KV for missing core fields (using fallback paths).
async function handleSchemaCheck(req, env, origin) {
  try {
    const url = new URL(req.url);
    const season = Number(url.searchParams.get("season") || nflSeasonFromDate(new Date()));
    const week = String(url.searchParams.get("week") || "ALL").toUpperCase();

    const candidates = [
      `teamstats:${BUILD}:${season}:${week}:`,
      `teamstats:${BUILD}:${season}:ALL:`,
      `teamstats:${season}:${week}:`,
      `teamstats:${season}:ALL:`,
      `teamstats:${BUILD}:${season}:`,
      `teamstats:${season}:`
    ];

    let keys = [];
    let prefixUsed = candidates[0];
    for (const p of candidates) {
      const k = await listAllKeys(env, p);
      if (k && k.length) { keys = k; prefixUsed = p; break; }
    }

    if (!keys.length) {
      return json({ ok: false, data: null, meta: { season, week, prefix: prefixUsed, build: BUILD }, error: "schema_check:no_teamstats_keys" }, 404, origin);
    }

    const sampleTeams = [];
    let count = 0;

    // A minimal core set that should exist for prediction stability
    const CORE_KEYS = [
      "pace_plays60",
      "pass_rate",
      "off_epa_play",
      "def_epa_play",
      "yards_per_play",
      "points_per_drive",
      "down_conversion_rate",
      "takeaways_per_game",
      "giveaways_per_game",
      "penalties_per_game",
      "redzone_td_rate_off",
      "redzone_td_rate_def",
      "pressure_rate",
      "def_success",
      "sack_rate_allowed",
      "explosive_play_rate"
    ];

    const missingCounts = Object.fromEntries(CORE_KEYS.map(k => [k, 0]));

    for (const { name } of keys) {
      const raw = await env.RTP_CACHE.get(name);
      if (!raw) continue;

      let payload;
      try { payload = JSON.parse(raw); } catch { continue; }

      const team = (payload.team || payload.abbr || payload.team_abbr || "").toString().toUpperCase();
      const stats = normalizeTeamStats(payload.stats || payload);

      const missing = [];
      for (const k of CORE_KEYS) {
        const v = stats?.[k];
        if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) {
          missing.push(k);
          missingCounts[k] = (missingCounts[k] || 0) + 1;
        }
      }

      if (missing.length && sampleTeams.length < 10) {
        sampleTeams.push({ team, missing });
      }
      count++;
    }

    return json({
      ok: true,
      data: {
        season,
        week,
        build: BUILD,
        prefix: prefixUsed,
        teams_scanned: count,
        missing_counts: missingCounts,
        samples: sampleTeams
      },
      meta: { build: BUILD },
      error: null
    }, 200, origin);
  } catch (err) {
    return json({ ok: false, data: null, meta: { build: BUILD }, error: `internal_error:${err?.message || String(err)}` }, 500, origin);
  }
}

async function handleAuditLeague(req, env, origin) {
  try {
    const url = new URL(req.url);
    const season = Number(url.searchParams.get("season") || nflSeasonFromDate(new Date()));
    const week = String(url.searchParams.get("week") || "ALL").toUpperCase();

    const candidates = [
      `teamstats:${BUILD}:${season}:${week}:`,
      `teamstats:${BUILD}:${season}:ALL:`,
      `teamstats:${season}:${week}:`,
      `teamstats:${season}:ALL:`,
      `teamstats:${BUILD}:${season}:`,
      `teamstats:${season}:`
    ];

    let keys = [];
    let prefix = candidates[0];

    for (const p of candidates) {
      const k = await listAllKeys(env, p);
      if (k && k.length) { keys = k; prefix = p; break; }
    }

    if (!keys.length) {
      return fail("audit_league:no_teamstats_keys", { season, week, prefix }, 404, origin);
    }

    const FIELDS = [
      "pace_plays60",
      "pass_rate",
      "off_epa_play",
      "def_epa_play",
      "yards_per_play",
      "points_per_drive",
      "down_conversion_rate",
      "takeaways_per_game",
      "giveaways_per_game",
      "penalties_per_game",
      "redzone_td_rate_off",
      "redzone_td_rate_def",
      "pressure_rate",
      "def_success",
      "sack_rate_allowed",
      "explosive_play_rate",
      "inj_total"
    ];

    const agg = Object.fromEntries(FIELDS.map(f => [f, { n: 0, missing: 0, min: null, max: null, sum: 0, uniq: new Set() }]));
    const defaultsUsedCount = {};

    let teams = 0;
    for (const { name } of keys) {
      const raw = await env.RTP_CACHE.get(name);
      if (!raw) continue;

      let payload;
      try { payload = JSON.parse(raw); } catch { continue; }

      const team = (payload.team || payload.abbr || payload.team_abbr || "").toString().toUpperCase();
      if (!team) continue;

      const stats = normalizeTeamStats(payload.stats || payload);

      teams++;

      // count default-imputed fields if present
      const du = (stats?.extras && Array.isArray(stats.extras.defaults_used)) ? stats.extras.defaults_used : [];
      for (const k of du) defaultsUsedCount[k] = (defaultsUsedCount[k] || 0) + 1;

      for (const f of FIELDS) {
        const v = stats[f];
        const a = agg[f];
        if (v == null || (typeof v === "number" && !Number.isFinite(v))) {
          a.missing++;
          continue;
        }
        const numv = Number(v);
        if (!Number.isFinite(numv)) { a.missing++; continue; }
        a.n++;
        a.sum += numv;
        a.min = (a.min == null) ? numv : Math.min(a.min, numv);
        a.max = (a.max == null) ? numv : Math.max(a.max, numv);
        // keep uniq small by rounding
        a.uniq.add(Math.round(numv * 100000) / 100000);
      }
    }

    const out = {};
    for (const f of FIELDS) {
      const a = agg[f];
      const mean = a.n ? (a.sum / a.n) : null;
      out[f] = {
        n: a.n,
        missing: a.missing,
        min: a.min,
        max: a.max,
        mean: mean,
        uniq: a.uniq.size
      };
    }

    return ok(
      {
        season,
        week,
        prefix,
        teams_seen: teams,
        fields: out,
        defaults_used: defaultsUsedCount
      },
      { build: BUILD },
      origin
    );
  } catch (e) {
    return fail(`audit_league:${e.message || e}`, {}, 500, origin);
  }
}


function _mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function _stdev(arr) {
  if (!arr.length) return 1;
  const m = _mean(arr);
  const v = _mean(arr.map(x => (x-m)*(x-m)));
  const s = Math.sqrt(v);
  return (s && isFinite(s)) ? s : 1;
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// Cached for 6h; computed from current TeamWell snapshot for season/week
async function getLeagueContext(env, { season, week }) {
  const key = `brain:v1:nfl:leaguectx:${season}:${week ?? "null"}`;
  const cached = await kvGet(env, key);
  if (cached && cached.fields && cached.mean && cached.std) return cached;

  const fields = [
    "off_epa_play",
    "def_epa_play",
    "yards_per_play",
    "yards_per_play_def",
    "points_per_drive",
    "points_per_drive_def",
    "pressure_rate",
    "pressure_rate_allowed_off",
    "sack_rate_allowed",
    "sack_rate_generated_def",
    "explosive_play_rate",
    "def_success"
  ];

  const rows = await Promise.all(TEAMS32.map(async (t) => {
    try {
      const rec = await getTeamStats(env, { season, week, team: t });
      const n = normalizeTeamStats((rec && rec.stats) ? rec.stats : rec);
      return { team: t, n };
    } catch {
      return { team: t, n: {} };
    }
  }));

  const mean = {};
  const std = {};
  for (const f of fields) {
    const vals = rows.map(r => num(r.n[f], null)).filter(v => v !== null && isFinite(v));
    mean[f] = _mean(vals);
    std[f]  = _stdev(vals);
  }

  const ctx = { season, week: week ?? null, fields, mean, std, asOf: new Date().toISOString() };
  await kvPut(env, key, ctx, 6 * 3600);
  return ctx;
}

function z(ctx, field, v) {
  const m = num(ctx?.mean?.[field], 0);
  const s = Math.max(1e-6, num(ctx?.std?.[field], 1));
  return (v - m) / s;
}

// Power rating: stable, season-long strength signal (small prior)
function computePowerRating(norm, ctx) {
  const offEPA = num(norm.off_epa_play, 0);
  const defEPA = num(norm.def_epa_play, 0);
  const yppO   = num(norm.yards_per_play, 5.5);
  const yppD   = num(norm.yards_per_play_def, 5.5);
  const ppdO   = num(norm.points_per_drive, 2.1);
  const ppdD   = num(norm.points_per_drive_def, 2.1);
  const prsD   = num(norm.pressure_rate, 0.36);
  const prsA   = num(norm.pressure_rate_allowed_off, 0.36);
  const sackA  = num(norm.sack_rate_allowed, 0.06);
  const sackG  = num(norm.sack_rate_generated_def, 0.06);
  const explO  = num(norm.explosive_play_rate, 0.12);
  const defSuc = num(norm.def_success, 0.45);

  // Higher is better (note: defEPA lower is better, yppD lower is better, ppdD lower is better)
  const score =
    1.15 * z(ctx, "off_epa_play", offEPA)
  - 1.10 * z(ctx, "def_epa_play", defEPA)
  + 0.80 * z(ctx, "yards_per_play", yppO)
  - 0.75 * z(ctx, "yards_per_play_def", yppD)
  + 0.55 * z(ctx, "points_per_drive", ppdO)
  - 0.55 * z(ctx, "points_per_drive_def", ppdD)
  + 0.35 * z(ctx, "pressure_rate", prsD)
  - 0.25 * z(ctx, "pressure_rate_allowed_off", prsA)
  - 0.30 * z(ctx, "sack_rate_allowed", sackA)
  + 0.30 * z(ctx, "sack_rate_generated_def", sackG)
  + 0.25 * z(ctx, "explosive_play_rate", explO)
  - 0.25 * z(ctx, "def_success", defSuc);

  return score;
}

async function predictMatchup(env, { season, week, home, away, mode = "matchup", market = null, weights = null, modifiers = null }) {
  const [h, a, cal, calfit] = await Promise.all([
    getTeamStats(env, { season, week, team: home }),
    getTeamStats(env, { season, week, team: away }),
    getCal(env),
    getCalFit(env, season)
  ]);

  // Merge empirical calfit into the runtime cal object (visibility + downstream use).
  // This does NOT remove any existing cal keys; it only overrides where calfit is authoritative.
  if (calfit && typeof calfit === "object") {
    try {
      if (calfit.spread && Number.isFinite(_toNum(calfit.spread.a)) && Number.isFinite(_toNum(calfit.spread.b))) {
        cal.spread_a = _toNum(calfit.spread.a);
        cal.spread_b = _toNum(calfit.spread.b);
      }
      if (calfit.total && Number.isFinite(_toNum(calfit.total.a)) && Number.isFinite(_toNum(calfit.total.b))) {
        cal.total_a = _toNum(calfit.total.a);
        cal.total_b = _toNum(calfit.total.b);
      }
      if (calfit.ml && Number.isFinite(_toNum(calfit.ml.best_tau))) {
        cal.temp_tau = _toNum(calfit.ml.best_tau);
      }
      if (calfit.sigma) {
        const sS = _toNum(calfit.sigma.spread);
        const sT = _toNum(calfit.sigma.total);
        if (Number.isFinite(sS)) cal.sigma_spread = sS;
        if (Number.isFinite(sT)) cal.sigma_total  = sT;
      }
      cal.calfit_asOf = calfit.asOf ?? null;
    } catch (_) {}
  }

// Optional weights override (KV-driven, no redeploy needed)
let weightsRec = null;
if (weights) {
  try {
    weightsRec = await loadWeights(env, { season, week, name: String(weights) });
    if (weightsRec && weightsRec.weights && typeof weightsRec.weights === "object") {
      // Support overriding the existing cal weights keys (w_ypp, w_epa, etc.)
      for (const [k, v] of Object.entries(weightsRec.weights)) {
        if (k in cal && Number.isFinite(_toNum(v))) cal[k] = _toNum(v);
      }
    }
  } catch (e) {
    weightsRec = null;
  }
}


  if (!h || !a) throw new Error("matchup_missing_team_stats");

  // Injuries map (season/week scope)
  const injMap = await getInjurySummary(env, season, week);

  const homeAbbr = String(home).toUpperCase();
  const awayAbbr = String(away).toUpperCase();

  const baseH = (h.raw_nested || h.stats || h);
    const baseA = (a.raw_nested || a.stats || a);

  // Merge injuries BEFORE normalization so normalizeTeamStats can adjust EPA

  const homeInj = (injMap && injMap[homeAbbr] && typeof injMap[homeAbbr] === "object") ? injMap[homeAbbr] : null;
  const awayInj = (injMap && injMap[awayAbbr] && typeof injMap[awayAbbr] === "object") ? injMap[awayAbbr] : null;

  let hStatsRaw = {
    ...baseH,
    inj_total: (homeInj && Number.isFinite(_toNum(homeInj.inj_total))) ? _toNum(homeInj.inj_total) : (baseH.inj_total ?? baseH.injury_total ?? baseH.injury_penalty),
    injuries_summary: (homeInj && homeInj.injuries_summary) ? homeInj.injuries_summary : (baseH.injuries_summary || null),
    _injury_penalty: (homeInj && Number.isFinite(_toNum(homeInj._injury_penalty))) ? _toNum(homeInj._injury_penalty) : (baseH._injury_penalty ?? baseH.injury_penalty),
    inj_source: (homeInj && homeInj.source) ? homeInj.source : (baseH.inj_source || null)
  };

  let aStatsRaw = {
    ...baseA,
    inj_total: (awayInj && Number.isFinite(_toNum(awayInj.inj_total))) ? _toNum(awayInj.inj_total) : (baseA.inj_total ?? baseA.injury_total ?? baseA.injury_penalty),
    injuries_summary: (awayInj && awayInj.injuries_summary) ? awayInj.injuries_summary : (baseA.injuries_summary || null),
    _injury_penalty: (awayInj && Number.isFinite(_toNum(awayInj._injury_penalty))) ? _toNum(awayInj._injury_penalty) : (baseA._injury_penalty ?? baseA.injury_penalty),
    inj_source: (awayInj && awayInj.source) ? awayInj.source : (baseA.inj_source || null)
  };

  // Build elite inputs (normalize happens inside buildMatchupInputs)

  // --- Optional split-driven modifiers (UI) ---
  // If enabled, we blend core stats with split stats (early/late/redzone/non-garbage) when available.
  let modifiersMeta = { applied: false, used_splits_home: [], used_splits_away: [] };
  try {
    if (modifiers && modifiers.enabled === true) {
      const hRes = applySplitModifiersToTeamRaw(hStatsRaw, modifiers);
      const aRes = applySplitModifiersToTeamRaw(aStatsRaw, modifiers);
      hStatsRaw = hRes.teamRaw;
      aStatsRaw = aRes.teamRaw;
      modifiersMeta = {
        applied: (hRes.applied || aRes.applied) ? true : false,
        used_splits_home: hRes.used_splits || [],
        used_splits_away: aRes.used_splits || [],
        available_splits_home: hRes.available_splits || [],
        available_splits_away: aRes.available_splits || [],
        home_reason: hRes.reason || null,
        away_reason: aRes.reason || null,
        home_error: hRes.error || null,
        away_error: aRes.error || null
      };
    }
  } catch (e) {
    // never break the sim because of modifiers
    modifiersMeta = { applied: false, used_splits_home: [], used_splits_away: [], error: String(e && e.message ? e.message : e) };
  }

  // Build elite inputs (normalize happens inside buildMatchupInputs)
  const inputs = buildMatchupInputs(hStatsRaw, aStatsRaw, cal);


  // --- Power prior (small, stable) ---
  // Adds a modest spread prior based on league-normalized strength.
  try {
    const ctx = await getLeagueContext(env, { season, week });
    const hNorm = normalizeTeamStats(hStatsRaw);
    const aNorm = normalizeTeamStats(aStatsRaw);
    const pHome = computePowerRating(hNorm, ctx);
    const pAway = computePowerRating(aNorm, ctx);
    const prior_pts = clamp((pHome - pAway) * 0.90, -3.5, 3.5); // pts to spread
    inputs.power_prior = { home: pHome, away: pAway, pts: prior_pts, asOf: ctx.asOf };

    // Apply prior symmetrically to points so totals stay stable
    inputs.homePts = clamp(num(inputs.homePts, 22) + 0.5 * prior_pts, 10, 50);
    inputs.awayPts = clamp(num(inputs.awayPts, 22) - 0.5 * prior_pts, 10, 50);
    inputs.spread  = inputs.homePts - inputs.awayPts;
    inputs.total   = inputs.homePts + inputs.awayPts;
  } catch (e) {
    inputs.power_prior = { error: String(e && e.message ? e.message : e) };
  }

  const sim    = simGameOutcome(inputs, cal);
  const sim_mc = simGameOutcomeMC(inputs);

  // --- Moneyline: prefer MC win-prob when available (ties split 50/50), blended with spread-based prob
  // This stabilizes ML vs single-point spread and keeps ML consistent with sim_mc distribution.
  if (sim_mc && typeof sim_mc.home_win_prob === "number") {
    const p_mc_home = clamp(sim_mc.home_win_prob + 0.5 * num(sim_mc.tie_prob, 0), 0, 1);
    const p_spread_home = clamp(num(sim.ml_home, 0.5), 0, 1);
    const ML_BLEND = 0.65; // weight on MC
    const p_home = clamp(ML_BLEND * p_mc_home + (1 - ML_BLEND) * p_spread_home, 0.02, 0.98);
    sim.ml_home = p_home;
    sim.ml_away = 1 - p_home;
    sim.winner = (p_home >= 0.5) ? "HOME" : "AWAY";
  }


  // --- Totals: optional market-anchor blend
  // When market totals are available, blend toward market more when model confidence is lower
  // to reduce wild mean errors while keeping edge when confidence is high.
  if (market && typeof market.total === "number" && isFinite(market.total)) {
    const p_conf = clamp(num(market.confidence_hint, 0.75), 0, 1);
    const W_MODEL = clamp(0.35 + 0.45 * p_conf, 0.35, 0.80); // 0.35..0.80
    sim.total_model_raw = sim.total;
    sim.total = W_MODEL * sim.total + (1 - W_MODEL) * market.total;
    // Keep base totals in inputs as model-only; sim.total is what UI/edges should use.
  }

  
  // --- Spread: optional market-anchor blend (same philosophy as totals) ---
  // Keep "pure" model outputs available for props + long-run truth.
  sim.spread_model_raw = num(sim.spread, 0);
  sim.total_model_raw  = (sim.total_model_raw !== undefined) ? sim.total_model_raw : num(sim.total, 0);

  if (market && typeof market.spread === "number" && isFinite(market.spread)) {
    const p_conf = clamp(num(market.confidence_hint, 0.75), 0, 1);
    const W_MODEL = clamp(0.30 + 0.50 * p_conf, 0.30, 0.80); // 0.30..0.80
    sim.spread = W_MODEL * sim.spread + (1 - W_MODEL) * market.spread;

    // ML consistency: re-derive from spread after blending (MC still blended earlier)
    const p_from_spread = clamp(sigmoid(num(sim.spread, 0) * cal.ml_spread_scale), 0.02, 0.98);
    sim.ml_home = p_from_spread;
    sim.ml_away = 1 - p_from_spread;
    sim.winner = (sim.ml_home >= 0.5) ? "HOME" : "AWAY";
  }

  // Expose both "pure" and "sharp" (market-aware) outputs
  sim.pure = {
    spread: num(sim.spread_model_raw, sim.spread),
    total:  num(sim.total_model_raw, sim.total),
    ml_home: num(sim.ml_home, 0.5), // best available
    ml_away: num(sim.ml_away, 0.5)
  };

  // --- Apply empirical calibration fit (multi-objective: ATS/Total/ML) if present ---
  // Keeps `sim.pure` as the raw engine output, and overwrites `sim.spread/total/ml_*` with calibrated values.
  if (calfit && typeof calfit === "object") {
    try {
      const sf = calfit.spread;
      const tf = calfit.total;
      const mf = calfit.ml;
      const shrink = Number.isFinite(Number(calfit.shrink)) ? Number(calfit.shrink) : 0.65; // shrink calfit toward identity (prevents over-amplified totals from small samples)
      const shrinkA = Number.isFinite(Number(calfit.shrinkA)) ? Number(calfit.shrinkA) : shrink;
      const shrinkB = Number.isFinite(Number(calfit.shrinkB)) ? Number(calfit.shrinkB) : shrink;
      if (sf && Number.isFinite(_toNum(sf.a)) && Number.isFinite(_toNum(sf.b))) {
        const aEff = shrinkA * _toNum(sf.a);
        const bEff = 1 + shrinkB * (_toNum(sf.b) - 1);
        sim.spread_cal = aEff + bEff * num(sim.pure.spread, sim.spread);
        sim.spread = sim.spread_cal;
      }
      if (tf && Number.isFinite(_toNum(tf.a)) && Number.isFinite(_toNum(tf.b))) {
        const aEffT = shrinkA * _toNum(tf.a);
        const bEffT = 1 + shrinkB * (_toNum(tf.b) - 1);
        sim.total_cal = aEffT + bEffT * num(sim.pure.total, sim.total);
        sim.total = sim.total_cal;
      }
      if (mf && Number.isFinite(_toNum(mf.best_tau)) && Number.isFinite(num(sim.ml_home))) {
        const tau = Math.max(0.25, _toNum(mf.best_tau));
        const z = _logit(_clamp01(num(sim.ml_home, 0.5)));
        const p = _sigmoid(z / tau);
        sim.ml_home_cal = clamp(p, 0.02, 0.98);
        sim.ml_away_cal = 1 - sim.ml_home_cal;
        sim.ml_home = sim.ml_home_cal;
        sim.ml_away = sim.ml_away_cal;
        sim.winner = (sim.ml_home >= 0.5) ? "HOME" : "AWAY";
      }
      sim.calfit = {
        season: calfit.season ?? null,
        week: calfit.week ?? null,
        asOf: calfit.asOf ?? null
      };
    } catch (e) {
      sim.calfit = { error: String(e && e.message ? e.message : e) };
    }
  }

  // Matchup mode: keep calibration artifacts so edges/anchors can compute cover/total probs
  // (Older builds deleted sigma/calfit here; v14 keeps them.)
  if (mode === "matchup") {
    // Ensure calibrated aliases exist for downstream UI/probability calculators.
    if (!isFiniteNum(sim.spread_cal)) sim.spread_cal = num(sim.spread, null);
    if (!isFiniteNum(sim.total_cal))  sim.total_cal  = num(sim.total,  null);
    if (!isFiniteNum(sim.ml_home_cal)) sim.ml_home_cal = num(sim.ml_home, null);
    if (!isFiniteNum(sim.ml_away_cal)) sim.ml_away_cal = num(sim.ml_away, null);

    // Carry sigma from calfit when available (used for cover/over/under).
    if (calfit && calfit.sigma) {
      const sS = _toNum(calfit.sigma.spread);
      const sT = _toNum(calfit.sigma.total);
      if (Number.isFinite(sS)) sim.sigma_spread = sS;
      if (Number.isFinite(sT)) sim.sigma_total  = sT;
    }

    // Variance-aware totals: inflate sigma_total based on chaos signal (does not change mean predictions)
    const chaosScale = Number.isFinite(num(inputs.chaos_sigma_scale, NaN)) ? clamp(num(inputs.chaos_sigma_scale, 0), 0, 0.35) : 0;
    if (Number.isFinite(num(sim.sigma_total, NaN))) {
      sim.sigma_total_effective = num(sim.sigma_total, 13) * (1 + chaosScale);
    } else if (Number.isFinite(num(cal.sigma_total, NaN))) {
      sim.sigma_total_effective = num(cal.sigma_total, 13) * (1 + chaosScale);
    }
  }



// Reliability audits on the normalized team stats
  const audit_home = validateEliteTeamStats(inputs.home_norm);
  const audit_away = validateEliteTeamStats(inputs.away_norm);

  // Detect "default-like" fields on elite metrics
  const default_like_home = detectDefaultLike(inputs.home_norm);
  const default_like_away = detectDefaultLike(inputs.away_norm);

  const quality = {
    missing_home: audit_home.missing_core || [],
    missing_away: audit_away.missing_core || [],
    tier: computeQualityTier(audit_home.missing_core, audit_away.missing_core),
    used_defaults:
      (audit_home.missing_core?.length || 0) > 0 ||
      (audit_away.missing_core?.length || 0) > 0,
    default_like: {
      home: default_like_home,
      away: default_like_away
    }
  };

  const confidence_score = computeModelConfidence(quality, sim, sim_mc);

  const payload = {
    season,
    week: (week == null || week === "") ? null : week,

    home: homeAbbr,
    away: awayAbbr,

    // Fully normalized Team Well outputs (Elite Core)
    home_stats: inputs.home_norm,
    away_stats: inputs.away_norm,

    // Structured inputs used by the engine
    inputs: {
      pace:   inputs.pace,
      plays_home_est: inputs.plays_home_est,
      plays_away_est: inputs.plays_away_est,
      drive_kill: inputs.drive_kill,
      h_pr:   inputs.h_pr,
      a_pr:   inputs.a_pr,

      homePts: inputs.homePts,
      awayPts: inputs.awayPts,

      spread: inputs.spread,
      total:  inputs.total,

      trench:  inputs.trench,
      context: inputs.context
    },

    // Model outputs
    sim,
    sim_mc,

    // Calibration snapshot
    cal,
    weights: weightsRec ? { name: String(weights), key: weightsRec.key, updatedAt: weightsRec.updatedAt || null } : null,

    // Reliability layer
    quality: {
      ...quality,
      confidence_score,
      modifiers_applied: !!(modifiersMeta && modifiersMeta.applied),
      modifiers_used: modifiersMeta || null
    },

    // Convenience alias for UI / staking logic
    model_confidence: confidence_score,

    // Optional debug marker for callers
    mode
  };

  const key = matchupKey(season, week, homeAbbr, awayAbbr);
  await kvPut(env, key, payload, MATCHUP_TTL);

  return payload;
}

// ========= Router =========
// ========= Service Worker wrapper (for Dashboard mobile limits) =========
// This lets the same code run without "
// POST /cal/game/log.bulk  (array of /cal/game/log v2 objects)
async function handleCalGameLogBulk(req, env, origin) {
  try {
    const body = await readJson(req);
    if (!Array.isArray(body)) {
      return fail("cal_game_log_bulk:body_not_array", { hint: "POST a JSON array of log objects" }, 400, origin);
    }

    const received = body.length;
    let saved = 0;
    const items = [];

    for (let i = 0; i < body.length; i++) {
      const row = body[i] || {};
      try {
        const season = Number(row.season || nflSeasonFromDate(new Date()));
        const week   = row.week ?? null;

        const home = toAbbrMaybe(row.home ?? row.home_team ?? row.homeTeam ?? row.home_abbr ?? row.homeAbbr ?? row.home_name ?? row.homeName);
        const away = toAbbrMaybe(row.away ?? row.away_team ?? row.awayTeam ?? row.away_abbr ?? row.awayAbbr ?? row.away_name ?? row.awayName);

        if (!season || !home || !away) {
          items.push({ i, ok: false, error: "missing_fields", required: ["season","home","away"] });
          continue;
        }

        const model  = sanitizeModel(row.model || {});
        const market = sanitizeMarket(row.market || {});
        const final  = sanitizeFinal(row.final || row.result || {});

        const payload = {
          season,
          week,
          home,
          away,
          event_id: row.event_id || row.eventId || null,
          commence: row.commence || row.commence_time || null,
          model,
          market,
          final,
          created_at: new Date().toISOString(),
          pairs: {
            spread: (model.spread != null && market.spread_home != null) ? [model.spread, market.spread_home] : null,
            total:  (model.total != null && market.total != null) ? [model.total, market.total] : null,
            spread_vs_final: (model.spread != null && final.spread_home != null) ? [model.spread, final.spread_home] : null,
            total_vs_final:  (model.total != null && final.total != null) ? [model.total, final.total] : null
          },
          source: row.source || "bulk_log_v2"
        };

        const s = await saveCalGame(env, payload);
        saved++;
        items.push({ i, ok: true, key: s.key });
      } catch (e) {
        items.push({ i, ok: false, error: String(e && e.message ? e.message : e) });
      }
    }

    const truncated = items.length > 200;
    const out = truncated ? items.slice(0, 200) : items;

    return ok(
      { message: "cal_game_log_bulk:saved", received, saved, items: out },
      { truncated },
      origin
    );
  } catch (e) {
    return fail("cal_game_log_bulk:error", { message: String(e && e.message ? e.message : e) }, 500, origin);
  }
}



function getEnvShim() {
  // In Service Worker syntax, bindings are available as globals.
  // KV: RTP_CACHE
  // Vars: ODDS_API_KEY, UI_ORIGIN (if defined)
  return {
    RTP_CACHE: typeof RTP_CACHE !== "undefined" ? RTP_CACHE : null,
    ODDS_API_KEY: typeof ODDS_API_KEY !== "undefined" ? ODDS_API_KEY : "",
    UI_ORIGIN: typeof UI_ORIGIN !== "undefined" ? UI_ORIGIN : "",

    // Ball Don't Lie (NFL) — Injuries
    BDL_NFL_API_KEY: typeof BDL_NFL_API_KEY !== "undefined" ? BDL_NFL_API_KEY : "",

    // Mateo (optional secondary injury feed)
    MATEO_INJURY_URL: typeof MATEO_INJURY_URL !== "undefined" ? MATEO_INJURY_URL : "",
    MATEO_API_KEY: typeof MATEO_API_KEY !== "undefined" ? MATEO_API_KEY : ""
  };
}

// ---------------------------
// Weather (Open-Meteo) - read-only wiring (no scoring changes yet)
// ---------------------------

// Stadium metadata: lat/lon + timezone + dome flag.
// NOTE: If dome=true, we short-circuit and return {dome:true}.
const NFL_STADIUM = {
  ARI: { name: "State Farm Stadium", lat: 33.5276, lon: -112.2626, tz: "America/Phoenix", dome: true },
  ATL: { name: "Mercedes-Benz Stadium", lat: 33.7553, lon: -84.4006, tz: "America/New_York", dome: true },
  BAL: { name: "M&T Bank Stadium", lat: 39.2780, lon: -76.6227, tz: "America/New_York", dome: false },
  BUF: { name: "Highmark Stadium", lat: 42.7738, lon: -78.7869, tz: "America/New_York", dome: false },
  CAR: { name: "Bank of America Stadium", lat: 35.2258, lon: -80.8528, tz: "America/New_York", dome: false },
  CHI: { name: "Soldier Field", lat: 41.8623, lon: -87.6167, tz: "America/Chicago", dome: false },
  CIN: { name: "Paycor Stadium", lat: 39.0955, lon: -84.5160, tz: "America/New_York", dome: false },
  CLE: { name: "Cleveland Browns Stadium", lat: 41.5061, lon: -81.6995, tz: "America/New_York", dome: false },
  DAL: { name: "AT&T Stadium", lat: 32.7473, lon: -97.0945, tz: "America/Chicago", dome: true },
  DEN: { name: "Empower Field at Mile High", lat: 39.7439, lon: -105.0201, tz: "America/Denver", dome: false },
  DET: { name: "Ford Field", lat: 42.3400, lon: -83.0456, tz: "America/New_York", dome: true },
  GB:  { name: "Lambeau Field", lat: 44.5013, lon: -88.0622, tz: "America/Chicago", dome: false },
  HOU: { name: "NRG Stadium", lat: 29.6847, lon: -95.4107, tz: "America/Chicago", dome: true },
  IND: { name: "Lucas Oil Stadium", lat: 39.7601, lon: -86.1639, tz: "America/Indiana/Indianapolis", dome: true },
  JAX: { name: "EverBank Stadium", lat: 30.3239, lon: -81.6373, tz: "America/New_York", dome: false },
  KC:  { name: "GEHA Field at Arrowhead Stadium", lat: 39.0489, lon: -94.4839, tz: "America/Chicago", dome: false },
  LV:  { name: "Allegiant Stadium", lat: 36.0908, lon: -115.1830, tz: "America/Los_Angeles", dome: true },
  LAC: { name: "SoFi Stadium", lat: 33.9535, lon: -118.3392, tz: "America/Los_Angeles", dome: true },
  LAR: { name: "SoFi Stadium", lat: 33.9535, lon: -118.3392, tz: "America/Los_Angeles", dome: true },
  MIA: { name: "Hard Rock Stadium", lat: 25.9580, lon: -80.2389, tz: "America/New_York", dome: false },
  MIN: { name: "U.S. Bank Stadium", lat: 44.9738, lon: -93.2581, tz: "America/Chicago", dome: true },
  NE:  { name: "Gillette Stadium", lat: 42.0909, lon: -71.2643, tz: "America/New_York", dome: false },
  NO:  { name: "Caesars Superdome", lat: 29.9511, lon: -90.0812, tz: "America/Chicago", dome: true },
  NYG: { name: "MetLife Stadium", lat: 40.8135, lon: -74.0745, tz: "America/New_York", dome: false },
  NYJ: { name: "MetLife Stadium", lat: 40.8135, lon: -74.0745, tz: "America/New_York", dome: false },
  PHI: { name: "Lincoln Financial Field", lat: 39.9008, lon: -75.1675, tz: "America/New_York", dome: false },
  PIT: { name: "Acrisure Stadium", lat: 40.4468, lon: -80.0158, tz: "America/New_York", dome: false },
  SF:  { name: "Levi's Stadium", lat: 37.4030, lon: -121.9700, tz: "America/Los_Angeles", dome: false },
  SEA: { name: "Lumen Field", lat: 47.5952, lon: -122.3316, tz: "America/Los_Angeles", dome: false },
  TB:  { name: "Raymond James Stadium", lat: 27.9759, lon: -82.5033, tz: "America/New_York", dome: false },
  TEN: { name: "Nissan Stadium", lat: 36.1665, lon: -86.7713, tz: "America/Chicago", dome: false },
  WAS: { name: "Northwest Stadium", lat: 38.9078, lon: -76.8645, tz: "America/New_York", dome: false }
};

function toISOHour(d) {
  const x = new Date(d);
  x.setMinutes(0, 0, 0);
  return x.toISOString().slice(0, 13) + ":00";
}

function pickClosestHourIndex(times, targetDate) {
  const t0 = new Date(targetDate).getTime();
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < (times || []).length; i++) {
    const td = Math.abs(new Date(times[i]).getTime() - t0);
    if (td < bestD) {
      bestD = td;
      bestI = i;
    }
  }
  return bestI;
}

// KV-backed cache to avoid Open-Meteo rate limits (429) and reduce duplicate calls.
// Cache key is by team + kickoff hour (UTC) to keep it deterministic.
function weatherCacheKey(teamAbbr, kickoffISO) {
  const t = normalizeTeamAbbr(teamAbbr) || "UNK";
  const k = kickoffISO ? new Date(kickoffISO) : new Date();
  return `wx:openmeteo:${t}:${toISOHour(k)}`;
}

async function fetchOpenMeteoWeatherCached(env, teamAbbr, stadium, kickoffISO) {
  const key = weatherCacheKey(teamAbbr, kickoffISO);
  // 1) Serve fresh cache if present
  try {
    const cached = await kvGet(env, key);
    if (cached && cached.ok && cached.weather && cached.weather.ok) {
      return { ...cached.weather, cache: { hit: true, key } };
    }
  } catch {}

  // 2) Fetch upstream
  const wx = await fetchOpenMeteoWeather(stadium, kickoffISO);

  // 3) If success, cache it for 6h
  if (wx && wx.ok) {
    try { await kvPut(env, key, { ok: true, weather: wx, saved: nowISO() }, 6 * 3600); } catch {}
    return { ...wx, cache: { hit: false, key } };
  }

  // 4) If rate-limited or error, attempt stale cache fallback (if any)
  try {
    const cached = await kvGet(env, key);
    if (cached && cached.weather && cached.weather.ok) {
      return { ...cached.weather, cache: { hit: true, stale_fallback: true, key }, upstream_error: wx };
    }
  } catch {}

  return wx;
}

async function fetchOpenMeteoWeather(stadium, kickoffISO) {
  const k = new Date(kickoffISO || new Date().toISOString());
  const start = new Date(k.getTime() - 2 * 3600 * 1000);
  const end = new Date(k.getTime() + 4 * 3600 * 1000);

  const qs = new URLSearchParams();
  qs.set("latitude", String(stadium.lat));
  qs.set("longitude", String(stadium.lon));
  qs.set("timezone", stadium.tz || "auto");
  qs.set("temperature_unit", "fahrenheit");
  qs.set("windspeed_unit", "mph");
  // Keep hourly minimal but useful
  qs.set("hourly", [
    "temperature_2m",
    "apparent_temperature",
    "precipitation_probability",
    "precipitation",
    "snowfall",
    "wind_speed_10m",
    "wind_gusts_10m",
    "wind_direction_10m"
  ].join(","));
  qs.set("current", [
    "temperature_2m",
    "apparent_temperature",
    "wind_speed_10m",
    "wind_gusts_10m",
    "wind_direction_10m",
    "precipitation",
    "snowfall",
    "is_day"
  ].join(","));
  qs.set("start_hour", toISOHour(start));
  qs.set("end_hour", toISOHour(end));

  const url = "https://api.open-meteo.com/v1/forecast?" + qs.toString();
  const r = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    return { ok: false, status: r.status, error: "open_meteo_http", body: (text || "").slice(0, 300) };
  }

  const times = j?.hourly?.time || [];
  const i = pickClosestHourIndex(times, k);
  const hourly = j?.hourly || {};
  const current = j?.current || {};

  return {
    ok: true,
    source: "open-meteo",
    stadium: stadium.name,
    kickoff: kickoffISO || null,
    at: times[i] || null,
    current,
    hourly_at: {
      temperature_2m: hourly.temperature_2m?.[i],
      apparent_temperature: hourly.apparent_temperature?.[i],
      precipitation_probability: hourly.precipitation_probability?.[i],
      precipitation: hourly.precipitation?.[i],
      snowfall: hourly.snowfall?.[i],
      wind_speed_10m: hourly.wind_speed_10m?.[i],
      wind_gusts_10m: hourly.wind_gusts_10m?.[i],
      wind_direction_10m: hourly.wind_direction_10m?.[i]
    },
    units: {
      temp: "F",
      wind: "mph",
      precipitation: j?.hourly_units?.precipitation || "",
      snowfall: j?.hourly_units?.snowfall || ""
    },
    meta: {
      latitude: j?.latitude,
      longitude: j?.longitude,
      elevation: j?.elevation,
      timezone: j?.timezone,
      generationtime_ms: j?.generationtime_ms
    }
  };
}

async function handleNFLWeather(req, env) {
  const u = new URL(req.url);
  const team = String(u.searchParams.get("team") || "").toUpperCase();
  const kickoff = u.searchParams.get("kickoff") || null;
  const st = NFL_STADIUM[team];
  if (!st) return fail("weather:unknown_team", 400, { team }, null);

  if (st.dome) {
    return ok({ team, stadium: st.name, dome: true, weather: { ok: true, source: "dome", note: "indoor" } });
  }

  const kickoffUse = kickoff || new Date().toISOString();
  const wx = await fetchOpenMeteoWeatherCached(env, team, st, kickoffUse);
  return ok({ team, stadium: st.name, dome: false, weather: wx });
}

// ---------------------------
// Batch Prefetch (Weather + Injuries)
// ---------------------------
// Goal: run ONCE (or twice: early/late) for the whole slate, cache in KV, then reuse in /matchup/sim.
//
// GET /prefetch/batch?season=2025&week=19&source=bdl&window=early|late|all&tz=America/New_York
//   - window=early: games with kickoff ET < 17:00
//   - window=late : games with kickoff ET >= 17:00
//   - window=all  : all games
//
// Response: counts and KV keys written.
async function handlePrefetchBatch(req, env) {
  const url = new URL(req.url);
  const season = Number(url.searchParams.get('season') || inferNFLSeasonFromNowNY());
  const week = String(url.searchParams.get('week') || inferNFLWeekFromNowNY());
  const source = String(url.searchParams.get('source') || 'bdl').toLowerCase();
  const window = String(url.searchParams.get('window') || 'all').toLowerCase();
  const tz = String(url.searchParams.get('tz') || 'America/New_York');

  // 1) Injuries: build once (KV key: nfl:injuries:season:week:source:v1)
  // NOTE: We avoid calling the HTTP handler here so we don't depend on "origin" plumbing.
  let injuriesBuild = { ok: false, error: 'skipped' };
  try {
    if (source === 'bdl') {
      const bdl = await fetchAllBdlPlayerInjuries(env, 100, 80);
      if (bdl.ok) {
        const map = buildBdlTeamInjuryMap(bdl.data);
        const out = {};
        for (const abbr of Object.keys(map)) {
          const summary = map[abbr];
          const inj_total = injuryPenaltyFromCounts(summary.counts);
          out[abbr] = {
            inj_total,
            injuries_summary: summary,
            _injury_penalty: inj_total,
            source: { vendor: 'bdl', pages: bdl.pages, count: bdl.count }
          };
        }
        const key = injuriesCacheKey(season, week, 'bdl');
        const payload = { season, week: week || null, asOf: new Date().toISOString(), vendor: 'bdl', teams: out };
        await env.RTP_CACHE.put(key, JSON.stringify(payload), { expirationTtl: 60 * 60 });
        injuriesBuild = { ok: true, key, teams: Object.keys(out).length };
      } else {
        injuriesBuild = { ok: false, error: 'bdl_fetch_failed', status: bdl.status };
      }
    } else if (source === 'mateo') {
      const m = await mateoFetchInjuries(env);
      if (m.ok) {
        const teams = m?.json?.teams && typeof m.json.teams === 'object' ? m.json.teams : null;
        const out = {};
        if (teams) {
          for (const k of Object.keys(teams)) {
            const abbr = normalizeTeamAbbr(k);
            const summary = teams[k] || {};
            const counts = summary.counts || summary?.injuries_summary?.counts || {};
            const players = summary.players || summary?.injuries_summary?.players || [];
            const normalized = { counts: { out:0, doubtful:0, questionable:0, probable:0, ir:0, other:0, ...counts }, players: Array.isArray(players) ? players : [] };
            const inj_total = injuryPenaltyFromCounts(normalized.counts);
            out[abbr] = { inj_total, injuries_summary: normalized, _injury_penalty: inj_total, source: { vendor: 'mateo' } };
          }
        }
        const key = injuriesCacheKey(season, week, 'mateo');
        const payload = { season, week: week || null, asOf: new Date().toISOString(), vendor: 'mateo', teams: out };
        await env.RTP_CACHE.put(key, JSON.stringify(payload), { expirationTtl: 60 * 60 });
        injuriesBuild = { ok: true, key, teams: Object.keys(out).length };
      } else {
        injuriesBuild = { ok: false, error: 'mateo_fetch_failed', status: m.status };
      }
    } else {
      // ESPN build is heavier; keep it opt-in.
      injuriesBuild = { ok: false, error: 'unsupported_source_for_prefetch', source };
    }
  } catch (e) {
    injuriesBuild = { ok: false, error: String(e?.message || e) };
  }

  // 2) Slate: pull from Odds API (/game-lines) so we know the day's games + kickoff times
  const games = await getGameLines(env);

  // 3) Weather: prefetch & cache per home team + kickoff hour (existing cache key strategy)
  const nowMs = Date.now();
  const results = [];
  let attempted = 0;
  let cached = 0;
  let failed = 0;

  for (const g of games) {
    const kickoffIso = g?.commence || null;
    const home = g?.home || null;
    const away = g?.away || null;
    if (!kickoffIso || !home || !away) continue;

    // window filter based on ET kickoff hour
    const kickoffEt = isoToTz(kickoffIso, tz);
    const hourEt = Number(String(kickoffEt).slice(11, 13));
    if (window === 'early' && hourEt >= 17) continue;
    if (window === 'late' && hourEt < 17) continue;

    attempted++;
    try {
      // getNFLWeatherForTeam uses KV caching + respects tz
      const wx = await getNFLWeatherForTeam(home, env, kickoffIso, tz);
      if (wx?.ok) cached++;
      else failed++;
      results.push({ matchup: `${away}@${home}`, kickoff_et: kickoffEt, weather_ok: !!wx?.ok, weather_err: wx?.error || '' });
    } catch (e) {
      failed++;
      results.push({ matchup: `${away}@${home}`, kickoff_et: null, weather_ok: false, weather_err: String(e?.message || e) });
    }
  }

  return ok({
    season,
    week,
    source,
    window,
    tz,
    injuries_build: injuriesBuild?.ok ? 'ok' : 'failed',
    injuries_key: injuriesBuild?.key || null,
    injuries_teams: injuriesBuild?.teams || null,
    games_total: games.length,
    weather_attempted: attempted,
    weather_cached_ok: cached,
    weather_failed: failed,
    sample: results.slice(0, 20),
    note: 'Run this 60 minutes before kickoff. /matchup/sim will reuse KV and avoid repeated upstream calls.'
  }, { endpoint: 'prefetch/batch' });
}

// ---------- Weather helpers (read-only; no scoring changes) ----------
function fmtTZ(isoOrDate, tz) {
  try {
    const d = isoOrDate instanceof Date ? isoOrDate : new Date(String(isoOrDate));
    if (!Number.isFinite(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).formatToParts(d);
    const get = (t) => parts.find(p => p.type === t)?.value;
    const y = get("year"), m = get("month"), da = get("day"), hh = get("hour"), mm = get("minute"), ss = get("second");
    if (!y || !m || !da || !hh || !mm || !ss) return null;
    return `${y}-${m}-${da}T${hh}:${mm}:${ss}`;
  } catch (_) {
    return null;
  }
}

function computeWeatherRisk(wx) {
  // Uses kickoff-hour bucket if available, else current.
  const h = (wx && wx.hourly_at) ? wx.hourly_at : (wx && wx.current) ? wx.current : null;
  if (!wx || !wx.ok || !h) return { level: "UNKNOWN", score: 0, tags: ["NO_WEATHER"] };

  const gust = num(h.wind_gusts_10m, 0);
  const wind = num(h.wind_speed_10m, 0);
  const app = num(h.apparent_temperature, NaN);
  const temp = num(h.temperature_2m, NaN);
  const pprob = num(h.precipitation_probability, 0);
  const precip = num(h.precipitation, 0);
  const snow = num(h.snowfall, 0);

  let score = 0;
  const tags = [];

  if (gust >= 20) { score += 2; tags.push(`GUST_${Math.round(gust)}`); }
  else if (gust >= 15) { score += 1; tags.push(`GUST_${Math.round(gust)}`); }

  if (wind >= 15) { score += 1; tags.push(`WIND_${Math.round(wind)}`); }

  if (Number.isFinite(app) && app <= 15) { score += 1; tags.push(`FEELS_${Math.round(app)}`); }
  if (Number.isFinite(temp) && temp <= 25) { score += 1; tags.push(`TEMP_${Math.round(temp)}`); }

  if (pprob >= 50) { score += 1; tags.push(`PPOP_${Math.round(pprob)}`); }
  if (precip >= 0.5) { score += 1; tags.push(`PRECIP_${precip.toFixed(1)}`); }
  if (snow > 0) { score += 1; tags.push(`SNOW_${snow.toFixed(1)}`); }

  // Translate score to a simple badge.
  const level = score >= 4 ? "HIGH" : score >= 2 ? "MED" : "LOW";
  return { level, score, tags };
}

addEventListener("fetch", event => {
  event.respondWith(handleFetch(event));
});

async function handleFetch(event) {
  const req = event.request;
  const ctx = event; // crude but enough for waitUntil if you ever use it
  const env = getEnvShim();

  const url = new URL(req.url);
  const reqOrigin = normalizeOrigin(req.headers.get("origin") || "");
  const uiOrigin = normalizeOrigin(env.UI_ORIGIN || "");
  const allow = new Set([
    uiOrigin,
    "https://rtpthebrain.pages.dev",
    "https://dash.cloudflare.com"
  ].filter(Boolean));
  // Default to UI_ORIGIN if set; otherwise fall back to request origin; else '*'
  const origin = (reqOrigin && allow.has(reqOrigin)) ? reqOrigin : (uiOrigin || reqOrigin || "*");

  // Guard: ensure KV exists
  if (!env.RTP_CACHE) {
    return jsonResponse(
      500,
      {
        ok: false,
        data: null,
        meta: { hint: "RTP_CACHE binding missing in Worker settings." },
        error: "missing_RTP_CACHE_binding"
      },
      origin
    );
  }

  function normalizeOrigin(v) {
    if (typeof v !== "string") return "";
    return v.trim();
  }

  function corsHeaders(origin) {
    const o = normalizeOrigin(origin) || "*";
    return {
      "access-control-allow-origin": o,
      "access-control-allow-headers": "Content-Type, Authorization, X-Requested-With",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-max-age": "86400"
    };
  }

  // Attach CORS headers to an existing Response (used by endpoints that return raw Response)
  function withCors(resp, origin) {
    try {
      if (!(resp instanceof Response)) {
        // If handler returned a plain object/string by mistake, wrap it.
        return new Response(
          typeof resp === "string" ? resp : JSON.stringify(resp ?? { ok: false, error: "invalid_response" }),
          {
            status: 200,
            headers: {
              "content-type": typeof resp === "string" ? "text/plain" : "application/json",
              ...corsHeaders(origin)
            }
          }
        );
      }
      const h = new Headers(resp.headers);
      const ch = corsHeaders(origin);
      for (const [k, v] of Object.entries(ch)) h.set(k, v);
      // Avoid stripping body/stream; clone via Response constructor.
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
    } catch (e) {
      // Worst-case fallback
      return new Response(JSON.stringify({ ok: false, error: "withCors_failed", detail: String(e?.message || e) }), {
        status: 500,
        headers: { "content-type": "application/json", ...corsHeaders(origin) }
      });
    }
  }
  
  function handleOptions(req, origin) {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  
  // inside fetch handler:
  if (req.method === "OPTIONS") {
    return handleOptions(req, origin);
  }


  try {
    const pathname = url.pathname;

    if ((pathname === "/" || pathname === "/health") && req.method === "GET") {
      return handleHealth(req, env, origin);
    }

    if (pathname === "/status" && req.method === "GET") {
      return handleStatus(req, env, origin);
    }

    // Weather (Open-Meteo) - read-only
    // GET /nfl/weather?team=CHI&kickoff=2026-01-17T18:30:00-06:00
    if (pathname === "/nfl/weather" && req.method === "GET") {
      return withCors(await handleNFLWeather(req, env), origin);
    }
    if (pathname === "/prefetch/batch" && req.method === "GET") {
      return withCors(await handlePrefetchBatch(req, env), origin);
    }

    if (pathname === "/kv/list" && req.method === "GET") {
      return handleKvList(req, env, origin);
    }

    if (pathname === "/game-lines" && req.method === "GET") {
      return handleGameLinesGet(req, env, origin);
    }

    if (pathname === "/edges/games" && req.method === "GET") {
      return handleGameEdges(req, env, origin);
    }

    if (pathname === "/anchors/nfl" && req.method === "GET") {
      return handleAnchorsNFL(req, env, origin);
    }


    if (pathname === "/anchors/today" && req.method === "GET") {
      return handleAnchorsToday(req, env, origin);
    }

    if (pathname === "/anchors/backtest" && req.method === "GET") {
      return handleAnchorsBacktest(req, env, origin);
    }

    if (pathname === "/anchors/rows" && req.method === "POST") {
      return handleAnchorsForRows(req, env, origin);
    }

    if (pathname === "/teams/get" && req.method === "GET") {
      return handleTeamStatsGet(req, env, origin);
    }


    if (pathname === "/teams/audit" && req.method === "GET") {
      return handleTeamsAudit(req, env, origin);
    }



// ===== Stat registry + weights =====
if (pathname === "/stats/registry" && req.method === "GET") {
  return handleStatsRegistry(req, env, origin);
}

if (pathname === "/stats/weights" && req.method === "GET") {
  return handleStatsWeightsGet(req, env, origin);
}

if (pathname === "/stats/weights" && req.method === "POST") {
  return handleStatsWeightsPost(req, env, origin);
}

if (pathname === "/teams/features" && req.method === "GET") {
  return handleTeamsFeatures(req, env, origin);
}


    if (
      (pathname === "/teams/ingest" || pathname === "/teams/ingest/bulk") &&
      req.method === "POST"
    ) {
      return handleTeamStatsIngest(req, env, origin);
    }

    if (pathname === "/teams/upload" && req.method === "POST") {
      return handleTeamsUpload(req, env, origin);
    }

    if (pathname === "/injuries/ingest" && req.method === "POST") {
      return handleInjuriesIngest(req, env, origin);
    }

    if (pathname === "/injuries/build" && req.method === "GET") {
      return handleInjuriesBuild(req, env, origin);
    }

    if (pathname === "/injuries/get" && req.method === "GET") {
      return handleInjuriesGet(req, env, origin);
    }

    if (pathname === "/injuries/all" && req.method === "GET") {
      return handleInjuriesAll(req, env, origin);
    }

    if (pathname === "/matchup/sim" && (req.method === "GET" || req.method === "POST")) {
      return handleMatchupSim(req, env, origin);
    }

    if (pathname === "/ingest" && req.method === "POST") {
      return handleIngest(req, env, origin);
    }

    if (pathname === "/score" && req.method === "POST") {
      return handleScore(req, env, origin);
    }

    // ===== Props pipeline routes =====
    if (pathname === "/props/upload" && req.method === "POST") {
      return handlePropsUpload(req, env, url, origin);
    }

    if (pathname === "/props/list" && req.method === "GET") {
      return handlePropsList(req, env, url, origin);
    }

    if (pathname === "/props/export.csv" && req.method === "GET") {
      return handlePropsExportCsv(req, env, url, origin);
    }

    if (pathname === "/props/sim" && req.method === "POST") {
      return handlePropsSim(req, env, origin, url);
    }

    if (pathname === "/props/grade" && req.method === "GET") {
      return handlePropsGrade(req, env, url, origin);
    }

    if (pathname === "/props/eval" && req.method === "POST") {
      return handlePropsEval(req, env, origin, url);
    }


    if (pathname === "/props/cache" && req.method === "GET") {
      return handlePropsGet(req, env, origin);
    }

    if (pathname === "/props/nfl/sim" && req.method === "POST") {
      return handleNflPropsSim(req, env, origin);
    }

    if (pathname === "/csv/sim" && req.method === "POST") {
      return handleCsvSim(req, env, origin);
    }

    if (pathname === "/predict" && req.method === "GET") {
      return handlePredict(req, env, origin);
    }

    if (pathname === "/debug/elite-team" && req.method === "GET") {
      return handleEliteTeamDebug(req, env, origin);
    }

    if (pathname === "/debug/elite-matchup" && req.method === "POST") {
      return handleEliteMatchupDebug(req, env, origin);
    }

    if (pathname === "/debug/modifiers" && req.method === "GET") {
      return handleDebugModifiers(req, env, origin);
    }

    if (pathname === "/cal/ingest" && req.method === "POST") {
      return handleCalIngest(req, env, origin);
    }

    if (pathname === "/cal/summary" && req.method === "GET") {
      return handleCalSummary(req, env, origin);
    }

    if (pathname === "/cal/rebuild-lines-v2" && req.method === "POST") {
      return handleCalRebuildFromLinesV2(req, env, origin);
    }

    if (pathname === "/cal/set" && req.method === "POST") {
      return handleCalSetManual(req, env, origin);
    }

    if (pathname === "/cal/game/log" && req.method === "POST") {
      return handleCalGameLogV2(req, env, origin);
    }

    if (pathname === "/cal/game/log.bulk" && req.method === "POST") {
      return handleCalGameLogBulk(req, env, origin);
    }

    
if (pathname === "/cal/game/delete" && req.method === "POST") {
  return handleCalGameDelete(req, env, origin);
}

if (pathname === "/cal/game/list" && req.method === "GET") {
      return handleCalGameList(req, env, origin);
    }

    if (pathname === "/cal/metrics" && req.method === "GET") {
      return handleCalMetrics(req, env, origin);
    }

    if (pathname === "/cal/fit" && (req.method === "GET" || req.method === "POST")) {
      return handleCalFit(req, env, origin);
    }

    if (pathname === "/cal/fit/latest" && req.method === "GET") {
      return handleCalFitLatest(req, env, origin);
    }

    if (pathname === "/schema/check" && req.method === "GET") {
      return handleSchemaCheck(req, env, origin);
    }

    if (pathname === "/audit/league" && req.method === "GET") {
      return handleAuditLeague(req, env, origin);
    }

    if (pathname === "/teams/export.csv" && req.method === "GET") {
      return handleTeamsExportCsv(req, env, origin);
    }

    if (pathname === "/props/export.csv" && req.method === "GET") {
      return handlePropsExportCsv(req, env, origin);
    }

    return fail("not_found", { path: pathname }, 404, origin);
  } catch (err) {
    console.error(err);
    return fail(`internal_error:${err.message || String(err)}`, {}, 500, origin);
  }
}

// KV debug: list keys by prefix (safe, read-only)
async function handleKvList(req, env, origin) {
  try {
    const url = new URL(req.url);
    const prefix = url.searchParams.get("prefix") || "";
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") || 200)));
    if (!prefix) {
      return jsonResponse({ ok: false, data: null, meta: { build: BUILD }, error: "kv_list:missing_prefix" }, 400, origin);
    }
    const keysObj = await listAllKeys(env, prefix);
    const names = Array.isArray(keysObj) ? keysObj.map(k => (typeof k === "string" ? k : (k && k.name) ? k.name : String(k))) : [];
    const out = names.slice(0, limit);
    return jsonResponse({ ok: true, data: { prefix, count: names.length, items: out }, meta: { build: BUILD } , error: null }, 200, origin);
  } catch (e) {
    return jsonResponse({ ok: false, data: null, meta: { build: BUILD }, error: "kv_list:" + String(e && e.message ? e.message : e) }, 500, origin);
  }
}
// === END OF WORKER (v25.validated) ===

