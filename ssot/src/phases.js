import {
  BUILD, makeBudget, budgetCanContinue, markBudgetPage, normalizeGame,
  normalizeTeamStat, safeSeason, safeSeasonType, sha256Hex
} from "./core.js";
import { bdlFetchPage } from "./bdl.js";
import {
  archivePage, ensureRun, getRun, updateRun, upsertGames, upsertTeamStats,
  writeReceipt, upsertCertification
} from "./store.js";

function runIdFor(phase, season, seasonType) {
  return `${phase}-${season}-t${seasonType}-${crypto.randomUUID()}`.slice(0, 100);
}

async function receiptId(runId, phase, cursor, payloadHash) {
  return await sha256Hex(`${runId}|${phase}|${cursor ?? "START"}|${payloadHash}`);
}

export async function ingestPage(env, { phase, season, season_type, cursor = null, run_id = null }) {
  season = safeSeason(season);
  const seasonType = safeSeasonType(season_type);
  const observedAt = new Date().toISOString();

  let page;
  let normalized;
  if (phase === "games") {
    page = await bdlFetchPage(env, "games", {
      seasons: [season],
      season_type: [seasonType],
      cursor,
      per_page: 100,
    });
    normalized = page.data.map(x => normalizeGame(x, observedAt));
  } else if (phase === "team_stats") {
    page = await bdlFetchPage(env, "team_stats", {
      seasons: [season],
      season_type: seasonType,
      cursor,
      per_page: 100,
    });
    normalized = page.data.map(x => normalizeTeamStat(x, observedAt));
  } else {
    throw new Error("unsupported_phase");
  }

  const archive = await archivePage(env, {
    phase,
    season,
    seasonType,
    cursor,
    rawText: page.raw_text,
  });

  const stored = phase === "games"
    ? await upsertGames(env, normalized, archive)
    : await upsertTeamStats(env, normalized, archive);

  const actualRunId = run_id || runIdFor(phase, season, seasonType);
  await writeReceipt(env, {
    receipt_id: await receiptId(actualRunId, phase, cursor, archive.payload_hash),
    run_id: actualRunId,
    phase,
    season,
    season_type: seasonType,
    page_cursor: cursor,
    next_cursor: page.next_cursor,
    source_row_count: page.data.length,
    stored_row_count: stored,
    payload_hash: archive.payload_hash,
    raw_r2_key: archive.r2_key,
    created_at: observedAt,
  });

  return {
    run_id: actualRunId,
    phase,
    season,
    season_type: seasonType,
    cursor,
    next_cursor: page.next_cursor,
    source_rows: page.data.length,
    stored_rows: stored,
    payload_hash: archive.payload_hash,
    raw_r2_key: archive.r2_key,
    complete: page.next_cursor === null || page.next_cursor === undefined,
    build: BUILD,
  };
}

