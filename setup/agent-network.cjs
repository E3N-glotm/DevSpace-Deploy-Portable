"use strict";
const net=require("node:net");
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const dgram=require("node:dgram");

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

function lanControllerAddress(sshHost,interfaces=os.networkInterfaces(),preferred="") {
  // Prefer the interface in the same subnet as the target SSH server, rather
  // than arbitrarily picking the first adapter on a VPN/multi-NIC machine.
  const options=Object.values(interfaces).flat().filter(i=>
    i?.family==="IPv4"&&!i.internal&&privateIpv4(i.address));
  const remote=net.isIP(sshHost)===4?sshHost.split(".").map(Number):null;
  const toInt=ip=>ip.split(".").reduce((v,x)=>((v<<8)|Number(x))>>>0,0);
  const match=remote&&options.filter(i=>net.isIP(i.netmask)===4
    && (toInt(i.address)&toInt(i.netmask))===(toInt(sshHost)&toInt(i.netmask)));
  if(match?.length===1)return match[0].address;
  if(match?.length>1)throw new Error("目标服务器对应多个局域网网卡，请检查 Windows 网络配置。");
  if(privateIpv4(preferred)&&options.some(i=>i.address===preferred))return preferred;
  if(options.length===1)return options[0].address;
  throw new Error("无法自动确定服务器可访问的 Windows 内网 IP；请检查网卡和 VPN 路由。");
}
function localRouteAddress(host,port) {
  return new Promise((resolve,reject)=>{
    // UDP connect only queries the OS routing table; no packet or secret is
    // sent to the remote host. Works with both SSH-over-LAN and VPN routes.
    const socket=dgram.createSocket("udp4");
    let closed=false;
    const done=(error,address)=>{
      if(closed)return;
      closed=true;clearTimeout(timer);socket.removeAllListeners("error");socket.close();
      error?reject(error):resolve(address);
    };
    const timer=setTimeout(()=>done(new Error("Route probe timed out.")),3000);
    socket.once("error",error=>done(error));
    socket.connect(port,host,()=>{
      try{done(null,socket.address().address);}
      catch(error){done(error);}
    });
  });
}
async function resolveLanControllerAddress(host,port=22,interfaces=os.networkInterfaces(),preferred="",probe=localRouteAddress) {
  const choices=Object.values(interfaces).flat().filter(i=>
    i?.family==="IPv4"&&!i.internal&&privateIpv4(i.address)).map(i=>i.address);
  try{
    const address=await probe(host,port);
    if(choices.includes(address))return address;
  }catch{}
  return lanControllerAddress(host,interfaces,preferred);
}
module.exports={privateIpv4,validateAgentUrl,validateLanSettings,agentNetworkPath,readAgentNetwork,lanControllerAddress,resolveLanControllerAddress};
