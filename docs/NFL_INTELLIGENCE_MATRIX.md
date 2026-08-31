# NFL Intelligence Matrix v1

Baseline: `elite-v8-p12f-unified-ssot-v1`.

This matrix is an **upgrade map, not a rewrite plan**. Existing Brain v8 model math remains frozen until each new data family is historically replayed and shown to improve out-of-sample accuracy or calibration.

| Domain | Feature | Current | Target | Priority |
|---|---|---|---|---|
| Game identity/results | Schedule, kickoff, week, home/away, final score | PRESENT + SSOT | Canonical D1 + R2 receipt | P0 |
| Team box stats | Plays, yards, YPP, drives, pass/rush, 3D/4D, RZ, penalties, turnovers, possession | PRESENT + SSOT | Canonical D1 + R2 receipt | P0 |
| Team efficiency | Off/def EPA per play | PRESENT, source-dependent | Opponent-adjusted rolling feature snapshot | P0 |
| Team efficiency | Success rate offense/defense | PARTIAL | Early-down/non-garbage split success | P0 |
| Pace/volume | Plays/game, seconds/play, estimated plays | PRESENT | Pregame possession/play-volume model | P0 |
| Pass/run tendency | Pass rate | PRESENT | Situation-neutral pass rate + PROE | P0 |
| Explosiveness | Explosive play rate | PARTIAL/PROXY | True pass/rush explosive rate by situation | P0 |
| Red zone | Off/def RZ TD rate | PRESENT | Drive-level TD/FG probabilities | P0 |
| Conversions | 3rd-down offense/defense, 4th-down | PARTIAL | Down/distance situational rates | P1 |
| Turnovers | Takeaways/giveaways | PRESENT | Expected turnover rate with regression | P1 |
| Penalties | Penalties/game | PRESENT | Penalty yards + drive-kill cost | P2 |
| Injuries | Player injury feed/summary | PRESENT, KV-centric | D1 pregame injury snapshots with position value | P0 |
| Weather | Game weather/risk | PRESENT | Pregame immutable weather snapshot | P1 |
| Market | Spread,total,ML | PRESENT | Market snapshot table separated from pure model | P0 |
| Sumer team overview | EPA/play, success, EPA/pass, EPA/rush, aDOT, sack/scramble/INT | PARSER PRESENT, ingestion not authoritative | Certified advanced feature table | P0 |
| Personnel/formations | 11/12/21 personnel, formation usage, EPA by grouping | RAW-DYNAMIC SUPPORT ONLY | Opponent matchup interaction features | P1 |
| Coverage/blitz | Man/zone, blitz, pressure by context | MISSING FIRST-CLASS | Coverage-vs-receiver/QB matchup features | P1 |
| Trenches - pass | Pressure allowed/generated, sack rate, quick pressure, time to pressure/throw | PARTIAL | Dedicated OL↔DL matchup engine | P0 |
| Trenches - run | Run success, stuff/TFL, yards before contact, gap/concept efficiency | MISSING FIRST-CLASS | Dedicated run-block/front-seven matchup engine | P0 |
| Rosters | Active roster and positions | MISSING SSOT | Canonical roster by as_of | P0 |
| Player game stats | QB/RB/WR/TE game logs | NOT SSOT | Canonical player_game_stats | P0 |
| Player season stats | Season aggregates | NOT SSOT | Derived rolling priors only | P1 |
| Advanced passing | Attempts, air depth, pressure context, efficiency | MISSING SSOT | QB distribution model | P0 |
| Advanced rushing | Carries, efficiency, explosive/usage context | MISSING SSOT | RB carry/yards/TD model | P0 |
| Advanced receiving | Targets, receptions, receiving efficiency | MISSING SSOT | Target/reception/yards/TD model | P0 |
| Play-by-play | Down, distance, play type, players, result | MISSING SSOT | Canonical plays + derived features | P0 |
| EPA/CPOE/xYAC/xPass | Play-level advanced derived metrics | MISSING DIRECT | Research/backtest feature store | P1 |
| Player usage | Snap/route/target/carry/RZ shares | WEAK/PARTIAL | Pregame usage distributions | P0 |
| Player props | Passing/rushing/receiving/receptions/TDs | ENGINE EXISTS | Game-sim-conditioned player distributions | P0 |
| Score model | Home/away score, spread,total,winner | PRESENT | Possession/drive-based joint score distribution | P0 |
| Calibration | Spread,total,ML fit | PRESENT but legacy risk | Pure-output-only walk-forward calibration | P0 |

## Preserve
- Existing Team Well normalization and dynamic stat registry.
- Existing matchup input builder and Monte Carlo game simulation as the control model.
- Existing injury/weather/odds routes while moving their factual history into canonical SSOT tables.
- Existing prop endpoints as the API shell; replace weak baseline generation underneath them rather than deleting the route family.

## First engineering wave
1. BDL capability probe: discover exactly which paid NFL endpoints the bound key can access.
2. Add canonical D1/R2 ingestion for rosters, player game stats, plays, injuries, and available BDL advanced passing/rushing/receiving.
3. Derive pregame-safe team/player rolling features from prior games only.
4. Build a dedicated trench feature family and keep it read-only/shadow at first.
5. Build player usage projections conditioned on team plays/possessions, then reconcile player totals to team totals.
6. Replay against 2025 before any promotion into the production projection path.
