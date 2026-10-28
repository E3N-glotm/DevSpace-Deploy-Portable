"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const operations=fs.readFileSync(path.join(__dirname,"../src/Operations.tsx"),"utf8");
const main=fs.readFileSync(path.join(__dirname,"../electron/main.cjs"),"utf8");

test("saving a changed SSH password verifies and reconnects an existing offline agent",()=>{
  assert.match(operations,/const sshUpdated=await saveSsh\(\)/);
  assert.match(operations,/if\(offline\)\{[\s\S]*?admin\('remote-ssh-test',\{key\}\)[\s\S]*?admin\('remote-ssh-recover'/);
  assert.match(operations,/else if\(sshUpdated\)\{[\s\S]*?admin\('remote-ssh-test'/);
  assert.match(operations,/writableRoots:full\?\[\]:scopedRoots/);
  assert.doesNotMatch(operations,/writableRoots:originalRoots,/,
    "Recovery must not reuse an obsolete permission path list");
});

test("new SSH fingerprint requires separate owner confirmation before a recovery retry",()=>{
  assert.match(operations,/SSH_HOST_KEY_CHANGED/);
  assert.match(operations,/admin\('remote-ssh-hostkey-inspect'/);
  assert.match(operations,/window\.confirm\(/);
  assert.match(operations,/admin\('remote-ssh-hostkey-approve'/);
  assert.match(main,/remote-ssh-hostkey-inspect/);
  assert.match(main,/remote-ssh-hostkey-approve/);
  assert.match(main,/SSH_HOST_KEY_CHANGED|HOST_KEY_CHANGED/);
  assert.match(main,/DEVSPACE_SSH_SAFE_CODE/);
});

test("revoked Agent identity cannot be silently resurrected by a password save",()=>{
  assert.match(operations,/if\(remoteStatus==='revoked'\)\{/);
  assert.match(operations,/await window\.devspace\.admin\('remote-ssh-test',\{key\}\)/);
  assert.match(operations,/window\.confirm\('当前 Agent 凭据已撤销/);
  assert.match(operations,/admin\('remote-ssh-deploy',\{[\s\S]*?agentId:''/);
  assert.match(operations,/旧身份保持撤销/);
});