export async function runBudgetedPhase(env, input) {
  const phase = input.phase;
  const season = safeSeason(input.season);
  const seasonType = safeSeasonType(input.season_type);
  const budget = makeBudget(input);
  const startedAt = new Date().toISOString();
  let runId = input.run_id || runIdFor(phase, season, seasonType);
  let cursor = input.cursor ?? null;
  let processedPages = 0;
  let fetchedRows = 0;
  let storedRows = 0;
  let errorCount = 0;

  const existing = input.run_id ? await getRun(env, input.run_id) : null;
  if (existing) {
    cursor = input.cursor ?? existing.cursor ?? null;
    processedPages = Number(existing.processed_pages || 0);
    fetchedRows = Number(existing.fetched_rows || 0);
    storedRows = Number(existing.stored_rows || 0);
    errorCount = Number(existing.error_count || 0);
  } else {
    await ensureRun(env, {
      run_id: runId, phase, season, season_type: seasonType,
      cursor, started_at: startedAt, budget,
    });
  }

  let complete = false;
  let stoppedReason = null;
  const pages = [];

  while (budgetCanContinue(budget)) {
    try {
      const result = await ingestPage(env, {
        phase, season, season_type: seasonType, cursor, run_id: runId,
      });
      pages.push(result);
      processedPages += 1;
      fetchedRows += result.source_rows;
      storedRows += result.stored_rows;
      markBudgetPage(budget, result.source_rows);
      cursor = result.next_cursor ?? null;
      complete = result.complete;
      if (complete) break;
    } catch (error) {
      errorCount += 1;
      stoppedReason = `page_error:${String(error?.message || error)}`;
      break;
    }
  }

  if (!complete && !stoppedReason) {
    stoppedReason = Date.now() >= budget.deadline_ms - 3_000
      ? "budget_time_checkpoint"
      : budget.calls_used >= budget.call_budget
      ? "budget_call_checkpoint"
      : budget.pages_used >= budget.max_pages
      ? "budget_page_checkpoint"
      : budget.rows_used >= budget.max_rows
      ? "budget_row_checkpoint"
      : "budget_checkpoint";
  }

  const status = complete ? "complete" : errorCount ? "error" : "checkpointed";
  const completedAt = complete ? new Date().toISOString() : null;
  await updateRun(env, runId, {
    status,
    cursor,
    processed_pages: processedPages,
    fetched_rows: fetchedRows,
    stored_rows: storedRows,
    error_count: errorCount,
    completed_at: completedAt,
    budget,
    checkpoint: { stopped_reason: stoppedReason, next_cursor: cursor },
  });

  return {
    ok: errorCount === 0,
    run_id: runId,
    phase,
    season,
    season_type: seasonType,
    processed_pages: processedPages,
    fetched_rows: fetchedRows,
    stored_rows: storedRows,
    errors: errorCount,
    complete,
    stopped_reason: stoppedReason,
    next_cursor: cursor,
    continuation_allowed: !complete && errorCount === 0,
    budget: {
      budget_ms: budget.budget_ms,
      call_budget: budget.call_budget,
      max_pages: budget.max_pages,
      max_rows: budget.max_rows,
      calls_used_this_request: budget.calls_used,
      pages_used_this_request: budget.pages_used,
      rows_used_this_request: budget.rows_used,
      elapsed_ms: Date.now() - budget.started_ms,
    },
    page_receipts: pages,
    build: BUILD,
  };
}

export async function certifyGames(env, season, seasonType) {
  season = safeSeason(season);
  seasonType = safeSeasonType(seasonType);
  const latestRun = await env.NFL_DB.prepare(`
    SELECT * FROM ingest_runs
    WHERE phase='games' AND season=? AND season_type=?
    ORDER BY started_at DESC LIMIT 1
  `).bind(season, seasonType).first();

  const counts = await env.NFL_DB.prepare(`
    SELECT
      COUNT(*) AS found_rows,
      SUM(CASE WHEN bdl_game_id IS NULL OR kickoff_at IS NULL OR week IS NULL
        OR home_team_id IS NULL OR away_team_id IS NULL OR home_team_abbr IS NULL
        OR away_team_abbr IS NULL THEN 1 ELSE 0 END) AS invalid_rows
    FROM nfl_games WHERE season=? AND season_type=?
  `).bind(season, seasonType).first();

  const expected = Number(latestRun?.fetched_rows || 0);
  const found = Number(counts?.found_rows || 0);
  const invalid = Number(counts?.invalid_rows || 0);
  const runComplete = latestRun?.status === "complete";
  const missing = Math.max(0, expected - found);
  const certified = !!latestRun && runComplete && expected > 0 && missing === 0 && invalid === 0;

  const cert = {
    cert_key: `games:${season}:t${seasonType}`,
    season, season_type: seasonType, phase: "games",
    complete: runComplete, certified, expected_rows: expected, found_rows: found,
    missing_rows: missing, invalid_rows: invalid,
    assessed_at: new Date().toISOString(),
    details: {
      authority: "bdl_games_cursor_exhaustion_plus_d1_identity",
      latest_run_id: latestRun?.run_id || null,
      latest_run_status: latestRun?.status || null,
    },
  };
  await upsertCertification(env, cert);
  return cert;
}

