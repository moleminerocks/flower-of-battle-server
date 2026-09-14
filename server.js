'use strict';
// Uses Node built-ins only. The supplied game speaks HTTPS long-poll JSON,
// not Socket.IO. Keep one running server instance: match data lives in memory.
const http = require('node:http');
const { randomUUID, randomInt } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PAIRS = {clearing:'backClearing',oakgrove:'backOakgrove',moor:'backMoor',outpost:'backOutpost',quagmire:'backQuagmire',tors:'backTors',heath:'backHeath',field1:'backField1',field3:'backField3',grass4:'backGrass4',ashforest:'backAshforest',tower:'backTower',cuplets:'backCuplets',port:'backPort',shore:'backShore',desert:'backDesert',wall:'backWall',city:'backCity'};
Object.entries(PAIRS).forEach(([a,b]) => { PAIRS[b] = a; });
const ARENAS = ['clearing','oakgrove','ashforest','quagmire','moor','tors','heath','port'];
const LABELS = ['The Clearing','Oak Grove','Ash Forest','Quagmire','The Moor','The Tors','The Heath','The Port'];
const MUSIC = ['steelrose','fields','siege','honour','warchant','sultan','adorethee','make'];
const TRANSIENT = new Set(['players','realms','player_state','player_motion','world_state','tdm_score','duel_score']);
const BOARD_SCENES = new Set(['cuplets','backCuplets','peaceCuplets']);
const clean = (v,n=80) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,n);
const number = (v,min=-100000,max=100000) => Number.isFinite(Number(v)) ? Math.max(min,Math.min(max,Number(v))) : 0;
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const point = v => object(v) ? {x:number(v.x),y:number(v.y)} : {x:0,y:0};
const segment = v => Array.isArray(v) && v.length === 2 ? v.map(point) : null;
function nodes(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0,100).map(v => {
    v = object(v) ? v : {};
    const out = {className:clean(v.className,500),style:clean(v.style,3500)};
    // These styles are applied only to existing fighter nodes. Block URLs and
    // CSS loading constructs; sprite references must be local image paths.
    if (/url\s*\(|@import|expression\s*\(|[<>]/i.test(out.style)) out.style = '';
    if (typeof v.src === 'string') out.src = /^(?:assets\/)?[a-z0-9_./ -]+\.(?:png|webp|gif|jpe?g|svg)$/i.test(v.src) && !v.src.includes('..') ? v.src : '';
    return out;
  });
}
function combat(v) {
  if (!object(v)) return null;
  return {...point(v),defeated:!!v.defeated,spawnProtected:!!v.spawnProtected,roundEnded:!!v.roundEnded,tang:segment(v.tang),parry:segment(v.parry),shot:object(v.shot)?{...point(v.shot),dirX:number(v.shot.dirX,-1,1),dirY:number(v.shot.dirY,-1,1),serial:number(v.shot.serial,0,1e15),time:number(v.shot.time,0,1e15)}:null};
}
function createGameServer(options={}) {
  const now = options.now || Date.now;
  const cfg = {sessionTTL:Number(process.env.SESSION_TTL_MS)||45000,maxSessions:Number(process.env.MAX_SESSIONS)||100,pollMs:20000,tdmLimit:100,duelLimit:3,countdownMs:3500,returnMs:10000,duelTradeMs:650,...options};
  const sessions = new Map(), byId = new Map(), rooms = new Map(), challenges = new Map(), boards = new Map();
  let nextArena = randomInt(ARENAS.length);
  const publicDir = path.resolve(__dirname,'public');
  const sessionKeyOK = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{20,128}$/.test(v);
  function sendJSON(res,status,value) {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify(value);
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(body)});
    res.end(body);
  }
  function flush(s) {
    if (!s.waiter) return;
    const waiter = s.waiter; s.waiter = null; clearTimeout(waiter.timer);
    const messages = s.events.map(e => e.message);
    sendJSON(waiter.res,200,{messages,cursor:messages.length?messages[messages.length-1].cursor:s.seq,serverTime:now()});
  }
  function queue(s,m) {
    if (!s || !sessions.has(s.key)) return;
    const key = TRANSIENT.has(m.type) ? m.type + ':' + (m.id || '') : null;
    if (key) s.events = s.events.filter(e => e.key !== key);
    const message = {...m,serverTime:now(),cursor:++s.seq};
    const bytes = Buffer.byteLength(JSON.stringify(message));
    s.events.push({key,message,bytes});
    let total = s.events.reduce((sum,e) => sum+e.bytes,0);
    while (s.events.length > 256 || total > 4*1024*1024) {
      let at = s.events.findIndex(e => e.key);
      if (at < 0) at = 0;
      total -= s.events[at].bytes; s.events.splice(at,1);
    }
    // Aggregate all synchronous changes from one command into one response.
    if (s.waiter && !s.flushPending) {
      s.flushPending = true;
      queueMicrotask(() => {s.flushPending=false;flush(s);});
    }
  }
  function members(r) { return [...r.members].map(id=>byId.get(id)).filter(Boolean); }
  function broadcast(r,m,except) { members(r).forEach(s=>{if(s.id!==except)queue(s,m);}); }
  function lobby() {
    const rs = [...rooms.values()];
    const tdm = rs.filter(r=>r.mode==='tdm'), duel = rs.filter(r=>r.mode==='duel');
    const waiting = [...sessions.values()].filter(s=>s.waiting).length;
    return {realms:rs.filter(r=>r.mode==='custom').map(r=>({name:r.realm,players:r.members.size,maxPlayers:10})),
      tdm:{players:tdm.reduce((n,r)=>n+r.members.size,0),maxPlayers:10,activeMatches:tdm.length},
      duel:{waiting,players:waiting+duel.reduce((n,r)=>n+r.members.size,0),activeMatches:duel.length,scoreLimit:cfg.duelLimit}};
  }
  function lobbyChanged() { const m={type:'realms',...lobby()}; sessions.forEach(s=>queue(s,m)); }
  function roster(r) {
    const all=members(r).map(s=>({id:s.id,name:s.name,scene:s.state?.scene||'',team:s.team}));
    members(r).forEach(s=>queue(s,{type:'players',players:all.map(p=>({...p,self:p.id===s.id}))}));
  }
  function score(r) {return {matchId:r.id,realm:r.realm,players:[...r.stats.values()].map(p=>({...p})),leftScore:r.leftScore,rightScore:r.rightScore,scoreLimit:r.mode==='duel'?cfg.duelLimit:cfg.tdmLimit,round:r.round,arena:r.arena,matchStartedAt:r.startedAt};}
  function sendScore(r) {broadcast(r,{type:r.mode+'_score',...score(r)});}
  function makeRoom(mode,realm,owner) {
    const idx = nextArena++ % ARENAS.length, id=randomUUID();
    const r={id,realm:realm||(mode+'-'+id),mode,owner,members:new Set(),stats:new Map(),leftScore:0,rightScore:0,round:1,startedAt:now(),countdownEndsAt:now()+cfg.countdownMs,endedAt:0,roundDeaths:new Map(),resolveAt:0,blood:[],arena:{key:ARENAS[idx],background:ARENAS[idx],label:LABELS[idx],music:MUSIC[idx]}};
    rooms.set(id,r);return r;
  }
  function states(s,r) {
    members(r).forEach(p=>{
      if(p.id===s.id)return;
      if(p.state)queue(s,{type:'player_state',id:p.id,name:p.name,state:p.state});
      if(p.motion)queue(s,{type:'player_motion',id:p.id,name:p.name,state:p.motion});
      if(p.world)queue(s,{type:'world_state',id:p.id,state:p.world});
    });
    if(r.blood.length)queue(s,{type:'blood_snapshot',blood:r.blood});
  }
  function sendJoined(s,r) {
    if(r.mode==='custom') queue(s,{type:'realm_joined',realm:r.realm,owner:r.owner===s.id});
    if(r.mode==='tdm')queue(s,{type:'tdm_joined',...score(r),team:s.team,slot:s.slot,maxPlayers:10,spawnProtectionMs:7000});
    if(r.mode==='duel') {
      const p=members(r).find(p=>p.id!==s.id);
      queue(s,{type:'duel_started',...score(r),side:s.team,opponent:p?{id:p.id,name:p.name}:{id:'',name:'Opponent'},countdownEndsAt:r.countdownEndsAt});
    }
    roster(r);states(s,r);
    if(r.mode!=='custom')sendScore(r);
    if(r.endedAt)queue(s,{type:r.mode+'_match_over',...score(r),...r.result,endedAt:r.endedAt,returnAfterMs:cfg.returnMs});
  }
  function attach(s,r,team=null) {
    s.room=r.id;s.waiting=false;s.team=team;
    const used=members(r).filter(p=>p.team===team).map(p=>p.slot);
    s.slot=[0,1,2,3,4].find(n=>!used.includes(n))||0;
    s.state=null;s.motion=null;s.world=null;s.dead=false;
    r.members.add(s.id);
    if(r.mode!=='custom')r.stats.set(s.id,r.stats.get(s.id)||{id:s.id,name:s.name,team,kills:0,deaths:0});
  }
  function endBoard(s,message='Your Cuplets opponent left the board.') {
    if(!s.board)return;
    const b=boards.get(s.board);s.board=null;
    if(!b)return;
    boards.delete(b.id);
    for(const id of b.ids){const p=byId.get(id);if(p){p.board=null;queue(p,{type:'match_end',message});}}
  }
  function clearMembership(s) {
    endBoard(s);s.room=null;s.waiting=false;s.team=null;s.state=null;s.motion=null;s.world=null;s.dead=false;
    // Never deliver old room movement or a delayed join after leaving.
    s.events=s.events.filter(e=>e.message.type==='realms');
    queue(s,{type:'players',players:[]});
  }
  function leave(s,explicit=false) {
    const r=rooms.get(s.room);s.waiting=false;
    if(r){
      r.members.delete(s.id);broadcast(r,{type:'player_left',id:s.id});
      if((r.mode==='custom'&&r.owner===s.id)||r.mode==='duel') {
        for(const p of members(r)){
          clearMembership(p);
          queue(p,{type:r.mode==='duel'?'duel_cancelled':'realm_closed',message:r.mode==='duel'?'Your Duel opponent left the match.':'The realm creator left, so this realm has closed.'});
        }
        rooms.delete(r.id);
      } else if(!r.members.size) rooms.delete(r.id);
      else {roster(r);if(r.mode==='tdm')sendScore(r);}
    }
    clearMembership(s);if(explicit)queue(s,{type:'left_room'});
    lobbyChanged();
  }
  function finish(r,result) {
    if(r.endedAt)return;
    r.endedAt=now();r.result=result;
    broadcast(r,{type:r.mode+'_match_over',...score(r),...result,endedAt:r.endedAt,returnAfterMs:cfg.returnMs});
  }
  function kill(r,victim,killer,method) {
    const v=r.stats.get(victim.id),k=r.stats.get(killer?.id);
    if(!v)return;
    v.deaths++;
    if(k&&k.id!==v.id) {
      k.kills++;
      if(r.mode==='tdm'){if(k.team==='left')r.leftScore++;else r.rightScore++;}
      queue(killer,{type:r.mode+'_kill_recorded',victimId:v.id,matchId:r.id});
    }
    broadcast(r,{type:r.mode+'_kill_feed',matchId:r.id,killerId:k?.id||'',killerName:k?.name||'The battlefield',victimId:v.id,victimName:v.name,phrase:method==='arrow'?'has shot':'has slain'});
    sendScore(r);
  }
  function resolveDuel(r) {
    r.resolveAt=0;
    // Both victims may report during the half-second return-blow window.
    // Record both before advancing the round or choosing a winner.
    for(const [id,d] of r.roundDeaths){const v=byId.get(id);if(v)kill(r,v,byId.get(d.killerId),d.method);}
    r.roundDeaths.clear();
    const rows=[...r.stats.values()], winners=rows.filter(p=>p.kills>=cfg.duelLimit);
    if(winners.length===1) {finish(r,{winnerId:winners[0].id});return;}
    // A simultaneous deciding kill goes to another round (sudden death).
    if(winners.length===2&&winners[0].kills!==winners[1].kills){finish(r,{winnerId:rows.sort((a,b)=>b.kills-a.kills)[0].id});return;}
    r.round++;r.countdownEndsAt=now()+cfg.countdownMs;
    members(r).forEach(s=>{s.dead=false;});
    broadcast(r,{type:'duel_round',...score(r),countdownEndsAt:r.countdownEndsAt});
  }
  function checkDeaths(s,r,m) {
    if(!r||r.mode!==m.type.split('_')[0]||r.endedAt)return;
    const deathId=clean(m.deathId,100);
    if(!deathId||s.deaths.has(deathId)||s.dead)return;
    if(r.mode==='duel'&&(m.matchId!==r.id||now()<r.countdownEndsAt))return;
    const killer=byId.get(clean(m.killerId,80));
    if(!killer||killer.room!==s.room||killer.id===s.id||killer.team===s.team)return;
    s.deaths.add(deathId);if(s.deaths.size>256)s.deaths.delete(s.deaths.values().next().value);
    s.dead=true;s.diedAt=now();
    if(r.mode==='duel') {
      r.roundDeaths.set(s.id,{killerId:killer.id,method:clean(m.method,16)});
      if(!r.resolveAt)r.resolveAt=now()+cfg.duelTradeMs;
    } else {
      kill(r,s,killer,clean(m.method,16));
      if(r.leftScore>=cfg.tdmLimit||r.rightScore>=cfg.tdmLimit)finish(r,{winner:r.leftScore>=cfg.tdmLimit?'left':'right'});
    }
  }
  function sanitizeState(s,r,input,motion) {
    if(!object(input))return null;
    const scene=r.mode==='custom'?clean(input.scene,48):'tdm';
    if(!scene)return null;
    const state={realm:r.realm,scene,chapterName:clean(input.chapterName,100),visible:!!input.visible,...point(input),multiplayerKind:r.mode,tdmTeam:s.team,tdmSlot:s.slot,seq:number(input.seq,0,1e15),sentAt:now()};
    if(!motion) {
      state.nodes=nodes(input.nodes);state.combat=combat(input.combat);
      state.botCounts={enemy:number(input.botCounts?.enemy,0,60),ally:number(input.botCounts?.ally,0,60)};
    }
    return state;
  }
  function authority(r,scene) {
    return members(r).filter(p=>p.state?.visible&&(p.state.scene===scene||PAIRS[scene]===p.state.scene)).map(p=>p.id).sort()[0];
  }
  function boardState(v) {
    if(!object(v)||!Array.isArray(v.p1Holes)||!Array.isArray(v.p2Holes)||v.p1Holes.length!==7||v.p2Holes.length!==7)return null;
    const holes=a=>a.map(h=>({count:Math.floor(number(h?.count,0,200)),status:['active','black'].includes(h?.status)?h.status:'black'}));
    return {p1Holes:holes(v.p1Holes),p2Holes:holes(v.p2Holes),p1Store:number(v.p1Store,0,1000),p2Store:number(v.p2Store,0,1000),currentPlayer:v.currentPlayer===2?2:1,round:number(v.round,1,10000),gameOver:!!v.gameOver,winner:[0,1,2].includes(v.winner)?v.winner:null,drawReason:clean(v.drawReason,120),lastActionMsg:clean(v.lastActionMsg,300),lastMover:v.lastMover===2?2:1};
  }
  function command(s,m) {
    let r=rooms.get(s.room);
    switch(m.type){
      case 'set_name':
        s.name=clean(m.name,24)||'Player';
        if(r){const st=r.stats.get(s.id);if(st)st.name=s.name;roster(r);if(r.mode!=='custom')sendScore(r);}return;
      case 'request_lobby':queue(s,{type:'realms',...lobby()});return;
      case 'leave_room':leave(s,true);return;
      case 'join_tdm':{
        if(r?.mode==='tdm'){sendJoined(s,r);return;}
        leave(s);
        r=[...rooms.values()].find(q=>q.mode==='tdm'&&!q.endedAt&&q.members.size<10)||makeRoom('tdm');
        const left=members(r).filter(p=>p.team==='left').length,right=r.members.size-left;
        attach(s,r,left<=right?'left':'right');sendJoined(s,r);lobbyChanged();return;
      }
      case 'join_duel':{
        if(r?.mode==='duel'){sendJoined(s,r);return;}
        if(s.waiting){queue(s,{type:'duel_waiting',...lobby().duel});return;}
        leave(s);
        const other=[...sessions.values()].find(p=>p.waiting&&p.id!==s.id);
        if(!other){s.waiting=true;queue(s,{type:'duel_waiting',...lobby().duel});lobbyChanged();return;}
        r=makeRoom('duel');attach(other,r,'left');attach(s,r,'right');sendJoined(other,r);sendJoined(s,r);lobbyChanged();return;
      }
      case 'create_realm':case 'join_realm':{
        const name=clean(m.realm,32);
        if(r?.mode==='custom'&&r.realm===name){sendJoined(s,r);return;}
        const existing=[...rooms.values()].find(q=>q.mode==='custom'&&q.realm.toLowerCase()===name.toLowerCase());
        if(!name||(m.type==='create_realm'&&existing)||(m.type==='join_realm'&&(!existing||existing.members.size>=10))){
          queue(s,{type:'realm_unavailable',message:!name?'Enter a realm name.':existing?'That realm name is in use or the realm is full.':'That realm has closed.'});return;
        }
        leave(s);r=existing||makeRoom('custom',name,s.id);attach(s,r);sendJoined(s,r);lobbyChanged();return;
      }
      case 'request_states':if(r){roster(r);states(s,r);}return;
      case 'player_state':case 'player_motion':{
        if(!r)return;
        const state=sanitizeState(s,r,m.state,m.type==='player_motion');if(!state)return;
        const oldScene=s.state?.scene;
        if(m.type==='player_state'){
          s.state=state;
          if(s.board&&oldScene!==state.scene)endBoard(s);
          if(s.dead&&r.mode==='tdm'&&state.combat&&!state.combat.defeated&&now()-s.diedAt>=4500)s.dead=false;
        } else s.motion=state;
        broadcast(r,{type:m.type,id:s.id,name:s.name,state},s.id);return;
      }
      case 'world_state':{
        if(r?.mode!=='custom'||!object(m.state)||!s.state||authority(r,s.state.scene)!==s.id)return;
        const v=m.state;
        s.world={realm:r.realm,scene:s.state.scene,sentAt:now(),bots:(Array.isArray(v.bots)?v.bots:[]).slice(0,60).map(b=>({id:clean(b?.id,80),isAlly:!!b?.isAlly,...point(b),tang:segment(b?.tang),nodes:nodes(b?.nodes)})),arrows:(Array.isArray(v.arrows)?v.arrows:[]).slice(0,200).map(a=>({id:clean(a?.id,80),...point(a),stuck:!!a?.stuck,shooterIsAlly:!!a?.shooterIsAlly,nodes:nodes(a?.nodes)}))};
        broadcast(r,{type:'world_state',id:s.id,state:s.world},s.id);return;
      }
      case 'world_event':{
        if(r?.mode!=='custom'||!s.state||m.event?.kind!=='arrow_hit')return;
        const owner=byId.get(authority(r,s.state.scene));
        if(owner&&owner!==s)queue(owner,{type:'world_event',id:s.id,event:{kind:'arrow_hit',arrowId:clean(m.event.arrowId,80)}});return;
      }
      case 'blood_effect':{
        if(!r||!s.state||!object(m.effect))return;
        const e=m.effect,id=clean(e.id,120);
        if(!id||r.blood.some(v=>v.id===id))return;
        const effect={id,realm:r.realm,scene:s.state.scene,x:number(e.x),y:number(e.y),width:number(e.width,1,2000),height:number(e.height,1,2000),startedAt:now()};
        r.blood.push(effect);if(r.blood.length>6)r.blood.shift();
        broadcast(r,{type:'blood_effect',effect},s.id);return;
      }
      case 'tdm_death':case 'duel_death':checkDeaths(s,r,m);return;
      case 'challenge':{
        const to=byId.get(clean(m.targetId,80));
        if(!r||r.mode!=='custom'||!to||to===s||to.room!==s.room||s.board||to.board||!BOARD_SCENES.has(s.state?.scene)||!BOARD_SCENES.has(to.state?.scene)){queue(s,{type:'notice',message:'Both players must be at a Cuplets board in the same realm.'});return;}
        if(s.lastChallenge&&now()-s.lastChallenge<3000)return;s.lastChallenge=now();
        challenges.set(s.id+':'+to.id,{from:s.id,to:to.id,expires:now()+60000});
        queue(to,{type:'challenge',fromId:s.id,fromName:s.name});return;
      }
      case 'challenge_response':{
        const from=byId.get(clean(m.fromId,80)),key=(from?.id||'')+':'+s.id,c=challenges.get(key);challenges.delete(key);
        if(!c||c.expires<now()||!from||!r||from.room!==s.room||s.board||from.board)return;
        if(!m.accept){queue(from,{type:'challenge_declined',name:s.name});return;}
        if(!BOARD_SCENES.has(s.state?.scene)||!BOARD_SCENES.has(from.state?.scene))return;
        const b={id:randomUUID(),ids:[from.id,s.id],state:null};boards.set(b.id,b);from.board=b.id;s.board=b.id;
        b.ids.forEach((id,i)=>queue(byId.get(id),{type:'match_start',matchId:b.id,role:i+1,opponent:{id:b.ids[1-i],name:byId.get(b.ids[1-i]).name}}));return;
      }
      case 'game_state':{
        const b=boards.get(s.board);if(!b||m.matchId!==b.id)return;
        const role=b.ids.indexOf(s.id)+1;
        if(!b.state&&role!==1)return;
        if(b.state&&(b.state.gameOver||b.state.currentPlayer!==role))return;
        const state=boardState(m.state);if(!state)return;
        b.state=state;queue(byId.get(b.ids.find(id=>id!==s.id)),{type:'game_state',matchId:b.id,state});return;
      }
      default:queue(s,{type:'notice',message:'Unknown command: '+clean(m.type,40)});
    }
  }
  function sweep() {
    const t=now();
    for(const s of sessions.values())if(t-s.lastSeen>cfg.sessionTTL&&!s.waiter){leave(s);sessions.delete(s.key);byId.delete(s.id);}
    for(const [k,c] of challenges)if(t>c.expires)challenges.delete(k);
    for(const r of [...rooms.values()]){
      if(r.resolveAt&&t>=r.resolveAt&&!r.endedAt)resolveDuel(r);
      if(r.endedAt&&t>=r.endedAt+cfg.returnMs){
        for(const s of members(r)){clearMembership(s);queue(s,{type:r.mode+'_return_menu'});}
        rooms.delete(r.id);lobbyChanged();
      }
    }
  }
  const maintenance=setInterval(sweep,100);maintenance.unref();
  function cors(req,res) {
    const origin=req.headers.origin;
    if(!origin)return true;
    const configured=(process.env.ALLOWED_ORIGINS||'').split(',').map(v=>v.trim()).filter(Boolean);
    const host=req.headers.host;
    const allowed=['https://localhost','http://localhost','capacitor://localhost',process.env.RENDER_EXTERNAL_URL,...configured];
    if(!allowed.includes(origin)&&origin!=='https://'+host&&origin!=='http://'+host)return false;
    res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type, Accept');
    res.setHeader('Access-Control-Max-Age','600');return true;
  }
  async function body(req) {
    let bytes=0;const chunks=[];
    for await(const chunk of req){bytes+=chunk.length;if(bytes>2*1024*1024)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(chunk);}
    try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw Object.assign(new Error('Invalid JSON'),{status:400});}
  }
  async function api(req,res,url) {
    if(!cors(req,res)){sendJSON(res,403,{error:'Origin is not allowed. Add the app origin to ALLOWED_ORIGINS.'});return;}
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(req.method==='GET'&&!url.searchParams.has('poll')){sendJSON(res,200,{ok:true,service:'Flower of Battle multiplayer',transport:'https-long-poll',...lobby(),serverTime:now()});return;}
    if(req.method==='GET'){
      const s=sessions.get(url.searchParams.get('sessionId'));
      if(!s){sendJSON(res,401,{error:'Session expired; reconnect.'});return;}
      s.lastSeen=now();
      const since=number(url.searchParams.get('since'),0,s.seq);
      s.events=s.events.filter(e=>e.message.cursor>since);
      if(s.waiter)flush(s);
      const w={res,timer:null};s.waiter=w;
      w.timer=setTimeout(()=>{s.lastSeen=now();flush(s);},cfg.pollMs);
      res.on('close',()=>{if(s.waiter===w){clearTimeout(w.timer);s.waiter=null;}});
      if(s.events.length)flush(s);return;
    }
    if(req.method!=='POST'){sendJSON(res,405,{error:'Use GET or POST.'});return;}
    if(!String(req.headers['content-type']||'').startsWith('application/json')){sendJSON(res,415,{error:'Expected application/json.'});return;}
    const m=await body(req);
    if(!object(m)||!sessionKeyOK(m.sessionId)){sendJSON(res,400,{error:'Invalid session ID.'});return;}
    let s=sessions.get(m.sessionId);
    if(m.type==='hello'){
      if(!s){
        if(sessions.size>=cfg.maxSessions){sendJSON(res,503,{error:'Server is full. Try again shortly.'});return;}
        s={key:m.sessionId,id:randomUUID(),name:clean(m.name,24)||'Player',lastSeen:now(),seq:0,events:[],waiter:null,room:null,waiting:false,state:null,motion:null,world:null,board:null,deaths:new Set(),requests:new Set(),rate:{at:now(),count:0}};
        sessions.set(s.key,s);byId.set(s.id,s);
      }
      s.lastSeen=now();s.name=clean(m.name,24)||s.name;
      const current=rooms.get(s.room);
      if(current){broadcast(current,{type:'player_left',id:s.id},s.id);s.state=null;s.motion=null;s.world=null;}
      if(s.waiter)flush(s);
      // Rejoin/request_states supplies fresh membership and snapshots.
      // Old cursor ranges must not leak messages from a prior connection.
      s.events=[];endBoard(s,'Cuplets connection restarted. Please challenge again.');
      sendJSON(res,200,{messages:[{type:'welcome',id:s.id,...lobby(),serverTime:now()}],cursor:s.seq,serverTime:now()});return;
    }
    if(!s){sendJSON(res,401,{error:'Session expired; reconnect.'});return;}
    s.lastSeen=now();
    if(now()-s.rate.at>=1000)s.rate={at:now(),count:0};
    if(++s.rate.count>160){sendJSON(res,429,{error:'Too many messages.'});return;}
    const requestId=clean(m.requestId,120);
    if(!requestId||!s.requests.has(requestId)){
      command(s,m);
      if(requestId){s.requests.add(requestId);if(s.requests.size>256)s.requests.delete(s.requests.values().next().value);}
    }
    sendJSON(res,200,{ok:true,serverTime:now()});
  }
  const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.svg':'image/svg+xml','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.ico':'image/x-icon','.json':'application/json'};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/healthz'){sendJSON(res,200,{ok:true,players:sessions.size,rooms:rooms.size});return;}
      if(url.pathname==='/api/multiplayer'){await api(req,res,url);return;}
      if(!['GET','HEAD'].includes(req.method)){sendJSON(res,405,{error:'Method not allowed.'});return;}
      const decoded=decodeURIComponent(url.pathname);
      const file=path.resolve(publicDir,'.'+(decoded==='/'?'/index.html':decoded));
      if(!file.startsWith(publicDir+path.sep)||decoded.split('/').some(p=>p.startsWith('.'))){sendJSON(res,403,{error:'Forbidden'});return;}
      const stat=await fs.promises.stat(file).catch(()=>null);
      if(!stat?.isFile()){sendJSON(res,404,{error:'File not found',path:decoded});return;}
      const real=await fs.promises.realpath(file);
      if(!real.startsWith(publicDir+path.sep)){sendJSON(res,403,{error:'Forbidden'});return;}
      res.writeHead(200,{'Content-Type':MIME[path.extname(file).toLowerCase()]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':/\.(html|js)$/.test(file)?'no-cache':'public, max-age=3600'});
      if(req.method==='HEAD'){res.end();return;}
      const stream=fs.createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);
    }catch(e){if(!res.headersSent)sendJSON(res,e.status||500,{error:e.status?e.message:'Server error'});else res.destroy();}
  });
  server.requestTimeout=30000;server.headersTimeout=15000;server.keepAliveTimeout=65000;
  function stop(){clearInterval(maintenance);for(const s of sessions.values())flush(s);server.closeAllConnections();return new Promise(resolve=>server.close(resolve));}
  return {server,stop,sweep,sessions,rooms,boards};
}
if(require.main===module){
  const app=createGameServer();
  app.server.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('Flower of Battle online on port '+app.server.address().port));
  process.on('SIGTERM',()=>app.stop().then(()=>process.exit(0)));
  process.on('SIGINT',()=>app.stop().then(()=>process.exit(0)));
}
module.exports={createGameServer};
