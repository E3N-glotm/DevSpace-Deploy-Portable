'use strict';
// User-scoped DPAPI bridge for the standalone MCP Worker process. Electron's
// safeStorage is not available in a plain Node.js service. Never serialize a
// plaintext API key in a config file, command-line argument or environment.
const path=require('node:path');
const childProcess=require('node:child_process');

const MAX_SECRET_BYTES=8192;
const ENTROPY='DevSpacePortable.ModelWorkerCredential.v1';

function createModelDpapiVault({execute=childProcess.spawnSync,
  platform=process.platform,systemRoot=process.env.SystemRoot||'C:\\Windows'}={}){
  const powershell=path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  function invoke(operation,source){
    if(platform!=='win32')throw new Error('MODEL_VAULT_WINDOWS_REQUIRED');
    if(!['protect','unprotect'].includes(operation)||typeof source!=='string'
      ||source.length<4||source.length>MAX_SECRET_BYTES*5
      ||!/^[a-zA-Z0-9+/]+=*$/.test(source))throw new Error('MODEL_VAULT_INVALID_INPUT');
    const script=[
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Security',
      '$value=[Console]::In.ReadToEnd().Trim()',
      '$bytes=[Convert]::FromBase64String($value)',
      `$entropy=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
      operation==='protect'
        ? '$result=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)'
        : '$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Console]::Out.Write([Convert]::ToBase64String($result))',
      '[Array]::Clear($bytes,0,$bytes.Length)',
    ].join(';');
    // The key is provided through stdin, not via argv or environment.
    const result=execute(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy',
      'Bypass','-Command',script],{input:source,encoding:'utf8',
      windowsHide:true,timeout:15000,maxBuffer:MAX_SECRET_BYTES*8});
    if(result.error||result.status!==0)throw new Error('MODEL_VAULT_DPAPI_UNAVAILABLE');
    const value=String(result.stdout||'').trim();
    if(!value||value.length>MAX_SECRET_BYTES*5||!/^[a-zA-Z0-9+/]+=*$/.test(value))
      throw new Error('MODEL_VAULT_INVALID_RESULT');
    return value;
  }
  return {
    encryptString(secret){
      if(typeof secret!=='string'||!secret||Buffer.byteLength(secret,'utf8')>MAX_SECRET_BYTES)
        throw new Error('MODEL_VAULT_INVALID_SECRET');
      const input=Buffer.from(secret,'utf8');
      try{return invoke('protect',input.toString('base64'));}
      finally{input.fill(0);}
    },
    decryptString(protectedBase64){
      const b64=invoke('unprotect',protectedBase64);
      const bytes=Buffer.from(b64,'base64');
      try{
        if(!bytes.length||bytes.length>MAX_SECRET_BYTES)
          throw new Error('MODEL_VAULT_INVALID_RESULT');
        return bytes.toString('utf8');
      }finally{bytes.fill(0);}
    },
  };
}
module.exports={createModelDpapiVault};
