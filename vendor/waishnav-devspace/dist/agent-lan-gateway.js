import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// Not a second public MCP listener. Expose Agent WebSocket and static
// installer assets only, on an explicitly enabled LAN interface.
export function readLanGatewayConfig(config) {
  const state=resolve(config.stateDir);
  const base=process.env.DEVSPACE_CONFIG_DIR ||
    process.env.DEVSPACE_PORTABLE_CONFIG_DIR || join(state,"..","config");
  let input;
  try {input=JSON.parse(readFileSync(join(base,"agent-network.json"),"utf8"));}
  catch(error){if(error.code==="ENOENT")return {enabled:false};throw error;}
  if(input.enabled!==true)return {enabled:false};
  const port=Number(input.port);
  const rawHosts=input.bindHosts===undefined
    ?[input.bindHost||"0.0.0.0"]:input.bindHosts;
  if(!Array.isArray(rawHosts)||rawHosts.length<1||rawHosts.length>8)
    throw new Error("Invalid Agent LAN gateway binding list.");
  const hosts=rawHosts.map(value=>typeof value==="string"?value.trim():"");
  const privateIpv4=host=>{
    if(isIP(host)!==4)return false;
    const [a,b]=host.split(".").map(Number);
    return a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168);
  };
  if(!Number.isInteger(port)||port<1024||port>65535
    ||hosts.some(host=>host!=="0.0.0.0"&&!privateIpv4(host))
    ||new Set(hosts).size!==hosts.length
    ||(hosts.length>1&&hosts.includes("0.0.0.0")))
    throw new Error("Invalid Agent LAN gateway configuration.");
  return {enabled:true,port,host:hosts[0],hosts};
}
export async function startAgentLanGateway(config,remoteAgents,{retryMs=5000}={}) {
  const lan=readLanGatewayConfig(config);
  if(!lan.enabled)return null;
  // SSH reverse forwarding is local to this machine. An Agent-only
  // loopback listener lets existing configured tunnels survive NIC changes
  // without binding any newly discovered external address.
  const bindHosts=lan.hosts.includes("0.0.0.0")?lan.hosts:[...lan.hosts,"127.0.0.1"];
  const dir=fileURLToPath(new URL("./linux-agent/",import.meta.url));
  const handleRequest=(req,res)=>{
    const paths=new Map([
      ["/agent/v1/devspace-agent.py",["devspace-agent.py","text/x-python; charset=utf-8"]],
      ["/agent/v1/install.sh",["install.sh","text/x-shellscript; charset=utf-8"]],
    ]);
    const match=paths.get(req.url);
    if(req.method!=="GET"||!match){res.writeHead(404,{"Cache-Control":"no-store"});res.end();return;}
    const data=readFileSync(join(dir,match[0]));
    res.writeHead(200,{"Content-Type":match[1],"Content-Length":data.length,
      "Cache-Control":"no-store","X-Content-SHA256":createHash("sha256").update(data).digest("hex")});
    res.end(data);
  };
  const servers=new Map(), reported=new Map();
  let closed=false, inFlight=null;
  const closeServer=server=>new Promise((resolve,reject)=>{
    if(!server.listening){resolve();return;}
    server.close(error=>error?reject(error):resolve());
  });
  const reconcile=()=>{
    if(closed)return Promise.resolve();
    if(inFlight)return inFlight;
    inFlight=(async()=>{
      for(const host of bindHosts){
        if(closed||servers.has(host))continue;
        const server=createServer(handleRequest);
        try{
          await new Promise((resolve,reject)=>{
            server.once("error",reject);
            server.listen(lan.port,host,()=>{server.off("error",reject);resolve();});
          });
          remoteAgents.attachHttpServer(server,{lan:true});
          server.on("error",error=>console.warn("Agent LAN listener error:",host,error.code||"error"));
          servers.set(host,server);
          reported.delete(host);
          console.log("Agent-only LAN gateway listening on "+host+":"+lan.port);
        }catch(error){
          await closeServer(server).catch(()=>{});
          const reason=error?.code||"error";
          if(reported.get(host)!==reason){
            console.warn("Agent LAN interface unavailable (retrying): "+host+":"+lan.port+" ("+reason+")");
            reported.set(host,reason);
          }
        }
      }
    })().finally(()=>{inFlight=null;});
    return inFlight;
  };
  await reconcile();
  const timer=setInterval(()=>void reconcile().catch(error=>console.warn("Agent LAN reconciliation failed:",error.code||"error")),retryMs);
  timer.unref?.();
  return {
    status:()=>({configured:lan.hosts,active:[...servers.keys()],unavailable:[...reported.keys()]}),
    reconcile,
    close(callback){
      closed=true;clearInterval(timer);
      void Promise.resolve(inFlight).then(()=>Promise.all([...servers.values()].map(closeServer)))
        .then(()=>callback?.(),error=>callback?.(error));
    }
  };
}
