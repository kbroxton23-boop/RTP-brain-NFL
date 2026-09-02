# NFL Intelligence Machine — Agent Build Brief

## Mission
Upgrade the existing unified Brain v8 NFL Worker in place. Do not start over and do not create a competing prediction Worker.

Baseline: `elite-v8-p12f-unified-ssot-v1`.

## Non-negotiable invariants
- Keep one authoritative Brain v8 Worker.
- Existing model math is the control and must remain reproducible.
- No future leakage. Every historical feature row needs an `available_at` / `as_of` boundary.
- Pure football prediction is computed before sportsbook/market comparison.
- Do not use calibrated outputs as calibration inputs.
- Never fabricate missing stats.
- D1 is canonical structured historical truth, R2 stores raw provider payloads, KV is cache/runtime state.
- Every new ingestion phase is idempotent, resumable, budgeted, checkpointed, and certifiable.
- Every model promotion needs deterministic replay and before/after metrics.

## Existing strengths to preserve
- Team Well normalization and dynamic dotted-stat registry.
- Core team features: pace, pass rate, off/def EPA/play, YPP, PPD, third-down conversion, turnovers, penalties, red-zone rates, pressure/sack proxies, defensive success, explosive proxy.
- Sumer-style long CSV parsing.
- Injury ingestion and summaries.
- Open-Meteo weather integration.
- Odds API market integration.
- Matchup inputs, game simulation, Monte Carlo win probabilities.
- Existing prop route family and grading shell.
- Unified factual SSOT for Games + Team Stats.

## Highest-value gaps
1. Play-by-play SSOT.
2. Player game-stat SSOT.
3. Canonical rosters and player identity.
4. Advanced passing/rushing/receiving where BDL entitlement allows it.
5. Dedicated OL-vs-DL trench features.
6. Situation-neutral / early-down / non-garbage split features.
7. Player usage model: snap/route/target/carry/red-zone shares.
8. Team-to-player reconciliation.
9. Pure-output walk-forward calibration.

## Data-source policy
### Primary factual provider
BALLDONTLIE NFL API. Probe the live key rather than assuming tier access.

### Supplemental analytical sources
- Existing SumerSports scraper/export path where access is permitted.
- nflverse/nflfastR for historical research, derived play-level metrics, and independent validation.
- Existing Open-Meteo weather.
- Existing market source(s) strictly outside pure model features.

Do not scrape access-controlled pages or bypass authentication. Respect source terms and record provenance.

## Phase A — Capability and coverage audit
Add a read-only endpoint: `GET /ssot/capabilities/bdl`.

Safely test availability (without returning secrets) for games, stats, season_stats, team_stats, team_season_stats, player_injuries, active players/roster if supported, advanced passing, advanced rushing, advanced receiving, plays, odds, and player_props.

Return HTTP status, entitlement state, schema sample keys, and pagination metadata. Do not write data.

## Phase B — Canonical factual tables
Add migrations and ingestion phases for:
- nfl_players
- nfl_rosters
- nfl_player_game_stats
- nfl_plays
- nfl_injuries
- nfl_advanced_passing
- nfl_advanced_rushing
- nfl_advanced_receiving
- nfl_market_snapshots
- nfl_player_prop_snapshots

All rows include provider IDs, game/team/player linkage, source, observed_at, available_at, ingested_at, payload_hash, raw_r2_key, schema_version, build.

## Phase C — Feature builder
Create immutable pregame feature snapshots from prior information only.

Team families: pace/possessions, off/def EPA, success, early-down, non-garbage, red zone, third/fourth down, explosive pass/rush, pass/rush tendency and PROE, turnovers shrunk toward stable expectation, penalties, rest/travel/weather.

Trench families: pressure generated/allowed, quick pressure where available, sacks conditional on pressure, pressure-to-sack QB behavior, run success/stuff/TFL, yards-before-contact proxy, gap/concept performance, OL continuity/injuries, DL/front-seven availability.

Player families: recent opportunity, snap/route share where available, target share, catch rate, aDOT/air-yards proxy, YAC efficiency, carry share, red-zone targets/carries, QB attempts/rush share, injury/role state.

## Phase D — Shadow models
Keep current Brain v8 as CONTROL.

Add shadow possession/drive model for team score distributions and a shadow player usage/stat model for QB/RB/WR/TE distributions. Reconcile player volume to team volume so the projections cannot contradict one another.

## Phase E — Evaluation and promotion
Walk-forward only. Evaluate home/away score MAE/RMSE, spread/total MAE/RMSE, winner Brier/log-loss/ECE, and player-stat MAE/RMSE plus interval coverage where available.

Promotion requires deterministic replay, no leakage, sufficient sample, measurable out-of-sample improvement, promotion receipt, and rollback pointer.

## First code deliverable
`NFL Intelligence v1 — BDL Capability + Player/Play SSOT`

Scope:
- capability endpoint
- schema migration
- canonical player identity
- player stats ingest
- plays ingest
- injury snapshots into D1
- optional advanced endpoints gated by entitlement
- budget/checkpoint/certification
- zero model-weight changes

## Done criteria
- CI green.
- Existing Worker routes pass regression tests.
- BDL capability endpoint is read-only and secret-safe.
- One-page live ingestion for each entitled phase produces D1 rows and R2 receipts.
- Existing Brain v8 model fields are unchanged when new shadow features are disabled.
