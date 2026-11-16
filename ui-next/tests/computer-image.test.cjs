const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../reports');
const load=()=>import('../../vendor/waishnav-devspace/dist/computer-image.js');

test('fast path preserves PNG and coordinates; invalid crop rejected',async()=>{
  const {fitComputerImage,screenRegion}=await load();
  const m={left:-1920,top:0,width:4480,height:1440};
  const image=Buffer.alloc(120000,5);
  const v=await fitComputerImage('unused',image,m,undefined,()=>{throw Error('fast path attempted conversion');});
  assert.equal(v.image,image);assert.equal(v.metadata.scaleX,1);assert.equal(v.metadata.captureRegion.x,-1920);
  assert.throws(()=>screenRegion(m,{x:-1921,y:0,width:100,height:100}),/outside/);
});

test('real Windows encoder fits a high-entropy multi-megabyte image and preserves crop coordinates',{skip:process.platform!=='win32'},async()=>{
  const {fitComputerImage,MAX_SCREEN_IMAGE_BYTES}=await load();
  fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'.tmp-computer-image-'));
  try {
    const width=2560,height=1440,stride=width*3;
    const source=Buffer.alloc(54+stride*height);source.write('BM');source.writeUInt32LE(source.length,2);source.writeUInt32LE(54,10);source.writeUInt32LE(40,14);source.writeInt32LE(width,18);source.writeInt32LE(height,22);source.writeUInt16LE(1,26);source.writeUInt16LE(24,28);source.writeUInt32LE(stride*height,34);crypto.randomFillSync(source,54);
    const input=path.join(dir,'large.bmp');fs.writeFileSync(input,source);
    const meta={left:-100,top:-20,width,height};
    for(const region of [undefined,{x:100,y:100,width:320,height:180}]){
      const start=Date.now();const v=await fitComputerImage(input,source,meta,region);
      assert.ok(v.image.length<=MAX_SCREEN_IMAGE_BYTES);
      const wire=JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'observation'},{type:'image',data:v.image.toString('base64'),mimeType:v.mimeType}],structuredContent:{screen:v.metadata}}});
      assert.ok(Buffer.byteLength(wire)<1048576);
      assert.equal(v.metadata.originalBytes,source.length);
      if(region){assert.deepEqual(v.metadata.captureRegion,region);assert.equal(v.metadata.imageWidth,320);assert.equal(v.metadata.imageHeight,180);}
      assert.ok(v.metadata.scaleX>=1&&v.metadata.scaleY>=1);
      if(v.mimeType==='image/jpeg')assert.equal(v.image.readUInt16BE(0),0xffd8);else assert.equal(v.image.subarray(1,4).toString(),'PNG');
      console.log('capture:',source.length,'wire:',Buffer.byteLength(wire),'image:',v.metadata.imageWidth,v.metadata.imageHeight,v.mimeType,'ms:',Date.now()-start);
      assert.equal(fs.existsSync(input+'.wire'),false);
    }
    assert.deepEqual(fs.readFileSync(input),source);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('long computer sessions keep recent image observations and tool transactions',async()=>{
  const {retainRecentComputerImages}=await import('../../vendor/waishnav-devspace/dist/agent-runtime.js');
  const messages=[{role:'system',content:'goal'}];
  for(let i=0;i<10;i++){messages.push({role:'tool',tool_call_id:String(i),content:'state '+i},{role:'user',content:[{type:'text',text:'Screenshot from the preceding action.'},{type:'image_url',image_url:{url:'data:image/png;base64,AAA'}}]});}
  const out=retainRecentComputerImages(messages);assert.equal(out.length,messages.length);assert.equal(out.filter(m=>Array.isArray(m.content)).length,2);assert.deepEqual(out.filter(m=>m.role==='tool'),messages.filter(m=>m.role==='tool'));
});
