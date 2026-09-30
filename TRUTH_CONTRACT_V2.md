# NFL Historical Truth Contract v2

Status: LOCKED CONTRACT

Purpose: make every historical NFL simulation reproducible, auditable, and free of look-ahead leakage.

## 1. Core invariant

A historical prediction may use only information that was available at or before the explicit `decision_ts_utc` for that game.

If any required input cannot prove its as-of time and provenance, the game is `BLOCKED_TRUTH`. It must not silently substitute a future week, an `ALL` bucket, a current snapshot, an end-of-season aggregate, or a model default.

## 2. Required game identity

Every historical game bundle must contain:

- `truth_version` = `truth-v2`
- `event_id` (deterministic/stable)
- `season`
- `week`
- `season_type`
- `kickoff_ts_utc`
- `decision_ts_utc`
- `home_team`
- `away_team`
- `model_build`
- `calibration_version`
- `input_hash`

`decision_ts_utc` is explicit. It is never inferred from current time.

## 3. Team-stat truth

For each team, the bundle must include a versioned snapshot with:

- `season`
- `target_week`
- `through_week`
- `as_of_ts_utc`
- source/provenance metadata
- source game IDs used to calculate the snapshot
- all required model fields

Hard rules:

1. `as_of_ts_utc <= decision_ts_utc`.
2. No game at or after the target game's kickoff may contribute to the snapshot.
3. For regular-season Week N rolling stats, only completed games before Week N may contribute.
4. Never fall forward to a later week.
5. Never use an `ALL`/full-season snapshot as a historical fallback.
6. If exact target-week truth is unavailable, only a proven earlier snapshot/prior may be used and must be explicitly labeled.
7. A missing required field remains missing and blocks truth-mode simulation; it is not replaced by a generic league/model default.

Required core fields currently consumed by the engine include:

- `pace_plays60`
- `pass_rate`
- `off_epa_play`
- `def_epa_play`
- `yards_per_play`
- `points_per_drive`
- `down_conversion_rate`
- `redzone_td_rate_off`
- `redzone_td_rate_def`
- `pressure_rate`
- `def_success`
- `sack_rate_allowed`
- `explosive_play_rate`
- `takeaways_per_game`
- `giveaways_per_game`
- `penalties_per_game`

Any additional weighted input must obey the same as-of rules.

## 4. Week 1 prior

Week 1 cannot use statistics created by that season's Week 1 or later games.

A Week 1 prior may use only information available before kickoff, such as:

- previous-season ending performance
- offseason roster/personnel information available before kickoff
- preseason/prior information available before kickoff

The prior must be explicitly tagged with provenance and may not masquerade as current-season observed data.

## 5. Roster and player truth

Roster membership must be correct for the historical week/as-of time.

A player who joined later in the season cannot appear in an earlier game's input package.

## 6. Injury truth

Historical injuries/designations are independent snapshots and must not be reconstructed from today's/current injury endpoint.

Each injury record must retain:

- season/week
- team/player/position
- designation/status
- source
- source/report timestamp
- fetched/stored timestamp
- active/inactive or game-status fields when available

Hard rules:

1. The injury record used by the prediction must be available by `decision_ts_utc`.
2. `current`, `ALL`, or today's injury cache may not substitute for a missing historical week.
3. Historical injury truth must be stored without short expiration.
4. Missing historical injury truth blocks a truth-certified simulation.

## 7. Market truth

Markets must be timestamped historical snapshots.

Store separately when available:

- open
- decision-time market
- close

Prediction inputs may use only the selected canonical market snapshot with `snapshot_ts_utc <= decision_ts_utc`.

A later closing line may be retained for CLV measurement but must never leak into an earlier prediction.

Each market snapshot must include source/bookmaker or consensus provenance, spread, total, moneyline prices, and timestamp.

## 8. Weather/context truth

Weather/context used by a historical prediction must have an as-of timestamp at or before `decision_ts_utc`.

Observed final weather may be stored for post-game analysis but may not replace a pregame forecast in the model input unless it was actually knowable at decision time.

Indoor/roof context must be explicit.

## 9. Calibration truth

Outcome calibration is walk-forward only.

For target game G:

- calibration training rows must come only from games completed before G's decision time
- no same-game result may be present
- no future-week/future-season result may be present
- the training cutoff must be stored with the calibration artifact

Market-line fitting and outcome calibration are distinct artifacts and must have different keys/versions/provenance.

A full-season `calfit` must never be applied retrospectively to earlier games from that same season.

## 10. Prediction/final separation

Order is mandatory:

1. build truth bundle
2. validate contract
3. freeze/hash inputs
4. simulate
5. persist prediction
6. only then attach final/result
7. grade
8. update performance/calibration datasets

Final score, ATS result, total result, winner, or any derivative of the final must not be present in the pregame input bundle or its hash.

## 11. Determinism and idempotency

Historical rebuilds must use:

- deterministic event IDs
- explicit model build
- explicit calibration artifact
- fixed or recorded simulation seed where stochastic simulation is used
- immutable input hash

Re-running the same game with the same build, calibration, seed, and input hash must reproduce the same prediction.

## 12. KV versioning and retention

Historical truth is versioned and parallel to the current production data.

Recommended roots:

- `truth:v2:*`
- `sim:v2:*`
- `grade:v2:*`
- `calfit:v2:*`

Historical truth records are non-expiring. Corrections create a new revision with provenance/supersession; they do not silently rewrite history.

Do not delete the legacy namespace during validation.

## 13. Grading truth

Grades must distinguish:

- win
- loss
- push
- no action / no bet

Pushes may not be counted as losses or wins.

Betting performance must use the actual stored price/juice associated with the prediction snapshot when ROI is calculated.

## 14. UI synchronization

Every UI response that represents a historical simulation/performance result must expose at minimum:

- `truth_version`
- `model_build`
- `calibration_version`
- `input_hash`
- truth status
- blocking reasons, if any

The UI may not combine legacy grades with `truth-v2` simulations or display a green/complete state when the truth contract is blocked.

## 15. Certification gates

A historical game is truth-certified only when all are true:

- deterministic identity present
- explicit decision timestamp present
- team snapshots are no-lookahead compliant
- roster is as-of compliant
- injuries are as-of compliant
- market is as-of compliant
- weather/context is as-of compliant or explicitly not applicable
- calibration cutoff precedes target game
- required fields are complete
- no forbidden default/future/`ALL` fallback was used
- prediction persisted before final attachment
- input hash present

Any failure => `BLOCKED_TRUTH`.

## 16. Season rebuild order

Rebuild sequentially:

1. 2024 Week 1 through postseason
2. certify 2024
3. 2025 Week 1 through postseason
4. certify 2025
5. 2026 Week 1 forward
6. certify 2026
7. build cross-season performance/calibration datasets only from certified games

## 17. Promotion rule

`truth-v2` does not replace legacy production data until structural validation passes:

- zero detected look-ahead violations
- zero silent future/`ALL` fallbacks
- 100% deterministic identity/hash coverage for included games
- complete provenance for every required input used
- deterministic rerun agreement
- UI and worker reporting the same truth/build/calibration versions

Games with genuinely unavailable historical inputs remain blocked/excluded rather than being fabricated.
