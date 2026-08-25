import { WorkflowEntrypoint } from "cloudflare:workers";
import { ingestPage, certifyGames, certifyTeamStats } from "./phases.js";

const RETRY = {
  retries: { limit: 5, delay: "5 seconds", backoff: "exponential" },
  timeout: "15 minutes",
};

export class SeasonReconstructionWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const payload = event.payload || {};
    const season = Number(payload.season || 2025);
    const seasonTypes = Array.isArray(payload.season_types) ? payload.season_types : [2, 3];
    const runBase = String(payload.run_id || `season-${season}-${crypto.randomUUID()}`).slice(0, 70);
    const summary = { season, run_id: runBase, phases: [] };

    for (const seasonType of seasonTypes) {
      let cursor = null;
      let page = 0;
      do {
        const currentCursor = cursor;
        const result = await step.do(
          `games-t${seasonType}-p${page}`,
          RETRY,
          async () => await ingestPage(this.env, {
            phase: "games",
            season,
            season_type: seasonType,
            cursor: currentCursor,
            run_id: `${runBase}-games-t${seasonType}`.slice(0, 100),
          }),
        );
        cursor = result.next_cursor ?? null;
        page += 1;
        if (page > 500) throw new Error("games_cursor_safety_limit");
      } while (cursor !== null);

      const gamesCert = await step.do(
        `certify-games-t${seasonType}`,
        async () => await certifyGames(this.env, season, seasonType),
      );
      if (!gamesCert.certified) throw new Error(`games_not_certified_t${seasonType}`);

      cursor = null;
      page = 0;
      do {
        const currentCursor = cursor;
        const result = await step.do(
          `team-stats-t${seasonType}-p${page}`,
          RETRY,
          async () => await ingestPage(this.env, {
            phase: "team_stats",
            season,
            season_type: seasonType,
            cursor: currentCursor,
            run_id: `${runBase}-teamstats-t${seasonType}`.slice(0, 100),
          }),
        );
        cursor = result.next_cursor ?? null;
        page += 1;
        if (page > 500) throw new Error("team_stats_cursor_safety_limit");
      } while (cursor !== null);

      const statsCert = await step.do(
        `certify-team-stats-t${seasonType}`,
        async () => await certifyTeamStats(this.env, season, seasonType),
      );
      if (!statsCert.certified) throw new Error(`team_stats_not_certified_t${seasonType}`);

      summary.phases.push({
        season_type: seasonType,
        games: gamesCert,
        team_stats: statsCert,
      });
    }

    return summary;
  }
}
