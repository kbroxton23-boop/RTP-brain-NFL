# RTP NFL Professional Diagnostics + Historical Rebuild v2.3.5

Base: proven v2.3.4.3 autonomous pipeline (14/14 daily phases, 50 continuations, 0 errors in the first completed 2026 run).

Worker build: `elite-v8-p12f-intelligence-professional-diagnostics-historical-v2.3.5`
Diagnostic contract: `nfl_diag_v2`
Control contract: `nfl_control_v1`
Model math mutated: false

## New professional diagnostic routes (private Pages service plane)
- GET /debug/doctor?season=2025
- GET /debug/d1/schema
- GET /debug/pipeline
- GET /debug/provider
- GET /debug/routes
- GET /debug/events?limit=50
- GET /debug/bindings

All debug event persistence is sanitized. Secret values, Authorization headers, cookies, API keys, and raw request bodies are not returned or persisted.

## Historical rebuild preparation
- GET /control/historical/preflight?season=2025&season_type=2
- Historical pipeline now includes season rosters.
- Current-only injuries are intentionally excluded from historical reconstruction.
- Start is fail-closed on hard preflight blockers.
- Missing optional/entitlement-gated BDL datasets are reported as warnings and remain visible in certification/diagnostics.

Historical order:
Games -> Team Stats -> Player Stats -> Historical Rosters -> Plays -> Advanced Passing -> Advanced Rushing -> Advanced Receiving -> Certifications -> Performance.
