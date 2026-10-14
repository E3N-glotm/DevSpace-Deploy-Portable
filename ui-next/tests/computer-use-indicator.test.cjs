'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createComputerUseIndicator}=require('../electron/computer-use-indicator.cjs');
const fs=require('node:fs');
const path=require('node:path');
const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');

function fixture(){
  let ms=1000, windows=[], bounds=[{x:0,y:0,width:1920,height:1080}];
  class MockWindow{
    constructor(opts){this.opts=opts;this.visible=false;this.destroyed=false;
      this.webContents={setWindowOpenHandler(){},on(){}};windows.push(this);}
    isDestroyed(){return this.destroyed;}
    isVisible(){return this.visible;}
    showInactive(){this.visible=true;}
    hide(){this.visible=false;}
    destroy(){this.destroyed=true;}
    setIgnoreMouseEvents(ignore){this.ignore=ignore;}
    setAlwaysOnTop(v,l){this.top=v;this.level=l;}
    setContentProtection(v){this.protected=v;}
    loadURL(url){this.url=url;return Promise.resolve();}
  }
  const indicator=createComputerUseIndicator({BrowserWindow:MockWindow,
    screen:{getAllDisplays:()=>bounds.map(bounds=>({bounds}))},now:()=>ms});
  return {indicator,windows,setTime:v=>ms=v,setDisplays:v=>bounds=v};
}

test('no gold overlay without a matching, authorized active lease pulse',()=>{
  const f=fixture();
  const broker={leaseId:'other',status:'running',activityUntilAt:new Date(5000).toISOString()};
  assert.equal(f.indicator.update({leaseId:'owned',enabled:true,broker}),false);
  assert.equal(f.indicator.update({leaseId:'other',enabled:false,broker}),false);
  assert.equal(f.windows.length,0);
  assert.equal(f.indicator.visible,false);
});

test('gold border remains click-through and excluded from screenshots',()=>{
  const f=fixture();
  const broker={leaseId:'owned',status:'running',activityUntilAt:new Date(90000).toISOString()};
  assert.equal(f.indicator.update({leaseId:'owned',enabled:true,broker}),true);
  assert.equal(f.windows.length,1);
  const w=f.windows[0];
  assert.equal(w.ignore,true);
  assert.equal(w.protected,true);
  assert.equal(w.level,'screen-saver');
  assert.equal(w.opts.focusable,false);
  assert.equal(w.opts.webPreferences.nodeIntegration,false);
  assert.match(decodeURIComponent(w.url),/border:7px solid #E2B73F/);
  assert.equal(w.visible,true);
  f.setTime(91000);
  assert.equal(f.indicator.update({leaseId:'owned',enabled:true,broker}),false);
  assert.equal(w.visible,false);
});

test('monitor changes replace overlays; disable and quit remove them',()=>{
  const f=fixture();
  const broker={leaseId:'owned',status:'running',activityUntilAt:new Date(100000).toISOString()};
  f.indicator.update({leaseId:'owned',enabled:true,broker});
  f.setDisplays([{x:-1600,y:0,width:1600,height:900},{x:0,y:0,width:1920,height:1080}]);
  f.indicator.update({leaseId:'owned',enabled:true,broker});
  assert.equal(f.windows.length,3);
  assert.equal(f.windows[0].destroyed,true);
  f.indicator.update({leaseId:'owned',enabled:false,broker});
  assert.equal(f.indicator.visible,false);
  f.indicator.dispose();
  assert.equal(f.windows.slice(1).every(w=>w.destroyed),true);
});

test('lease heartbeat retries after broker restart while the owner CU switch remains enabled',()=>{
  const heartbeat=main.slice(main.indexOf('computerUseHeartbeat=setInterval(async()=>'),
    main.indexOf('remoteAutoRecoverTimer=setInterval('));
  assert.match(heartbeat,/deployment\.features\?\.computerUse!==true/);
  assert.match(heartbeat,/deployment\.permissions\?\.allowComputerUse!==true/);
  assert.match(heartbeat,/try \{ await ensureComputerUseLease\(\); \}/);
  assert.doesNotMatch(heartbeat,/if\(closing\|\|!computerUseLeaseId\)return/);
});
