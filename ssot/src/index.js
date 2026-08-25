import { BUILD, SCHEMA_VERSION, secureEqualText, safeSeason, safeSeasonType } from "./core.js";
import {
  runBudgetedPhase, certifyGames, certifyTeamStats, seasonAudit
} from "./phases.js";
import { getRun } from "./store.js";
export { SeasonReconstructionWorkflow } from "./workflow.js";

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function cors(origin) {
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "access-control-max-age": "86400",
  };
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors(origin))) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function allowedOrigin(request, env) {
  const requestOrigin = request.headers.get("origin") || "";
  const configured = String(env.UI_ORIGIN || "").trim();
  if (!configured) return requestOrigin || "*";
  return requestOrigin === configured ? configured : configured;
}

async function requireAdmin(request, env) {
  if (!env.SSOT_ADMIN_TOKEN) return { ok: false, status: 500, error: "missing_SSOT_ADMIN_TOKEN" };
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const ok = await secureEqualText(token, env.SSOT_ADMIN_TOKEN);
  return ok ? { ok: true } : { ok: false, status: 401, error: "unauthorized" };
}

async function bodyJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("invalid_json_body");
  }
}

async function bindingsHealth(env) {
  return {
    NFL_DB: !!env.NFL_DB,
    NFL_RAW: !!env.NFL_RAW,
    BDL_API_KEY: !!env.BDL_API_KEY,
    SSOT_ADMIN_TOKEN: !!env.SSOT_ADMIN_TOKEN,
    SSOT_RECONSTRUCTION: !!env.SSOT_RECONSTRUCTION,
  };
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/" || path === "/health") {
    const bindings = await bindingsHealth(env);
    const ok = Object.values(bindings).every(Boolean);
    return json({
      ok,
      data: {
        build: BUILD,
        schema_version: SCHEMA_VERSION,
        role: "authoritative_factual_ssot_ingest",
        model_math_mutated: false,
        bindings,
        routes: [
          "GET /health",
          "GET /ssot/schema",
          "POST /ssot/ingest/games",
          "POST /ssot/ingest/team-stats",
          "POST /ssot/certify/games",
          "POST /ssot/certify/team-stats",
          "POST /ssot/workflows/season",
          "GET /ssot/workflows/status?id=...",
          "GET /ssot/audit/season?season=2025",
          "GET /ssot/debug/run?run_id=...",
          "GET /ssot/debug/game?bdl_game_id=...",
        ],
      },
      error: ok ? null : "missing_required_bindings",
    }, ok ? 200 : 500);
  }

  if (path === "/ssot/schema" && request.method === "GET") {
    return json({
      ok: true,
      data: {
        schema_version: SCHEMA_VERSION,
        authority: {
          games: "BALLDONTLIE /nfl/v1/games",
          team_game_stats: "BALLDONTLIE /nfl/v1/team_stats",
          raw_archive: "R2 NFL_RAW",
          canonical_store: "D1 NFL_DB",
        },
        leakage_policy: "raw facts only; no prediction/calibration writes in this worker",
        final_team_stats_contract: "exactly two canonical team-stat rows per final game",
      },
      error: null,
    });
  }

  if (path.startsWith("/ssot/") && request.method === "POST") {
    const auth = await requireAdmin(request, env);
    if (!auth.ok) return json({ ok: false, data: null, error: auth.error }, auth.status);
  }

  if (path === "/ssot/ingest/games" && request.method === "POST") {
    const b = await bodyJson(request);
    return json(await runBudgetedPhase(env, { ...b, phase: "games" }));
  }

  if (path === "/ssot/ingest/team-stats" && request.method === "POST") {
    const b = await bodyJson(request);
    return json(await runBudgetedPhase(env, { ...b, phase: "team_stats" }));
  }

  if (path === "/ssot/certify/games" && request.method === "POST") {
    const b = await bodyJson(request);
    const cert = await certifyGames(env, safeSeason(b.season), safeSeasonType(b.season_type));
    return json({ ok: cert.certified, data: cert, error: cert.certified ? null : "games_not_certified" },
      cert.certified ? 200 : 409);
  }

  if (path === "/ssot/certify/team-stats" && request.method === "POST") {
    const b = await bodyJson(request);
    const cert = await certifyTeamStats(env, safeSeason(b.season), safeSeasonType(b.season_type));
    return json({ ok: cert.certified, data: cert, error: cert.certified ? null : "team_stats_not_certified" },
      cert.certified ? 200 : 409);
  }

  if (path === "/ssot/workflows/season" && request.method === "POST") {
    if (!env.SSOT_RECONSTRUCTION) return json({ ok: false, error: "missing_workflow_binding" }, 500);
    const b = await bodyJson(request);
    const season = safeSeason(b.season || 2025);
    const id = String(b.run_id || `ssot-${season}-${crypto.randomUUID()}`).slice(0, 100);
    const instance = await env.SSOT_RECONSTRUCTION.create({
      id,
      params: {
        season,
        season_types: b.season_types || [2, 3],
        run_id: id,
      },
      retention: {
        successRetention: "7 days",
        errorRetention: "30 days",
      },
    });
    return json({ ok: true, data: { id: instance.id, status: await instance.status() }, error: null }, 202);
  }

  if (path === "/ssot/workflows/status" && request.method === "GET") {
    const id = url.searchParams.get("id");
    if (!id) return json({ ok: false, error: "missing_id" }, 400);
    const instance = await env.SSOT_RECONSTRUCTION.get(id);
    return json({ ok: true, data: { id, status: await instance.status() }, error: null });
  }

  if (path === "/ssot/audit/season" && request.method === "GET") {
    const season = safeSeason(url.searchParams.get("season") || 2025);
    return json({ ok: true, data: await seasonAudit(env, season), error: null });
  }

  if (path === "/ssot/debug/run" && request.method === "GET") {
    const runId = url.searchParams.get("run_id");
    if (!runId) return json({ ok: false, error: "missing_run_id" }, 400);
    const run = await getRun(env, runId);
    if (!run) return json({ ok: false, error: "run_not_found" }, 404);
    const receipts = await env.NFL_DB.prepare(`
      SELECT * FROM ingest_receipts WHERE run_id=? ORDER BY created_at
    `).bind(runId).all();
    return json({ ok: true, data: { run, receipts: receipts.results || [] }, error: null });
  }

  if (path === "/ssot/debug/game" && request.method === "GET") {
    const bdlGameId = Number(url.searchParams.get("bdl_game_id"));
    if (!Number.isInteger(bdlGameId)) return json({ ok: false, error: "invalid_bdl_game_id" }, 400);
    const game = await env.NFL_DB.prepare(`SELECT * FROM nfl_games WHERE bdl_game_id=?`).bind(bdlGameId).first();
    if (!game) return json({ ok: false, error: "game_not_found" }, 404);
    const stats = await env.NFL_DB.prepare(`
      SELECT * FROM nfl_team_game_stats WHERE game_id=? ORDER BY home_away
    `).bind(game.game_id).all();
    return json({ ok: true, data: { game, team_stats: stats.results || [] }, error: null });
  }

  return json({ ok: false, data: null, error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    try {
      return withCors(await handle(request, env), origin);
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        build: BUILD,
        path: new URL(request.url).pathname,
        error: String(error?.message || error),
      }));
      return withCors(json({
        ok: false,
        data: null,
        meta: { build: BUILD, schema_version: SCHEMA_VERSION },
        error: String(error?.message || error),
      }, 500), origin);
    }
  },
};
