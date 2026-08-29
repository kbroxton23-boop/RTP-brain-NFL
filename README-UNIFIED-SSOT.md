# RTP NFL Unified Brain v8 SSOT v1

Working branch: `repair/unified-brain-v8-ssot-v1`.

This branch keeps **one authoritative NFL Worker**. CI applies `patches/unified-brain-v8-ssot-v1.patch` to the trusted `brain-elite-v8.js`, tests the generated Worker, validates the D1 schema, and publishes a deployable GitHub Actions artifact.

## Candidate scope

- Preserves the existing Brain v8 model and route set.
- Preserves the Foundation fixes already proven in the current Cloudflare Worker: pure Team Well defaults, long-row initialization, durable historical Team Well KV, and `/kv/list` response ordering.
- Migrates the Worker entrypoint from legacy Service Worker syntax to ES modules so D1 can be bound directly to the **same** Brain v8 Worker.
- Adds factual-only SSOT routes for 2025 Games + Team Stats:
  - `GET /ssot/health`
  - `POST /ssot/bootstrap`
  - `POST /ssot/ingest/games`
  - `POST /ssot/ingest/team-stats`
  - `POST /ssot/certify/games`
  - `POST /ssot/certify/team-stats`
  - `GET /ssot/audit/season`
  - `GET /ssot/debug/run`
  - `GET /ssot/debug/game`
- Adds D1 canonical rows, R2 raw-provider archives, deterministic hashes/receipts, cursor checkpoints, and certification.
- SSOT write routes require `SSOT_ADMIN_TOKEN`; the token is never hardcoded.
- No spread/total/ML/calibration weights are changed.

## Why the entrypoint migration is required

Cloudflare's current documentation states D1 bindings are available to ES-module Workers via `env` and that D1 is not available to legacy Service Worker syntax. This migration is therefore an infrastructure prerequisite, not a model rewrite.

## Safe live-test order

Do **not** promote directly to production.

1. Download the CI artifact or local candidate Worker.
2. Deploy it as a Cloudflare preview/candidate version using the existing `RTP_CACHE`, `ODDS_API_KEY`, `BDL_NFL_API_KEY`, and `UI_ORIGIN` bindings.
3. Prove legacy routes first: `/health`, `/teams/get`, `/matchup/sim`, `/cal/summary`, `/kv/list`.
4. Create and bind D1 as `NFL_DB` and R2 as `NFL_RAW`; add secret `SSOT_ADMIN_TOKEN`.
5. `POST /ssot/bootstrap` once with `Authorization: Bearer <token>`.
6. Require `/ssot/health` to report D1/R2/BDL/admin bindings present.
7. Run exactly one page of 2025 regular-season Games:

```json
{"season":2025,"season_type":2,"budget_ms":30000,"call_budget":1,"max_pages":1,"max_rows":100}
```

8. Audit the D1/R2 receipt before any season-scale continuation.

`main` remains untouched until candidate runtime proof passes.
