import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  const host=String(input.bindHost||"0.0.0.0");
  if(!Number.isInteger(port)||port<1024||port>65535
    ||!(/^(?:0\.0\.0\.0|10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(host)))
    throw new Error("Invalid Agent LAN gateway configuration.");
  return {enabled:true,port,host};
}
export async function startAgentLanGateway(config,remoteAgents) {
  const lan=readLanGatewayConfig(config);
  if(!lan.enabled)return null;
  const dir=fileURLToPath(new URL("./linux-agent/",import.meta.url));
  const server=createServer((req,res)=>{
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
  });
  remoteAgents.attachHttpServer(server,{lan:true});
  try {
    await new Promise((resolve,reject)=>{
      server.once("error",reject);
      server.listen(lan.port,lan.host,()=>{server.off("error",reject);resolve();});
    });
    console.log("Agent-only LAN gateway listening on "+lan.host+":"+lan.port);
    return server;
  }catch(error){await new Promise(resolve=>server.close(()=>resolve()));throw error;}
}
