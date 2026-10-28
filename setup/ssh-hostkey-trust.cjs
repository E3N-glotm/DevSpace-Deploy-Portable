"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const crypto = require("node:crypto");

// SSH host keys are identities, not SSH login credentials. A changed identity
// must never be silently accepted just because the user entered a new password.
// All trust writes are scoped to the Portable installation, not ~/.ssh.
function createSshHostKeyTrust({
  root, restrictAcl = () => {}, homeDir = os.homedir(),
  execute = cp.spawnSync, filesystem = fs,
} = {}) {
  const knownHosts = path.join(root, "data", "ssh", "known_hosts");
  const sshRoot = path.join(root, "runtime", "git", "usr", "bin");
  const scanner = path.join(sshRoot, "ssh-keyscan.exe");
  const keygen = path.join(sshRoot, "ssh-keygen.exe");

  function ensure() {
    filesystem.mkdirSync(path.dirname(knownHosts), {recursive:true});
    if (!filesystem.existsSync(knownHosts)) {
      const original = path.join(homeDir, ".ssh", "known_hosts");
      // Preserve all existing OpenSSH trust on first use, including hashed
      // hostnames. Subsequent changes only affect this application-local copy.
      if (filesystem.existsSync(original)) filesystem.copyFileSync(original, knownHosts, filesystem.constants.COPYFILE_EXCL);
      else filesystem.writeFileSync(knownHosts, "", {flag:"wx", mode:0o600});
      restrictAcl(knownHosts);
    }
    return knownHosts;
  }
  const hostLabel = (host,port) => {
    const bare = String(host).replace(/^\[|\]$/g,"");
    return Number(port)===22 ? bare : `[${bare}]:${port}`;
  };
  function keysFrom(output) {
    const keys = [];
    for (const line of String(output||"").split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if(parts.length<3 || !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+)$/.test(parts[1])
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[2]))continue;
      const bytes = Buffer.from(parts[2], "base64");
      if(bytes.length<40 || bytes.length>16384)continue;
      const fingerprint = "SHA256:"+crypto.createHash("sha256").update(bytes).digest("base64").replace(/=+$/,"");
      keys.push({type:parts[1],key:parts[2],fingerprint});
    }
    const unique = new Map(keys.map(k=>[k.type+"|"+k.key,k]));
    return [...unique.values()].sort((a,b)=>a.type.localeCompare(b.type)||a.key.localeCompare(b.key));
  }
  function scan(profile) {
    const host=String(profile.host||"").replace(/^\[|\]$/g,"");
    const port=Number(profile.port);
    if(!host || !/^[A-Za-z0-9._:-]+$/.test(host)
      || !Number.isInteger(port)||port<1||port>65535)throw new Error("Invalid SSH host endpoint.");
    if(!filesystem.existsSync(scanner))throw new Error("Bundled SSH host-key scanner is missing.");
    const run=execute(scanner,["-T","8","-p",String(port),"-t","rsa,ecdsa,ed25519",host],
      {timeout:20000,windowsHide:true,encoding:"utf8",maxBuffer:128*1024});
    if(run.error)throw new Error("Cannot scan SSH host keys.");
    const keys=keysFrom(run.stdout);
    if(!keys.length)throw new Error("Cannot retrieve a trusted SSH host-key candidate.");
    const id=crypto.createHash("sha256").update(JSON.stringify({host,port,keys:keys.map(k=>[k.type,k.key])})).digest("hex");
    return {host,port,keys,id};
  }
  function lookup(host,port) {
    const file=ensure();
    if(!filesystem.existsSync(keygen))throw new Error("Bundled SSH key utility is missing.");
    const run=execute(keygen,["-F",hostLabel(host,port),"-f",file],
      {timeout:10000,windowsHide:true,encoding:"utf8",maxBuffer:128*1024});
    return keysFrom(run.stdout);
  }
  function inspect(profile) {
    const current=scan(profile);
    const trusted=lookup(current.host,current.port);
    const set=new Set(trusted.map(k=>k.type+"|"+k.key));
    const matched=current.keys.some(k=>set.has(k.type+"|"+k.key));
    return {
      host:current.host,port:current.port,scanId:current.id,
      state:matched?"trusted":trusted.length?"changed":"new",
      fingerprints:current.keys.map(k=>({type:k.type,fingerprint:k.fingerprint})),
      previouslyTrusted:trusted.map(k=>({type:k.type,fingerprint:k.fingerprint})),
    };
  }
  function approve(profile, scanId, confirmed) {
    if(confirmed!==true || !/^[a-f0-9]{64}$/.test(String(scanId||"")))
      throw new Error("Explicit SSH host-key fingerprint approval is required.");
    const preview=scan(profile);
    if(preview.id!==scanId)throw new Error("SSH host keys changed during review; inspect again.");
    const file=ensure();
    // ssh-keygen -R understands hashed known_hosts entries, including entries
    // copied from the pre-existing user file. Do not modify the user file.
    const run=execute(keygen,["-R",hostLabel(preview.host,preview.port),"-f",file],
      {timeout:10000,windowsHide:true,encoding:"utf8",maxBuffer:128*1024});
    if(run.error || (run.status!==0 && run.status!==1))
      throw new Error("Could not update Portable SSH host trust.");
    const label=hostLabel(preview.host,preview.port);
    filesystem.appendFileSync(file,preview.keys.map(k=>`${label} ${k.type} ${k.key}\n`).join(""),"utf8");
    restrictAcl(file);
    const current=lookup(preview.host,preview.port);
    if(!preview.keys.some(k=>current.some(c=>c.type===k.type&&c.key===k.key)))
      throw new Error("SSH host-key trust verification failed.");
    return {ok:true,state:"trusted",host:preview.host,port:preview.port,
      fingerprints:preview.keys.map(k=>({type:k.type,fingerprint:k.fingerprint}))};
  }
  return {ensure,inspect,approve,lookup,scan,hostLabel,keysFrom};
}

module.exports={createSshHostKeyTrust};
