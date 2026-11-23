'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
if(!process.versions.electron){
  const temp=fs.mkdtempSync(path.join(root,'.test-cache','mobile-credential-ui-'));
  const env={...process.env,DEVSPACE_MOBILE_UI_TEST_DIR:temp};delete env.ELECTRON_RUN_AS_NODE;
  try{
    const result=spawnSync(path.join(root,'ui-next','runtime','electron.exe'),[__filename,'--disable-gpu'],{
      cwd:root,env,encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:256*1024
    });
    if(result.status!==0)throw Error(String(result.stdout||'')+String(result.stderr||''));
    const receipt=String(result.stdout).split(/\r?\n/).find(x=>x.startsWith('{"passed":true'));
    assert.ok(receipt,'Browser test must return a success receipt');
    console.log(receipt);
  }finally{fs.rmSync(temp,{recursive:true,force:true,maxRetries:4,retryDelay:150});}
}else{
  const {app,BrowserWindow,ipcMain}=require('electron');
  const temp=process.env.DEVSPACE_MOBILE_UI_TEST_DIR;
  app.setPath('userData',path.join(temp,'userData'));
  app.setPath('sessionData',path.join(temp,'sessionData'));
  const preload=path.join(temp,'preload.cjs');
  fs.writeFileSync(preload,`const {contextBridge,ipcRenderer}=require('electron');
    contextBridge.exposeInMainWorld('DevSpaceNative',Object.fromEntries(
      ['getState','saveConfig','copyCredential','changeCredential','copyText','startServer','stopServer',
       'checkRoot','clearNgrok','clearCloudflare','clearOAuth','openExternal','provisionNgrok','discoverNgrokDomains']
      .map(name=>[name,(...args)=>ipcRenderer.sendSync('mobile-native-test',name,args)])));`);
  let state={appVersion:'test',ownerPasswordConfigured:false,cloudflareConfigured:false,
    publicBaseUrl:'https://fixture.invalid',localPort:7676,fullAccess:false,startOnBoot:false,
    keepWakeLock:true,allowScreenControl:true,allowAppManagement:true,allowFileWrite:true,
    tunnelAutoReconnect:true,verboseTunnelLogs:false,ngrokEnabled:false,cloudflareEnabled:false};
  const calls=[];let copyFails=false;
  ipcMain.on('mobile-native-test',(event,name,args)=>{
    calls.push({name,args});
    event.returnValue=JSON.stringify(name==='getState'?state:
      name==='copyCredential'&&copyFails?{ok:false,message:'复制测试失败'}:{ok:true,message:'queued'});
  });
  app.whenReady().then(async()=>{
    const win=new BrowserWindow({show:false,width:360,height:780,useContentSize:true,
      webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
    const run=script=>win.webContents.executeJavaScript(script);
    try{
      await win.loadFile(path.resolve(__dirname,'../app/src/main/assets/ui/index.html'));
      const first=await run(`({owner:$('ownerMask').textContent,disabled:$('ownerCopy').disabled,
        change:$('ownerChange').textContent,cf:$('cloudflareHint').textContent})`);
      assert.deepEqual(first,{owner:'未设置',disabled:true,change:'设置',cf:'未配置'});
      state={...state,ownerPasswordConfigured:true,cloudflareConfigured:true};
      await run('DevSpaceUI.onState('+JSON.stringify(state)+')');
      assert.deepEqual(await run(`({owner:$('ownerMask').textContent,disabled:$('ownerCopy').disabled,
        change:$('ownerChange').textContent,cf:$('cloudflareHint').textContent})`),
        {owner:'••••••••',disabled:false,change:'更换',cf:'已配置'});
      await run(`$('publicBaseUrl').value='https://unsaved.invalid';$('ngrokApiKey').value='unsaved-api-fixture';`);
      const before=calls.length;
      await run(`$('ownerCopy').click();$('cloudflareCopy').click();$('ownerChange').click();$('cloudflareChange').click();`);
      assert.deepEqual(calls.slice(before),[
        {name:'copyCredential',args:['ownerPassword']},{name:'copyCredential',args:['cloudflareToken']},
        {name:'changeCredential',args:['ownerPassword']},{name:'changeCredential',args:['cloudflareToken']}]);
      await run('DevSpaceUI.onState('+JSON.stringify(state)+')');
      assert.deepEqual(await run(`[$('publicBaseUrl').value,$('ngrokApiKey').value]`),
        ['https://unsaved.invalid','unsaved-api-fixture']);
      const form=await run('collect()');
      assert.equal(Object.hasOwn(form,'ownerPassword'),false);
      assert.equal(Object.hasOwn(form,'cloudflareToken'),false);
      assert.equal(await run(`document.getElementById('ownerPassword')===null&&document.getElementById('cloudflareToken')===null`),true);
      copyFails=true;await run(`$('ownerCopy').click()`);
      assert.equal(await run(`$('toast').textContent`),'复制测试失败');
      copyFails=false;
      await run(`DevSpaceUI.onEvent('credentialCopied',{ok:true,message:'复制成功测试'})`);
      assert.equal(await run(`$('toast').textContent`),'复制成功测试');
      const viewports=[280,320,360,412,720];
      for(const width of viewports){
        win.setContentSize(width,780);await new Promise(resolve=>setTimeout(resolve,50));
        for(const page of ['mcp','tunnel']){
          await run('showPage('+JSON.stringify(page)+')');
          const geometry=await run(`({width:innerWidth,scroll:document.documentElement.scrollWidth,
            overflow:[...document.querySelectorAll('#page-${page} .credentialRow, #page-${page} .credentialValue, #page-${page} .credentialActions button')]
              .filter(x=>x.getBoundingClientRect().width>0).some(x=>x.getBoundingClientRect().right>innerWidth+1)})`.replaceAll('${page}',page));
          assert.equal(geometry.overflow,false,JSON.stringify({width,page,geometry}));
          assert.ok(geometry.scroll<=geometry.width+1,JSON.stringify({width,page,geometry}));
        }
      }
      console.log(JSON.stringify({passed:true,viewports,nativeCredentialOnly:true,noCredentialInForm:true,
        draftsPreserved:true,copyFailureHandled:true,statusRefreshPreservesDraft:true}));
      win.destroy();app.exit(0);
    }catch(error){console.error(error.stack||String(error));win.destroy();app.exit(1);}
  }).catch(error=>{console.error(error.stack||String(error));app.exit(1);});
}
