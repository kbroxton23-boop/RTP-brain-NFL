# RTP NFL SSOT Reconstruction v1

This is the factual-history foundation for the RTP NFL engine. It does **not** change Brain v8 prediction weights, calibration, or market logic.

## Authority

- Canonical schedule/results: BALLDONTLIE NFL `/nfl/v1/games`
- Canonical per-game team box/efficiency stats: BALLDONTLIE NFL `/nfl/v1/team_stats`
- Canonical structured history: Cloudflare D1 (`NFL_DB`)
- Immutable upstream page archive: Cloudflare R2 (`NFL_RAW`)
- Durable orchestration: Cloudflare Workflows (`SSOT_RECONSTRUCTION`)
- KV is intentionally not used as historical authority.

## Core invariant

A final game cannot certify `team_stats` unless it has exactly two canonical team-stat rows, and each row belongs to one of that game's two BDL team IDs.

## Deployment

1. Create the D1 DB:
   `npx wrangler@latest d1 create rtp-nfl-ssot`
2. Copy the returned database ID into `wrangler.jsonc`.
3. Create the R2 bucket:
   `npx wrangler@latest r2 bucket create rtp-nfl-raw-ssot`
4. Set secrets:
   `npx wrangler@latest secret put BDL_API_KEY`
   `npx wrangler@latest secret put SSOT_ADMIN_TOKEN`
5. Set `UI_ORIGIN` to the deployed NFL Pages origin.
6. Apply migration:
   `npx wrangler@latest d1 migrations apply rtp-nfl-ssot --remote`
7. Generate binding types:
   `npx wrangler@latest types`
8. Deploy:
   `npx wrangler@latest deploy`

## First controlled 2025 run

Start with regular-season games only:

POST `/ssot/ingest/games`

```json
{
  "season": 2025,
  "season_type": 2,
  "budget_ms": 80000,
  "call_budget": 5,
  "max_pages": 5,
  "max_rows": 500
}
```

If `complete=false`, resend with the returned `run_id`. The worker resumes from the saved D1 cursor. When complete:

POST `/ssot/certify/games`
```json
{"season":2025,"season_type":2}
```

Then run `/ssot/ingest/team-stats` with the same budget contract, followed by `/ssot/certify/team-stats`.

For the full durable regular + postseason reconstruction, use:

POST `/ssot/workflows/season`
```json
{"season":2025,"season_types":[2,3]}
```

## No-leakage rule

This worker stores factual observations only. It does not create pregame feature snapshots yet. Phase 2 will construct features for a target game exclusively from events earlier than that target's permitted as-of boundary.

## Why D1 + R2

D1 provides indexed canonical rows and audit queries. R2 preserves provider responses by deterministic payload hash. Re-running an ingest is idempotent: canonical rows upsert by provider identity, while identical raw pages resolve to the same R2 key.
