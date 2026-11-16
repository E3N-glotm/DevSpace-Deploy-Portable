import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// MCP SSE carries base64 plus JSON. 700 KiB leaves >90 KiB for envelopes
// below a 1 MiB host event ceiling. The capture itself has no such limit.
export const MAX_SCREEN_IMAGE_BYTES = 700 * 1024;
export function screenRegion(metadata, region) {
    const {left=0, top=0, width, height} = metadata;
    if (![left,top,width,height].every(Number.isSafeInteger) || width<=0 || height<=0) throw Error('Invalid capture bounds');
    if (!region) return {x:left,y:top,width,height};
    const {x,y,width:w,height:h}=region;
    if (![x,y,w,h].every(Number.isSafeInteger) || w<=0 || h<=0 || x<left || y<top || x+w>left+width || y+h>top+height) throw Error('Requested screenshot region is outside desktop bounds');
    return {x,y,width:w,height:h};
}
export async function fitComputerImage(inputPath, image, metadata, region, encode = promisify(execFile)) {
    const rect=screenRegion(metadata,region);
    const originalBytes=image.length;
    let mimeType='image/png', width=rect.width, height=rect.height;
    if (region || image.length>MAX_SCREEN_IMAGE_BYTES) {
        const outputPath=inputPath+'.wire';
        try {
            const {stdout}=await encode('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./computer-image.ps1',import.meta.url)),'-InputImage',inputPath,'-OutputImage',outputPath,'-MaxBytes',String(MAX_SCREEN_IMAGE_BYTES),'-X',String(rect.x-(metadata.left??0)),'-Y',String(rect.y-(metadata.top??0)),'-Width',String(rect.width),'-Height',String(rect.height),...(region?['-TryPng']:[])],{windowsHide:true,timeout:15000,maxBuffer:65536});
            const info=JSON.parse(stdout.trim());
            image=await readFile(outputPath);
            ({mimeType,width,height}=info);
            if (!['image/png','image/jpeg'].includes(mimeType)||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0||width>rect.width||height>rect.height) throw Error('Invalid encoded screenshot metadata');
        } finally { await rm(outputPath,{force:true}); }
    }
    if (!image.length||image.length>MAX_SCREEN_IMAGE_BYTES) throw Error('Screenshot exceeds transport budget; request a smaller region.');
    return {image,mimeType,metadata:{...metadata,captureRegion:rect,imageWidth:width,imageHeight:height,scaleX:rect.width/width,scaleY:rect.height/height,originalBytes,transmittedBytes:image.length,mimeType,coordinateSpace:'desktop',coordinateFormula:'desktop x = captureRegion.x + image x * scaleX; desktop y = captureRegion.y + image y * scaleY'}};
}
