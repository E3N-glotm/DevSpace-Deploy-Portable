"use strict";
const net=require("node:net");
const fs=require("node:fs");
const path=require("node:path");

function privateIpv4(host) {
  if(net.isIP(host)!==4)return false;
  const a=host.split(".").map(Number);
  return a[0]===10||(a[0]===172&&a[1]>=16&&a[1]<=31)
    ||(a[0]===192&&a[1]===168);
}
function validateAgentUrl(value,mode) {
  const raw=String(value||"").trim();
  let url;
  try{url=new URL(raw);}catch{throw new Error("Agent connection URL must be absolute.");}
  if(url.username||url.password||url.search||url.hash||url.pathname!=="/")
    throw new Error("Agent connection URL must be an origin only, without credentials, paths or query.");
  if(mode==="lan"){
    if(url.protocol!=="http:"||!privateIpv4(url.hostname)||!url.port)
      throw new Error("LAN Agent URL must be http://private-IPv4:port.");
  }else if(mode==="internet"){
    if(url.protocol!=="https:"||!url.hostname)
      throw new Error("Internet Agent URL must be a valid HTTPS origin.");
  }else throw new Error("Agent connection mode must be internet or lan.");
  return url.origin;
}
function validateLanSettings(settings) {
  const enabled=settings?.enabled===true;
  const port=Number(settings?.port??7677);
  const bindHost=String(settings?.bindHost||"0.0.0.0").trim();
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error("LAN Agent gateway port must be 1024-65535.");
  if(bindHost!=="0.0.0.0"&&!privateIpv4(bindHost))throw new Error("LAN Agent bind host must be 0.0.0.0 or a local private IPv4 address.");
  return {formatVersion:1,enabled,port,bindHost};
}
function agentNetworkPath(root){return path.join(process.env.DEVSPACE_PORTABLE_CONFIG_DIR||path.join(root,"data","config"),"agent-network.json");}
function readAgentNetwork(root) {
  try {return validateLanSettings(JSON.parse(fs.readFileSync(agentNetworkPath(root),"utf8")));}
  catch(error){if(error.code==="ENOENT")return validateLanSettings({});throw error;}
}
module.exports={privateIpv4,validateAgentUrl,validateLanSettings,agentNetworkPath,readAgentNetwork};
