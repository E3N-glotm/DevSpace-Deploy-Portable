'use strict';
// Launch with the portable Electron executable to verify the host's actual
// Chromium proxy routing without creating a UI window or changing services.
// Output is a single JSON object with public status codes; never reads tokens.
const {app,net,session}=require('electron');
const target=process.env.DEVSPACE_PUBLIC_TEST_URL;
if(!target||!/^https:\/\/[^/]+$/.test(target))throw new Error('Expected an HTTPS origin in DEVSPACE_PUBLIC_TEST_URL');
const done=async()=>{
  const started=Date.now();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  let report;
  try{
    const proxy=await session.defaultSession.resolveProxy(target+'/mcp');
    const replies=await Promise.allSettled([
      net.fetch(target+'/.well-known/oauth-protected-resource/mcp',
        {signal:controller.signal,cache:'no-store'}),
      net.fetch(target+'/mcp',{signal:controller.signal,cache:'no-store'}),
    ]);
    report={proxy,elapsedMs:Date.now()-started,
      results:replies.map(r=>r.status==='fulfilled'
        ?{status:r.value.status}:{error:r.reason?.message||String(r.reason)})};
  }catch(error){report={error:error.message||String(error)};}
  finally{clearTimeout(timer);}
  const output=process.env.DEVSPACE_PUBLIC_TEST_REPORT;
  if(output)require('node:fs').writeFileSync(output,JSON.stringify(report),'utf8');
  else process.stdout.write(JSON.stringify(report)+'\n');
  app.quit();
};
app.whenReady().then(done).catch(error=>{
  const output=process.env.DEVSPACE_PUBLIC_TEST_REPORT;
  if(output)require('node:fs').writeFileSync(output,JSON.stringify({error:error.message}),'utf8');
  app.exit(1);
});