export async function certifyTeamStats(env, season, seasonType) {
  season = safeSeason(season);
  seasonType = safeSeasonType(seasonType);

  const finalGames = await env.NFL_DB.prepare(`
    SELECT COUNT(*) AS n FROM nfl_games
    WHERE season=? AND season_type=? AND status_state='final'
  `).bind(season, seasonType).first();

  const found = await env.NFL_DB.prepare(`
    SELECT COUNT(*) AS n FROM nfl_team_game_stats s
    JOIN nfl_games g ON g.game_id=s.game_id
    WHERE g.season=? AND g.season_type=? AND g.status_state='final'
  `).bind(season, seasonType).first();

  const malformed = await env.NFL_DB.prepare(`
    SELECT COUNT(*) AS n FROM nfl_team_game_stats s
    JOIN nfl_games g ON g.game_id=s.game_id
    WHERE g.season=? AND g.season_type=? AND g.status_state='final'
      AND (
        s.team_id IS NULL OR s.team_abbr IS NULL OR s.home_away IS NULL
        OR (s.team_id <> g.home_team_id AND s.team_id <> g.away_team_id)
      )
  `).bind(season, seasonType).first();

  const badGameRows = await env.NFL_DB.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT g.game_id, COUNT(s.team_id) AS stat_rows
      FROM nfl_games g
      LEFT JOIN nfl_team_game_stats s ON s.game_id=g.game_id
      WHERE g.season=? AND g.season_type=? AND g.status_state='final'
      GROUP BY g.game_id
      HAVING stat_rows <> 2
    )
  `).bind(season, seasonType).first();

  const nFinal = Number(finalGames?.n || 0);
  const expected = nFinal * 2;
  const foundRows = Number(found?.n || 0);
  const invalid = Number(malformed?.n || 0);
  const gamesBad = Number(badGameRows?.n || 0);
  const missing = Math.max(0, expected - foundRows);
  const gamesCert = await env.NFL_DB.prepare(`
    SELECT * FROM phase_certifications
    WHERE cert_key=?
  `).bind(`games:${season}:t${seasonType}`).first();

  const complete = expected > 0 && foundRows >= expected;
  const certified = gamesCert?.certified === 1 && complete && missing === 0 && invalid === 0 && gamesBad === 0;

  const cert = {
    cert_key: `team_stats:${season}:t${seasonType}`,
    season, season_type: seasonType, phase: "team_stats",
    complete, certified, expected_rows: expected, found_rows: foundRows,
    missing_rows: missing, invalid_rows: invalid,
    assessed_at: new Date().toISOString(),
    details: {
      authority: "two_team_rows_per_final_bdl_game",
      final_games: nFinal,
      games_with_row_count_not_2: gamesBad,
      dependency_games_certified: gamesCert?.certified === 1,
    },
  };
  await upsertCertification(env, cert);
  return cert;
}

export async function seasonAudit(env, season) {
  season = safeSeason(season);
  const rows = await env.NFL_DB.prepare(`
    SELECT season_type, phase, complete, certified, expected_rows, found_rows,
           missing_rows, invalid_rows, details_json, assessed_at, build
    FROM phase_certifications
    WHERE season=?
    ORDER BY season_type, phase
  `).bind(season).all();

  const games = await env.NFL_DB.prepare(`
    SELECT season_type, status_state, COUNT(*) AS n
    FROM nfl_games WHERE season=? GROUP BY season_type, status_state
  `).bind(season).all();

  const stats = await env.NFL_DB.prepare(`
    SELECT season_type, COUNT(*) AS n
    FROM nfl_team_game_stats WHERE season=? GROUP BY season_type
  `).bind(season).all();

  return {
    season,
    certifications: rows.results || [],
    game_counts: games.results || [],
    team_stat_counts: stats.results || [],
    build: BUILD,
  };
}
