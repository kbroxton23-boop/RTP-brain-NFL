import test from "node:test";
import assert from "node:assert/strict";
import worker, { __RTP_SSOT_TEST as ssot } from "../brain-elite-v8.js";

const game = {
  id:7001, visitor_team:{id:6,abbreviation:"BAL",full_name:"Baltimore Ravens"},
  home_team:{id:14,abbreviation:"KC",full_name:"Kansas City Chiefs"}, week:1,
  date:"2024-09-06T00:20:00.000Z", season:2024, postseason:false, status:"Final",
  status_state:"final", home_team_score:27, visitor_team_score:20
};

test("canonical provider game identity",()=>assert.equal(ssot.canonicalGameId(game),"bdl:7001"));
test("game normalization preserves source truth",()=>{
  const x=ssot.normalizeGame(game,2,"2026-08-26T00:00:00.000Z");
  assert.equal(x.game_id,"bdl:7001"); assert.equal(x.home_team_abbr,"KC"); assert.equal(x.away_team_abbr,"BAL"); assert.equal(x.status_state,"final");
});
test("team stat identity derives side/opponent",()=>{
  const stat={game,team:game.home_team,total_offensive_plays:62,total_yards:332,yards_per_play:5.4,turnovers:1};
  const x=ssot.normalizeTeamStat(stat,2,"2026-08-26T00:00:00.000Z");
  assert.equal(x.home_away,"home"); assert.equal(x.opponent_abbr,"BAL"); assert.equal(x.yards_per_play,5.4);
});
test("stable serialization is deterministic",()=>assert.equal(ssot.stableStringify({b:2,a:1}),ssot.stableStringify({a:1,b:2})));
test("raw archive key is deterministic",()=>assert.equal(ssot.rawKey("games",2025,2,null,"abc"),"raw/bdl/nfl/v1/games/season=2025/season_type=2/cursor=START/abc.json"));
test("legacy health survives module migration and exposes SSOT routes",async()=>{
  const env={RTP_CACHE:{},UI_ORIGIN:"",BDL_NFL_API_KEY:"x"};
  const res=await worker.fetch(new Request("https://example.test/health"),env,{waitUntil(){}});
  assert.equal(res.status,200); const body=await res.json(); assert.equal(body.ok,true); assert.match(body.meta.build,/(unified|intelligence)-ssot-v1/); assert.ok(body.data.routes.includes("/matchup/sim")); assert.ok(body.data.routes.includes("/ssot/health"));
});
test("ssot health reports unbound D1/R2 without breaking main Worker",async()=>{
  const env={RTP_CACHE:{},UI_ORIGIN:"",BDL_NFL_API_KEY:"x"};
  const res=await worker.fetch(new Request("https://example.test/ssot/health"),env,{waitUntil(){}});
  const body=await res.json(); assert.equal(body.ok,true); assert.equal(body.data.model_math_mutated,false); assert.equal(body.data.bindings.d1,false); assert.equal(body.data.bindings.r2,false);
});
