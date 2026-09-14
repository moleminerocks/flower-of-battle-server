'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../public');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
// Check explicit paths and principal dynamically named scene files. Keep the
// whole original assets folder: this quick check is not an exhaustive manifest.
const required=new Set(['assets/title.png','assets/move.png','assets/thumbpad.png',
  'assets/peasant/F1.png','assets/peasant/arm.png','assets/peasant/sword.png',
  'assets/blood/b1.png','assets/blood/b2.png','assets/blood/b3.png']);
for(const m of html.matchAll(/['"](assets\/[a-zA-Z0-9_/.-]+\.(?:png|mp3|wav|ogg))['"]/g))required.add(m[1]);
for(const m of html.matchAll(/setSceneBackground\('([a-zA-Z0-9]+)'\)/g))required.add('assets/scenes/'+m[1]+'.png');
const missing=[...required].filter(f=>!fs.existsSync(path.join(root,f))).sort();
if(missing.length){console.log('Copy your original assets folder into public/assets. Missing common files:\n'+missing.join('\n'));process.exitCode=1;}
else console.log('Common assets are present. Still check each class and chapter in-game.');
