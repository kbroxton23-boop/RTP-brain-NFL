import fs from "node:fs";
import assert from "node:assert/strict";
const p = process.argv[2] || "brain-elite-v8.js";
const s = fs.readFileSync(p,"utf8");
const required = [
  'elite-v8-p12f-intelligence-ssot-v1',
  '"/ssot/capabilities/bdl"',
  '"/ssot/ingest/player-stats"',
  '"/ssot/ingest/plays"',
  '"/ssot/ingest/roster"',
  '"/ssot/ingest/advanced-passing"',
  '"/ssot/certify/player-stats"',
  '"/ssot/certify/plays"',
  'CREATE TABLE IF NOT EXISTS nfl_players',
  'CREATE TABLE IF NOT EXISTS nfl_player_game_stats',
  'CREATE TABLE IF NOT EXISTS nfl_plays',
  'CREATE TABLE IF NOT EXISTS nfl_rosters',
  'CREATE TABLE IF NOT EXISTS nfl_injury_snapshots',
  'CREATE TABLE IF NOT EXISTS nfl_player_advanced_stats',
  'model_math_mutated: false'
];
for (const x of required) assert.ok(s.includes(x), `missing ${x}`);
assert.ok(s.includes('url.searchParams.set("season_type", String(seasonType));'), "official season_type query missing");
assert.ok(!s.includes('url.searchParams.append("season_type[]", String(seasonType));'), "legacy season_type[] still present");
assert.ok(s.includes('detail:"no_seed_game_in_ssot"'), "rate-limit-safe capability seed contract missing");
const capStart=s.indexOf('async function ssotBdlCapabilities');
const capEnd=s.indexOf('function ssotPlayerName',capStart);
const cap=s.slice(capStart,capEnd);
assert.ok(!cap.includes('ssotBdlGenericPage(env,"games"'), "capability probe must not burn a BDL seed-game request");
console.log(`PASS ${required.length + 4} intelligence contracts`);
