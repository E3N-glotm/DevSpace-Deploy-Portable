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
export async function startAgentLanGateway(config,remoteAgents) {
  const lan=readLanGatewayConfig(config);
  if(!lan.enabled)return null;
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
  const servers=[];
  const closeAll=async()=>{
    await Promise.all(servers.map(server=>new Promise((resolve,reject)=>{
      if(!server.listening){resolve();return;}
      server.close(error=>error?reject(error):resolve());
    })));
  };
  try {
    for(const host of lan.hosts){
      const server=createServer(handleRequest);
      remoteAgents.attachHttpServer(server,{lan:true});
      try{
        await new Promise((resolve,reject)=>{
          server.once("error",reject);
          server.listen(lan.port,host,()=>{server.off("error",reject);resolve();});
        });
      }catch(error){
        // A disconnected secondary NIC must not prevent existing Agent
        // connections on a still-present interface from recovering after
        // a service restart. Never silently ignore port conflicts/ACL errors.
        if(error?.code==="EADDRNOTAVAIL"&&lan.hosts.length>1){
          console.warn("Agent LAN interface unavailable (skipping): "+host+":"+lan.port);
          continue;
        }
        throw error;
      }
      servers.push(server);
      console.log("Agent-only LAN gateway listening on "+host+":"+lan.port);
    }
    if(!servers.length)throw new Error("No configured Agent LAN interface is currently available.");
    // Preserve the historical close(callback) contract for server shutdown
    // and test harnesses while closing every bound socket, not only the first.
    return {close(callback){void closeAll().then(()=>callback?.(),error=>callback?.(error));}};
  }catch(error){await closeAll();throw error;}
}
