'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {collisionPoint,createManager}=require('../public/battle-effects');
function fixture(){
  let time=1000;
  function el(){return{style:{},children:[],setAttribute(){},appendChild(e){this.children.push(e);e.parent=this;},insertBefore(e,before){const at=this.children.indexOf(before);this.children.splice(at<0?this.children.length:at,0,e);e.parent=this;},remove(){if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1);}};}
  const camera=el(),bg=el(),fighter=el();bg.nextSibling=fighter;camera.appendChild(bg);camera.appendChild(fighter);
  const document={createElement:el,getElementById:id=>id==='camera'?camera:id==='bgImg'?bg:null};
  const rt={currentRealm:null,currentScene:'clearing',gameMode:'story'};global.FOBGetRuntimeState=()=>rt;
  const fx=createManager({document,now:()=>time});fx.collisionPoint=collisionPoint;
  return{fx,camera,rt,advance(ms){time+=ms;fx.tick();}};
}
test('Blood frame boundaries are exactly 100 ms and 200 ms; B3 persists at the collision top left',()=>{
  const {fx,advance,camera}=fixture();fx.spawn({x:17,y:29});
  assert.deepEqual(fx.inspect().frames,[0]);assert.equal(fx.inspect().effects[0].left,'17px');assert.equal(fx.inspect().effects[0].top,'29px');
  assert.equal(camera.children[1].id,'bloodLayer');assert.equal(camera.children[1].style.cssText.includes('z-index:0'),true);
  advance(99);assert.deepEqual(fx.inspect().frames,[0]);advance(1);assert.deepEqual(fx.inspect().frames,[1]);
  advance(99);assert.deepEqual(fx.inspect().frames,[1]);advance(1);assert.deepEqual(fx.inspect().frames,[2]);
  advance(60000);assert.deepEqual(fx.inspect().frames,[2]);assert.equal(fx.inspect().effects[0].left,'17px');
});
test('Seventh blood effect removes oldest; changing battlefield clears blood and pending hits',()=>{
  const {fx,rt,advance}=fixture();for(let i=0;i<7;i++)fx.spawn({x:i,y:50});
  assert.equal(fx.inspect().count,6);assert.equal(fx.inspect().effects[0].left,'1px');
  let hit=false;const target={};fx.schedule(target,()=>{hit=true;});rt.currentScene='moor';advance(501);
  assert.equal(hit,false);assert.equal(target._swordHitPending,false);assert.equal(fx.inspect().count,0);
});
test('Collision point is geometric entry, with vertical, head-circle, inside, and miss cases',()=>{
  assert.deepEqual(collisionPoint([{x:-100,y:0},{x:100,y:0}],0,0,17.5,50,17.5),{x:-17.5,y:0});
  assert.deepEqual(collisionPoint([{x:0,y:-100},{x:0,y:100}],0,0,17.5,50,17.5),{x:0,y:-67.5});
  assert.deepEqual(collisionPoint([{x:0,y:0},{x:0,y:0}],0,0,17.5,50,17.5),{x:0,y:0});
  assert.equal(collisionPoint([{x:90,y:0},{x:90,y:100}],0,0,17.5,50,17.5),null);
});
test('Game sword collision permits both return blows and applies actual F0 only at 500 ms',()=>{
  const {fx,advance}=fixture();let pose='F1',botDeaths=0,scars=0;
  const source=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
  const core=source.slice(source.indexOf('  function strikePlayer(skipSound)'),source.indexOf('  // fighter wrapper sizing'));
  const tang=[{x:300,y:326},{x:500,y:326}];
  const bot={x:410,y:500,tang};
  const ctx={window:{FOBEffects:fx},player:{x:400,y:500},pRig:{},enemyBots:[bot],allyBots:[],playerDefeated:false,tdmRoundEnded:false,currentScene:'clearing',Ht:248,BOX_Y_RISE:50,BOX_HALF_W:17.5,BOX_HALF_H:50,HEAD_RADIUS:17.5,
    isRespawning:()=>false,tdmSpawnProtected:()=>false,playHitSound(){},hidePlayerArmRig(){},setPose:v=>{pose=v;},addScar:()=>{scars++;},reportOnlineDeath(){},
    botStruck(){botDeaths++;},allyStruck(){},dismountRider(){},knockShieldOff(){}};
  vm.createContext(ctx);vm.runInContext(core,ctx);
  ctx.checkTangHits(tang);assert.equal(fx.inspect().pending,2);assert.equal(pose,'F1');assert.equal(ctx.playerDefeated,false);
  ctx.checkTangHits(tang);assert.equal(fx.inspect().pending,2);assert.equal(fx.inspect().count,2);
  advance(499);assert.equal(pose,'F1');assert.equal(botDeaths,0);
  advance(1);assert.equal(pose,'F0');assert.equal(ctx.playerDefeated,true);assert.equal(botDeaths,1);assert.equal(scars,1);
});
test('New index and all browser scripts parse; original server address is removed',()=>{
  const dir=require('node:path').resolve(__dirname,'../public');const html=fs.readFileSync(dir+'/index.html','utf8');
  assert.equal(html.includes('176-142-72-87'),false);
  for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))if(m[1].trim())new vm.Script(m[1]);
  for(const f of ['server-config.js','network-client.js','battle-effects.js','billing-bridge.js'])new vm.Script(fs.readFileSync(dir+'/'+f,'utf8'),{filename:f});
});
