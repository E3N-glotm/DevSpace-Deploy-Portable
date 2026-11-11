import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';

const require=createRequire(import.meta.url);
const {createModelDpapiVault}=require('./model-dpapi-vault.cjs');

test('Windows CurrentUser DPAPI ciphertext decrypts in a separate Node MCP process',
  {skip:process.platform!=='win32'},()=>{
    const vault=createModelDpapiVault();
    const dummy='DEVSPACE_DPAPI_TEST_'+randomUUID();
    const encrypted=vault.encryptString(dummy);
    assert.ok(encrypted.length>dummy.length);
    assert.ok(!encrypted.includes(dummy));
    assert.equal(vault.decryptString(encrypted),dummy);
    const code=[
      "const {createHash}=require('node:crypto');",
      "const {createModelDpapiVault}=require('./setup/model-dpapi-vault.cjs');",
      "let data='';process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',chunk=>data+=chunk);",
      "process.stdin.on('end',()=>{const plain=createModelDpapiVault().decryptString(data);",
      "process.stdout.write(createHash('sha256').update(plain).digest('hex'));});",
    ].join('');
    const result=spawnSync(process.execPath,['-e',code],{
      cwd:resolve(import.meta.dirname,'..'),input:encrypted,encoding:'utf8',
      timeout:15000,windowsHide:true,maxBuffer:1024,
    });
    assert.equal(result.status,0,'DPAPI decryption must work across processes');
    assert.equal(result.stdout,createHash('sha256').update(dummy).digest('hex'));
    assert.throws(()=>vault.decryptString('AAAA'),/MODEL_VAULT_/);
  });
