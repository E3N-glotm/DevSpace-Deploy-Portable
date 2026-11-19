const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {app,BrowserWindow}=require('electron');
const project=path.resolve(__dirname,'../..');
app.setPath('userData',process.env.DEVSPACE_FLOW_LAYOUT_USER_DATA);
app.disableHardwareAcceleration();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let window;
app.whenReady().then(async()=>{
  window=new BrowserWindow({width:1100,height:800,show:false,webPreferences:{preload:path.join(__dirname,'agent-flow-layout-preload.cjs')}});
  const run=fn=>window.webContents.executeJavaScript('('+fn.toString()+')()');
  async function wait(fn){for(let i=0;i<150;i++){if(await run(fn))return;await sleep(40);}throw Error('Expected UI condition: '+fn);}
  await window.loadFile(path.join(project,'ui-next/dist/index.html'));
  await wait(()=>!!document.querySelector('[data-page="agent-runtime"]'));
  await run(()=>document.querySelector('[data-page="agent-runtime"]').click());
  await wait(()=>document.querySelectorAll('.agent-flow-node').length>=3);
  const results=[];
  for(const [width,zoom] of [[1100,1],[860,1],[1100,1.5]]){
    window.setSize(width,800);
    window.webContents.setZoomFactor(zoom);
    await sleep(160);
    const layout=await run(()=>{
      const cardNodes=[...document.querySelectorAll('.agent-flow-node')];
      return cardNodes.map(node=>{
        const head=node.querySelector('.agent-flow-node-head');
        const title=head.querySelector('strong');
        const icon=head.querySelector('svg');
        const preview=node.querySelector('.agent-flow-preview');
        const b=node.getBoundingClientRect(),h=head.getBoundingClientRect(),i=icon.getBoundingClientRect(),t=title.getBoundingClientRect();
        return {title:title.textContent,tooltip:title.title,width:b.width,headContained:h.left>=b.left&&h.right<=b.right,
          titleContained:t.left>=b.left&&t.right<=b.right,iconContained:i.left>=b.left&&i.right<=b.right,
          contentsContained:node.scrollWidth<=node.clientWidth+1,
          previewContained:!preview||preview.scrollWidth<=preview.clientWidth+1,
          ellipsis:getComputedStyle(title).textOverflow==='ellipsis'&&title.scrollWidth>title.clientWidth};
      });
    });
    for(const x of layout){
      assert.ok(x.headContained&&x.titleContained&&x.iconContained&&x.contentsContained&&x.previewContained,JSON.stringify({width,zoom,x}));
      assert.equal(x.tooltip,x.title);
    }
    assert.ok(layout.some(x=>x.ellipsis),'Expected an ellipsis for the long title');
    results.push({width,zoom,cards:layout.length,contained:true});
  }
  window.webContents.setZoomFactor(1);
  window.setSize(1100,800);
  await run(()=>document.querySelector('.agent-flow-node').click());
  await wait(()=>!!document.querySelector('[role="dialog"].agent-flow-detail'));
  assert.ok(await run(()=>{
    const dialog=document.querySelector('[role="dialog"].agent-flow-detail');
    return dialog.textContent.includes('Qwen flash next')&&dialog.textContent.includes('G:');
  }));
  await run(()=>[...document.querySelectorAll('.agent-flow-detail button')].find(x=>x.textContent.trim()==='关闭').click());
  await wait(()=>!document.querySelector('[role="dialog"].agent-flow-detail'));
  console.log(JSON.stringify({layouts:results,fullTitleAndDetail:true}));
  window.destroy();app.exit(0);
}).catch(error=>{console.error(error);window?.destroy();app.exit(1);});
