# NFL Intelligence Machine v1 — Candidate

Build: `elite-v8-p12f-intelligence-ssot-v1`

This candidate preserves Brain v8 model/calibration math and extends the existing unified SSOT with:
- BDL capability probes grouped to respect low request-rate tiers
- player identity SSOT
- roster/depth SSOT
- player-game-stat SSOT
- play-by-play SSOT
- injury snapshots
- advanced passing/rushing/receiving payload SSOT
- D1 coverage audits and basic certification for player stats + plays

## Capability probes
GET `/ssot/capabilities/bdl?group=core&season=2025`
GET `/ssot/capabilities/bdl?group=goat&season=2025`
GET `/ssot/capabilities/bdl?group=market&season=2025`

All capability probes require `Authorization: Bearer <SSOT_ADMIN_TOKEN>`.

The GOAT/market probes reuse a BDL game already stored in D1. If no seed game is present, play/prop capability is reported as `no_seed_game_in_ssot` rather than spending an extra upstream request. This keeps the capability scan safe for low-throttle/trial keys.

## Safe first write order
1. POST `/ssot/bootstrap` — idempotently creates new tables.
2. Ensure at least one 2025 game exists in the Games SSOT.
3. Run `group=core` capabilities.
4. Run `group=goat` capabilities.
5. If `player_stats=true`: POST `/ssot/ingest/player-stats` one page.
6. If `plays=true`: pick one already stored BDL game and POST `/ssot/ingest/plays` one page.
7. GET `/ssot/audit/intelligence?season=2025`.
8. Do not run season-scale continuation until receipts/counts are audited.

No model weights or calibration weights are changed in this candidate.
