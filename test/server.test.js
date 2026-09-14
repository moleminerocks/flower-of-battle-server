'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,webcrypto}=require('node:crypto');
const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const {createGameServer}=require('../server');
async function setup(t,options={}){
  let time=1000000;
  const app=createGameServer({now:()=>time,pollMs:30,...options});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>app.stop());
  const origin='http://127.0.0.1:'+app.server.address().port,url=origin+'/api/multiplayer';
  async function player(name){
    const key=randomUUID().replaceAll('-','');let cursor=0;
    const p={key,id:null,async post(type,extra={}){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:key,type,...extra})});assert.equal(r.status,200,await r.clone().text());return r.json();},
      async poll(since=cursor){const r=await fetch(url+'?poll=1&sessionId='+key+'&since='+since);assert.equal(r.status,200);const d=await r.json();cursor=d.cursor;return d.messages;}};
    const d=await p.post('hello',{name});p.id=d.messages[0].id;return p;
  }
  return{...app,origin,url,player,advance(ms){time+=ms;app.sweep();}};
}
const last=(a,type)=>a.filter(x=>x.type===type).at(-1);
const packet=(scene='tdm')=>({realm:'spoof',scene,multiplayerKind:'spoof',tdmTeam:'spoof',x:120,y:250,visible:true,seq:1,nodes:[{className:'fighter',style:'left:1px;',src:'assets/peasant/F1.png'}],combat:{x:120,y:250,defeated:false},botCounts:{enemy:2,ally:0}});
test('health, static files, Android CORS, unknown sessions and path isolation',async t=>{
  const app=await setup(t);
  assert.equal((await (await fetch(app.origin+'/healthz')).json()).ok,true);
  assert.match(await (await fetch(app.origin+'/')).text(),/Flower of Battle/);
  assert.equal((await fetch(app.origin+'/server.js')).status,404);
  assert.equal((await fetch(app.origin+'/.env')).status,403);
  assert.equal((await fetch(app.url+'?poll=1&sessionId=unknown')).status,401);
  const cors=await fetch(app.url,{method:'OPTIONS',headers:{Origin:'https://localhost'}});
  assert.equal(cors.status,204);assert.equal(cors.headers.get('Access-Control-Allow-Origin'),'https://localhost');
  assert.equal((await fetch(app.url,{headers:{Origin:'https://unapproved.example'}})).status,403);
  for(const f of ['b1','b2','b3'])assert.equal((await fetch(app.origin+'/assets/blood/'+f+'.png')).status,200);
});
test('TDM assigns alternating sides and unique slots; player 11 gets next arena',async t=>{
  const a=await setup(t);const joined=[];
  for(let i=0;i<11;i++){const p=await a.player('P'+i);await p.post('join_tdm');joined.push(last(await p.poll(),'tdm_joined'));}
  assert.deepEqual(joined.slice(0,10).map(j=>j.team),['left','right','left','right','left','right','left','right','left','right']);
  assert.deepEqual(joined.slice(0,10).map(j=>j.slot),[0,0,1,1,2,2,3,3,4,4]);
  assert.notEqual(joined[0].realm,joined[10].realm);assert.notEqual(joined[0].arena.key,joined[10].arena.key);
});
test('Room isolation, canonical teams, and late-join state snapshots',async t=>{
  const a=await setup(t),p=await a.player('Host'),q=await a.player('Guest'),r=await a.player('Other');
  await p.post('create_realm',{realm:'Friends'});await q.post('join_realm',{realm:'Friends'});await r.post('create_realm',{realm:'Other'});
  await p.poll();await q.poll();await r.poll();
  await p.post('player_state',{state:packet('clearing')});
  const msg=last(await q.poll(),'player_state');assert.equal(msg.state.realm,'Friends');assert.equal(msg.state.multiplayerKind,'custom');assert.equal(msg.state.tdmTeam,null);
  assert.equal(last(await r.poll(),'player_state'),undefined);
  await q.post('request_states');assert.equal(last(await q.poll(),'player_state').id,p.id);
  await p.post('leave_room');assert.ok(last(await q.poll(),'realm_closed'));
});
test('Latest state coalesces; unacknowledged control events replay; rejoin is idempotent',async t=>{
  const a=await setup(t),p=await a.player('One'),q=await a.player('Two');
  await p.post('join_tdm');await q.post('join_tdm');await p.poll();await q.poll();
  for(let i=1;i<=8;i++)await p.post('player_motion',{state:{...packet(),x:i,seq:i}});
  const msgs=await q.poll(),moves=msgs.filter(m=>m.type==='player_motion');assert.equal(moves.length,1);assert.equal(moves[0].state.x,8);
  await p.post('join_tdm');const d=await p.poll(0);assert.ok(last(d,'tdm_joined'));assert.ok(last(await p.poll(0),'tdm_joined'));
  assert.equal([...a.rooms.values()][0].members.size,2);
});
test('TDM score counts valid deaths once, refuses friendly fire, and returns finished match to menu',async t=>{
  const a=await setup(t,{tdmLimit:1,returnMs:100}),p=await a.player('One'),q=await a.player('Two'),friend=await a.player('Friend');
  for(const x of [p,q,friend])await x.post('join_tdm');
  await p.poll();await q.poll();await friend.poll();
  await friend.post('tdm_death',{deathId:'friendly',killerId:p.id});
  assert.equal([...a.rooms.values()][0].leftScore,0);
  await q.post('tdm_death',{deathId:'death-1',killerId:p.id});
  await q.post('tdm_death',{deathId:'death-1',killerId:p.id});
  const m=last(await p.poll(),'tdm_match_over');assert.equal(m.leftScore,1);assert.equal(m.winner,'left');assert.equal(m.players.find(x=>x.id===p.id).kills,1);
  a.advance(110);assert.ok(last(await p.poll(),'tdm_return_menu'));assert.equal(a.rooms.size,0);
});
test('Duel countdown, first-to-three, delayed scoring and disconnect cancellation',async t=>{
  const a=await setup(t,{countdownMs:100,duelTradeMs:10}),p=await a.player('One'),q=await a.player('Two');
  await p.post('join_duel');assert.ok(last(await p.poll(),'duel_waiting'));
  await q.post('join_duel');const start=last(await q.poll(),'duel_started');assert.equal(start.scoreLimit,3);
  await q.post('duel_death',{matchId:start.matchId,killerId:p.id,deathId:'too-soon'});assert.equal([...a.rooms.values()][0].roundDeaths.size,0);
  for(let i=0;i<3;i++){a.advance(110);await q.post('duel_death',{matchId:start.matchId,killerId:p.id,deathId:'round-'+i});a.advance(11);}
  assert.equal(last(await p.poll(),'duel_match_over').winnerId,p.id);
  await q.post('leave_room');assert.ok(last(await p.poll(),'duel_cancelled'));
});
test('Duel counts both blows within the return-blow window',async t=>{
  const a=await setup(t,{countdownMs:1,duelTradeMs:650}),p=await a.player('One'),q=await a.player('Two');
  await p.post('join_duel');await q.post('join_duel');const start=last(await p.poll(),'duel_started');
  a.advance(2);await p.post('duel_death',{matchId:start.matchId,killerId:q.id,deathId:'a'});
  a.advance(500);await q.post('duel_death',{matchId:start.matchId,killerId:p.id,deathId:'b'});a.advance(151);
  const r=last(await p.poll(),'duel_round');assert.deepEqual(r.players.map(x=>x.kills),[1,1]);assert.equal(r.round,2);
});
test('Co-op world authority, blood relay/cap, and Cuplets challenge/turn relay',async t=>{
  const a=await setup(t),p=await a.player('One'),q=await a.player('Two');
  await p.post('create_realm',{realm:'Friends'});await q.post('join_realm',{realm:'Friends'});
  await p.post('player_state',{state:packet('clearing')});await q.post('player_state',{state:packet('clearing')});await p.poll();await q.poll();
  const [leader,follower]=[p,q].sort((a,b)=>a.id.localeCompare(b.id));
  await follower.post('world_state',{state:{bots:[],arrows:[]}});assert.equal(last(await leader.poll(),'world_state'),undefined);
  await leader.post('world_state',{state:{bots:[],arrows:[]}});assert.equal(last(await follower.poll(),'world_state').id,leader.id);
  for(let i=0;i<7;i++)await p.post('blood_effect',{effect:{id:'blood-'+i,x:42,y:81,width:247,height:248}});
  assert.equal([...a.rooms.values()][0].blood.length,6);assert.equal(last(await q.poll(),'blood_effect').effect.x,42);
  await p.post('player_state',{state:packet('cuplets')});await q.post('player_state',{state:packet('cuplets')});
  await p.post('challenge',{targetId:q.id});assert.equal(last(await q.poll(),'challenge').fromId,p.id);
  await q.post('challenge_response',{fromId:p.id,accept:true});const start=last(await p.poll(),'match_start');assert.equal(start.role,1);assert.equal(last(await q.poll(),'match_start').role,2);
  const state={p1Holes:Array(7).fill({count:2,status:'active'}),p2Holes:Array(7).fill({count:2,status:'active'}),currentPlayer:1};
  await p.post('game_state',{matchId:start.matchId,state});assert.equal(last(await q.poll(),'game_state').state.p1Holes[0].status,'active');
  await q.post('game_state',{matchId:start.matchId,state});assert.equal(last(await p.poll(),'game_state'),undefined);
  await p.post('game_state',{matchId:start.matchId,state:{...state,currentPlayer:2}});assert.equal(last(await q.poll(),'game_state').state.currentPlayer,2);
});
test('Expired host session closes its realm after reconnect grace',async t=>{
  const a=await setup(t,{sessionTTL:100}),p=await a.player('Host'),q=await a.player('Guest');
  await p.post('create_realm',{realm:'Temporary'});await q.post('join_realm',{realm:'Temporary'});await q.poll();
  a.advance(70);await q.post('request_lobby');a.advance(40);
  assert.ok(last(await q.poll(),'realm_closed'));assert.equal(a.sessions.has(p.key),false);
});
function client(origin,name){
  const window=new EventTarget(),doc=new EventTarget(),nameEl={value:name},line={classList:{toggle(){}},textContent:''};
  doc.getElementById=id=>id==='mpPlayerName'?nameEl:line;doc.hidden=false;
  const stored=new Map(),timers=new Set();
  const set=(fn,ms)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer);return timer;};
  const ctx={window,document:doc,location:{origin,protocol:'http:'},navigator:{onLine:true},crypto:webcrypto,sessionStorage:{getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v)},URL,fetch,AbortController,CustomEvent,console,setTimeout:set,clearTimeout,Set};
  const events=[];window.confirm=()=>false;window.alert=message=>events.push({type:'alert',message});
  for(const e of ['tdmJoined','remotePlayerMotion','networkPlayers','networkStatus'])window.addEventListener('flowerOfBattle:'+e,ev=>events.push({...ev.detail,type:e}));
  vm.runInNewContext(readFileSync(require.resolve('../public/network-client.js'),'utf8'),ctx);
  return{window,events,api:window.FOBNetwork,stop(){window.dispatchEvent(new Event('beforeunload'));timers.forEach(clearTimeout);}};
}
async function waitFor(fn){const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw new Error('Timed out waiting for client');await new Promise(r=>setTimeout(r,10));}}
test('Actual browser client script connects two players, moves, and resumes without duplicate membership',async t=>{
  const app=await setup(t,{now:Date.now}),a=client(app.origin,'Alice'),b=client(app.origin,'Bob');t.after(()=>{a.stop();b.stop();});
  await waitFor(()=>a.api.connected&&b.api.connected);a.api.joinTdm();b.api.joinTdm();
  await waitFor(()=>a.events.some(e=>e.type==='tdmJoined')&&b.events.some(e=>e.type==='tdmJoined'));
  a.api.sendPlayerMotion({...packet(),x:321});await waitFor(()=>b.events.some(e=>e.type==='remotePlayerMotion'&&e.state.x===321));
  const id=a.api.id,joins=a.events.filter(e=>e.type==='tdmJoined').length;
  a.api.reconnect();await waitFor(()=>a.api.connected&&a.events.filter(e=>e.type==='tdmJoined').length>joins);
  assert.equal(a.api.id,id);assert.equal([...app.rooms.values()][0].members.size,2);
});
