const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('brain-elite-v8.js', 'utf8');
const ctx = {
  console,
  URL,
  URLSearchParams,
  Request,
  Response,
  Headers,
  fetch: async () => { throw new Error('unexpected_fetch'); },
  crypto: globalThis.crypto,
  TextEncoder,
  TextDecoder,
  setTimeout,
  clearTimeout,
  addEventListener: () => {},
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx, { filename: 'brain-elite-v8.js' });

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 1) Cold/default construction must never reference request-scoped variables.
const defaults = vm.runInContext('defaultTeamStats()', ctx);
assert(defaults && defaults.pace_plays60 === 62, 'defaultTeamStats failed');
assert(defaults.off_epa_play === 0, 'default off EPA changed unexpectedly');

// 2) Long-format Sumer rows must construct a canonical Team Well object.
ctx.__rows = [
  { team_abbr: 'ATL', season: '2025', week: '17', bucket: 'overview', section: 'offense', scope: 'base', metric: 'epa', value: '0.12' },
  { team_abbr: 'ATL', season: '2025', week: '17', bucket: 'overview', section: 'defense', scope: 'base', metric: 'epa', value: '-0.03' },
  { team_abbr: 'ATL', season: '2025', week: '17', bucket: 'red_zone', section: 'offense', scope: 'base', metric: 'redzone_td_rate', value: '0.61' },
];
const teams = vm.runInContext('buildTeamsFromLong(__rows, 2025, 17)', ctx);
assert(teams.ATL, 'ATL was not built from long-format rows');
assert(Math.abs(teams.ATL.stats.off_epa_play - 0.12) < 1e-12, 'offensive EPA mapping failed');
assert(Math.abs(teams.ATL.stats.def_epa_play + 0.03) < 1e-12, 'defensive EPA mapping failed');
assert(Math.abs(teams.ATL.stats.redzone_td_rate_off - 0.61) < 1e-12, 'red-zone mapping failed');
assert(teams.ATL.raw_dotted && typeof teams.ATL.raw_dotted === 'object', 'raw_dotted type is unstable');
assert(teams.ATL.raw_nested && typeof teams.ATL.raw_nested === 'object', 'raw_nested type is unstable');

// 3) Canonical Team Well history is SSOT and must not carry an expiration TTL.
let putArgs = null;
ctx.__env = {
  RTP_CACHE: {
    put: async (...args) => { putArgs = args; },
  },
};
ctx.__defaults = defaults;

(async () => {
  const out = await vm.runInContext(
    'saveTeamStats(__env,{season:2025,week:17,team:"ATL",stats:__defaults})',
    ctx,
  );
  assert(out && out.saved === true, 'saveTeamStats did not report success');
  assert(putArgs && putArgs.length === 2, 'Team Well write still includes TTL options');
  assert(String(putArgs[0]).includes(':2025:17:ATL'), 'canonical team key malformed');

  // 4) Critical execution surfaces remain present; this repair must not shrink the engine.
  for (const route of ['/teams/ingest', '/matchup/sim', '/cal/fit', '/prefetch/batch', '/anchors/today']) {
    assert(src.includes(`pathname === "${route}"`), `critical route missing: ${route}`);
  }

  console.log(JSON.stringify({
    ok: true,
    suite: 'ssot-foundation-v1',
    checks: [
      'defaultTeamStats cold path',
      'long-format Sumer Team Well ingest',
      'durable canonical Team Well write',
      'critical route preservation',
    ],
  }, null, 2));
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
