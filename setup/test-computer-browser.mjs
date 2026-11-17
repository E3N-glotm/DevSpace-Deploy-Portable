import {strict as assert} from "node:assert";
import {spawn} from "node:child_process";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync} from "node:fs";
import {createServer} from "node:http";
import {join,resolve} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {useBrowser} from "../app/node_modules/@waishnav/devspace/dist/computer-browser.js";

const browser=process.env.DEVSPACE_BROWSER_TEST_EXE??[
  join(process.env["ProgramFiles(x86)"]||"C:/Program Files (x86)","Microsoft/Edge/Application/msedge.exe"),
  join(process.env.ProgramFiles||"C:/Program Files","Google/Chrome/Application/chrome.exe"),
].find(existsSync);
assert.ok(browser,"Set DEVSPACE_BROWSER_TEST_EXE to Edge or Chrome.");
const tests=resolve(".test-cache");
mkdirSync(tests,{recursive:true});
const profile=mkdtempSync(join(tests,"browser-dom-"));
const oldPort=process.env.DEVSPACE_BROWSER_CDP_PORT;
let loads=0;
const page=createServer(async(request,response)=>{
  response.setHeader("Content-Type","text/html; charset=utf-8");
  if(request.url!=="/"){response.end("");return;}
  loads+=1;
  await delay(110);
  response.end("<!doctype html><title>DOM fixture</title><main><h1>Ready "+loads+"</h1><p id='copy'>Direct text from the page</p><button>Copy</button><script>const range=document.createRange();range.selectNodeContents(document.querySelector('#copy'));getSelection().addRange(range)</script></main>");
});
await new Promise((resolve,reject)=>page.listen(0,"127.0.0.1",resolve).once("error",reject));
const url="http://127.0.0.1:"+page.address().port+"/";
const child=spawn(browser,["--headless=new","--no-first-run","--disable-gpu","--disable-background-networking",
  "--remote-debugging-address=127.0.0.1","--remote-debugging-port=0","--user-data-dir="+profile,url],{stdio:"ignore",windowsHide:true});
const closed=new Promise(resolve=>child.once("close",resolve));
let spawnError;
child.on("error",error=>{spawnError=error;});
try{
  const marker=join(profile,"DevToolsActivePort");
  const expires=Date.now()+10000;
  while(!existsSync(marker)&&Date.now()<expires&&!spawnError&&child.exitCode===null)await delay(100);
  if(spawnError)throw spawnError;
  assert.ok(existsSync(marker),"Browser did not create DevToolsActivePort.");
  process.env.DEVSPACE_BROWSER_CDP_PORT=readFileSync(marker,"utf8").split(/\r?\n/)[0];
  let tab;
  for(let i=0;i<20&&!tab;i++){
    const state=await useBrowser({operation:"tabs"});
    tab=state.tabs.find(tab=>tab.url===url);
    if(!tab)await delay(100);
  }
  assert.ok(tab);
  let doc;
  for(let i=0;i<20;i++){
    doc=await useBrowser({operation:"read",tabId:tab.id,selector:"#copy",limit:11});
    if(doc.found)break;
    await delay(100);
  }
  assert.equal(doc.text,"Direct text");
  assert.equal(doc.nextOffset,11);
  assert.equal((await useBrowser({operation:"read",tabId:tab.id,selector:"#copy",offset:11})).text," from the page");
  assert.equal((await useBrowser({operation:"selection",tabId:tab.id})).text,"Direct text from the page");
  assert.ok((await useBrowser({operation:"read",tabId:tab.id})).controls.some(control=>control.label==="Copy"));
  const result=await useBrowser({operation:"reload",tabId:tab.id});
  assert.equal(result.readyState,"complete");
  assert.equal(result.newDocument,true);
  assert.equal(loads,2);
  assert.match((await useBrowser({operation:"read",tabId:tab.id})).text,/Ready 2/);
  await assert.rejects(useBrowser({operation:"tabs"},()=>{throw Error("lease disabled");}),/lease disabled/);
  console.log("PASS: real browser tab discovery, DOM paging, selection, labeled controls, and reload after the new document is complete.");
}finally{
  if(oldPort===undefined)delete process.env.DEVSPACE_BROWSER_CDP_PORT;
  else process.env.DEVSPACE_BROWSER_CDP_PORT=oldPort;
  child.kill();
  await Promise.race([closed,delay(2000)]);
  page.closeAllConnections();
  await new Promise(resolve=>page.close(resolve));
  try{rmSync(profile,{recursive:true,force:true,maxRetries:8,retryDelay:150});}catch{}
}
