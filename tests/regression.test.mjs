import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const s=fs.readFileSync(new URL("../brain-elite-v8.js",import.meta.url),"utf8");
test("known Team Well crash fixes remain",()=>{ assert.match(s,/function defaultTeamStats\(\)[\s\S]*Pure defaults only/); assert.match(s,/const TEAM_STATS_TTL = null/); });
test("kv list argument order fix remains",()=>assert.match(s,/return jsonResponse\(200, \{ ok: true, data: \{ prefix, count: names.length/));
test("module migration removed service worker addEventListener",()=>assert.doesNotMatch(s,/addEventListener\("fetch"/));
test("existing model/calibration functions remain present",()=>{ for(const n of ["handleMatchupSim","handleCalFit","handlePredict","handleGameEdges"]) assert.match(s,new RegExp(`function ${n}|async function ${n}`)); });
test("ssot layer is fact-only by contract",()=>{ const block=s.slice(s.indexOf("// NFL SSOT v1"),s.indexOf("function getEnvShim")); assert.doesNotMatch(block,/spread_b|total_b|w_epa|w_redzone|temp_tau/); });
