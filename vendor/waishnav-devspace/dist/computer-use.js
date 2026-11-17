import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { redactText } from "./redaction.js";
import { fitComputerImage } from "./computer-image.js";

const BASE_BROKER_TIMEOUT_MS = 12_000;
const MAX_BROKER_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 10;
const screenshots = new Map();

export function mapScreenshotPoint(screen, {x,y}, coordinateSpace){
    const r=screen.captureRegion;
    const iw=screen.imageWidth,ih=screen.imageHeight;
    if(coordinateSpace==="normalized"){
        if(![x,y].every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw Error("Normalized screenshot coordinates must be between 0 and 1.");
        return {x:r.x+Math.min(r.width-1,Math.floor(x*r.width)),y:r.y+Math.min(r.height-1,Math.floor(y*r.height))};
    }
    if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=iw||y>=ih)
        throw Error("Point is outside the transmitted image; use its imageWidth and imageHeight.");
    return {x:r.x+Math.floor((x+0.5)*r.width/iw),y:r.y+Math.floor((y+0.5)*r.height/ih)};
}

function requestTimeout(payload) {
    const steps = Array.isArray(payload?.steps) ? payload.steps : [payload];
    const requestedDelay = steps.reduce((total, step) => total + Math.max(0, Math.min(3000, Number(step?.delayMs || 0))), 0);
    return Math.min(MAX_BROKER_TIMEOUT_MS, BASE_BROKER_TIMEOUT_MS + requestedDelay + Math.max(0, Number(payload.settleMs)||0));
}

function portableRoot() {
    const configured = process.env.DEVSPACE_PORTABLE_ROOT;
    if (!configured)
        throw new Error("Computer Use broker requires DEVSPACE_PORTABLE_ROOT.");
    return resolve(configured);
}

function portableRunDir() {
    const configured = process.env.DEVSPACE_PORTABLE_RUN_DIR;
    return configured ? resolve(configured) : join(portableRoot(), "data", "run");
}

function brokerPaths(requestId) {
    const root = join(portableRunDir(), "computer-use");
    return {
        root,
        requests: join(root, "requests"),
        responses: join(root, "responses"),
        request: join(root, "requests", `${requestId}.json`),
        requestTemporary: join(root, "requests", `${requestId}.json.tmp-${process.pid}`),
        response: join(root, "responses", `${requestId}.json`),
        image: join(root, "responses", `${requestId}.png`),
    };
}

async function delay(milliseconds) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function readJsonIfPresent(file) {
    try {
        return JSON.parse(await readFile(file, "utf8"));
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return undefined;
        throw error;
    }
}

async function invokeComputerUse(payload, options = {}) {
    if (process.platform !== "win32")
        throw new Error("Computer Use is currently supported only on Windows.");
    const leaseId = String(options.leaseId ?? "").trim();
    if (!leaseId)
        throw new Error("Computer Use requires the active local UI lease id.");
    const requestId = randomUUID();
    const paths = brokerPaths(requestId);
    await mkdir(paths.requests, { recursive: true });
    await mkdir(paths.responses, { recursive: true });
    const deadline = Date.now() + requestTimeout(payload);
    const request = {
        formatVersion: 1,
        requestId,
        leaseId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(deadline).toISOString(),
        payload,
    };
    try {
        await writeFile(paths.requestTemporary, JSON.stringify(request, null, 2) + "\n", { mode: 0o600 });
        await rename(paths.requestTemporary, paths.request);
        let response;
        while (Date.now() < deadline) {
            response = await readJsonIfPresent(paths.response);
            if (response)
                break;
            await delay(POLL_INTERVAL_MS);
        }
        if (!response) {
            throw new Error(payload.action === "snapshot"
                ? "Computer Use broker timed out. Keep the local DevSpace Portable UI open and visible, then request a new snapshot."
                : "Computer Use broker timed out. Some input may already have executed. Request a new snapshot before retrying any input.");
        }
        if (!response.success) {
            throw new Error(redactText(response.error || "Computer Use broker failed."));
        }
        let metadata = response.metadata ?? {};
        let image, mimeType;
        if (metadata.screenshot) {
            try {
                ({image,mimeType,metadata}=await fitComputerImage(paths.image,await readFile(paths.image),metadata,options.region));
                metadata={...metadata,snapshotId:requestId};
                screenshots.set(requestId,{scope:options.workspaceId,leaseId,metadata});
                while(screenshots.size>32)screenshots.delete(screenshots.keys().next().value);
            } catch (error) {
                // Input may already have succeeded. Never make a transport error
                // look like a failed input action that should be blindly replayed.
                metadata={...metadata,screenshot:false,screenshotError:redactText(String(error?.message??error)).slice(0,500),recovery:"Request a new screenshot with a smaller region; do not repeat the preceding action."};
            }
        }
        return {
            metadata,
            image,
            mimeType,
            stderr: redactText(String(response.stderr ?? "")),
        };
    }
    finally {
        await rm(paths.requestTemporary, { force: true });
        await rm(paths.request, { force: true });
        await rm(paths.response, { force: true });
        await rm(paths.image, { force: true });
    }
}

export async function captureDesktop(options = {}) {
    return invokeComputerUse({ action: "snapshot", screenshotAfter: true, settleMs: options.settleMs }, options);
}

export async function performComputerAction(input, options = {}) {
    const {snapshotId,coordinateSpace=snapshotId?"image":"desktop",...payload}=input;
    if(coordinateSpace!=="desktop"&&!snapshotId)throw Error("Image or normalized coordinates require the snapshotId returned with the image.");
    if(snapshotId){
        const entry=screenshots.get(snapshotId);
        if(!entry||entry.leaseId!==options.leaseId||entry.scope!==options.workspaceId)
            throw Error("Screenshot is no longer available in this workspace and Computer Use session. Take a fresh snapshot.");
        const screen=entry.metadata;
        payload.expectedDesktop={left:screen.left??0,top:screen.top??0,width:screen.width,height:screen.height};
        const map=step=>{
            if(coordinateSpace==="desktop"||step.x===undefined&&step.y===undefined)return step;
            return {...step,...mapScreenshotPoint(screen,step,coordinateSpace)};
        };
        if(Array.isArray(payload.steps))payload.steps=payload.steps.map(map);
        else Object.assign(payload,map(payload));
    }
    return invokeComputerUse({ ...payload, screenshotAfter: input.screenshotAfter === true }, options);
}
