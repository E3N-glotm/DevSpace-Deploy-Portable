import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const localDebugHelp="Enable Chrome remote debugging at chrome://inspect/#remote-debugging and approve the browser prompt, or configure DEVSPACE_BROWSER_CDP_PORT for an existing loopback Chrome/Edge debugging instance. For a focused browser without CDP, reload with F5.";

function validateEndpoint(raw,port){
    const url=new URL(raw);
    if(url.protocol!=="ws:"||!["localhost","127.0.0.1","[::1]"].includes(url.hostname)||
        url.username||url.password||url.port!==String(port)||!/^\/devtools\/browser\/[a-zA-Z0-9_-]+$/.test(url.pathname)||
        url.search||url.hash)throw Error("Invalid local browser debugging endpoint.");
    return "ws://127.0.0.1:"+port+url.pathname;
}

async function endpoint(browser){
    const configured=process.env.DEVSPACE_BROWSER_CDP_PORT;
    if(configured){
        const port=Number(configured);
        if(!Number.isInteger(port)||port<1||port>65535)throw Error("Invalid DEVSPACE_BROWSER_CDP_PORT.");
        const version=await fetch("http://127.0.0.1:"+port+"/json/version",{redirect:"error",signal:AbortSignal.timeout(2500)});
        if(!version.ok)throw Error("Browser debugging HTTP "+version.status+" on loopback.");
        return validateEndpoint((await version.json()).webSocketDebuggerUrl,port);
    }
    if(process.platform==="win32"&&process.env.LOCALAPPDATA){
        const profiles={
            chrome:["Google","Chrome","User Data"],
            edge:["Microsoft","Edge","User Data"],
        };
        for(const name of browser?[browser]:["chrome","edge"]){
            const marker=join(process.env.LOCALAPPDATA,...profiles[name],"DevToolsActivePort");
            let value;
            try{value=await readFile(marker,"utf8");}
            catch(error){if(error.code==="ENOENT")continue;throw error;}
            const [portLine,path]=value.trim().split(/\r?\n/);
            const port=Number(portLine);
            if(Number.isInteger(port)&&port>0&&port<=65535&&path)
                return validateEndpoint("ws://127.0.0.1:"+port+path,port);
        }
    }
    throw Error(localDebugHelp);
}

async function withBrowser(url,run){
    const socket=new WebSocket(url,{handshakeTimeout:5000,maxPayload:2*1024*1024});
    let next=0;
    const pending=new Map();
    const fail=error=>{for(const request of pending.values())request.reject(error);pending.clear();};
    socket.on("error",fail);
    socket.on("close",()=>fail(Error("Browser debugging connection closed.")));
    socket.on("message",raw=>{
        let event;
        try{event=JSON.parse(raw.toString());}catch{return;}
        const request=pending.get(event.id);
        if(!request)return;
        pending.delete(event.id);
        if(event.error)request.reject(Error("Browser protocol error: "+event.error.message));
        else request.resolve(event.result);
    });
    function command(method,params={},sessionId){
        return new Promise((resolve,reject)=>{
            const id=++next;
            const timeout=setTimeout(()=>{
                pending.delete(id);
                reject(Error("Browser did not answer "+method+". "+localDebugHelp));
            },6000);
            pending.set(id,{
                resolve(value){clearTimeout(timeout);resolve(value);},
                reject(error){clearTimeout(timeout);reject(error);},
            });
            try{socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}
            catch(error){pending.get(id)?.reject(error);pending.delete(id);}
        });
    }
    try{
        await new Promise((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);});
        return await run(command);
    }finally{socket.terminate();}
}

function readPage(selector,offset,limit,selection){
    const selected=selector?document.querySelector(selector):null;
    const root=selector?selected:document.querySelector("main,[role=main]")||document.body;
    const content=selection?(window.getSelection()?.toString()??""):(root?.innerText??"");
    const controls=selection?[]:Array.from(root?.querySelectorAll("h1,h2,h3,a[href],button,[role=button]")??[])
        .filter(node=>node.getClientRects().length>0).slice(0,60)
        .map(node=>({tag:node.localName,role:node.getAttribute("role"),label:(node.innerText||node.getAttribute("aria-label")||"").trim().slice(0,180),
            ...(node.localName==="a"&&/^https?:\/\//i.test(node.href)?{href:node.href.slice(0,500)}:{})}));
    return {url:location.href,title:document.title,readyState:document.readyState,
        found:selection||Boolean(root),text:content.slice(offset,offset+limit),totalChars:content.length,
        nextOffset:offset+limit<content.length?offset+limit:null,controls};
}

export async function useBrowser({operation,tabId,browser,selector,offset=0,limit=12000},assertEnabled){
    assertEnabled?.();
    return withBrowser(await endpoint(browser),async command=>{
        const {targetInfos}=await command("Target.getTargets");
        const tabs=targetInfos.filter(x=>x.type==="page"&&/^https?:\/\//i.test(x.url))
            .map(x=>({id:x.targetId,title:x.title.slice(0,300),url:x.url.slice(0,2000)}));
        if(operation==="tabs")return {tabs};
        const tab=tabId?tabs.find(x=>x.id===tabId):tabs.length===1?tabs[0]:undefined;
        if(!tab)throw Error("Select a listed browser tabId. Multiple tabs require an explicit target.");
        const {sessionId}=await command("Target.attachToTarget",{targetId:tab.id,flatten:true});
        async function evaluate(expression){
            const value=await command("Runtime.evaluate",{expression,returnByValue:true},sessionId);
            if(value.exceptionDetails)throw Error("Unable to inspect the page. Check the CSS selector or wait for page navigation.");
            return value.result.value;
        }
        assertEnabled?.();
        if(operation==="reload"){
            const {frameTree:before}=await command("Page.getFrameTree",{},sessionId);
            let refreshed=false,readyState="loading";
            await command("Page.reload",{loaderId:before.frame.loaderId},sessionId);
            const deadline=Date.now()+7000;
            while(Date.now()<deadline){
                await delay(150);
                const {frameTree}=await command("Page.getFrameTree",{},sessionId);
                refreshed=frameTree.frame.loaderId!==before.frame.loaderId;
                if(!refreshed)continue;
                try{readyState=await evaluate("document.readyState");}catch{continue;}
                if(readyState==="complete")break;
            }
            return {tabId:tab.id,reloadRequested:true,newDocument:refreshed,readyState};
        }
        const args=[selector??null,offset,limit,operation==="selection"].map(v=>JSON.stringify(v)).join(",");
        return {tabId:tab.id,...await evaluate("("+readPage.toString()+")("+args+")")};
    });
}
