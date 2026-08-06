import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { redactText } from "./redaction.js";

const BASE_BROKER_TIMEOUT_MS = 12_000;
const MAX_BROKER_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 10;

function requestTimeout(payload) {
    const steps = Array.isArray(payload?.steps) ? payload.steps : [payload];
    const requestedDelay = steps.reduce((total, step) => total + Math.max(0, Math.min(3000, Number(step?.delayMs || 0))), 0);
    return Math.min(MAX_BROKER_TIMEOUT_MS, Math.max(BASE_BROKER_TIMEOUT_MS, BASE_BROKER_TIMEOUT_MS + requestedDelay));
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
    const request = {
        formatVersion: 1,
        requestId,
        leaseId,
        createdAt: new Date().toISOString(),
        payload,
    };
    try {
        await writeFile(paths.requestTemporary, JSON.stringify(request, null, 2) + "\n", { mode: 0o600 });
        await rename(paths.requestTemporary, paths.request);
        const deadline = Date.now() + requestTimeout(payload);
        let response;
        while (Date.now() < deadline) {
            response = await readJsonIfPresent(paths.response);
            if (response)
                break;
            await delay(POLL_INTERVAL_MS);
        }
        if (!response) {
            throw new Error("Computer Use broker timed out. Keep the local DevSpace Portable UI open and visible, then retry.");
        }
        if (!response.success) {
            throw new Error(redactText(response.error || "Computer Use broker failed."));
        }
        const image = response.metadata?.screenshot ? await readFile(paths.image) : undefined;
        return {
            metadata: response.metadata ?? {},
            image,
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
    return invokeComputerUse({ action: "snapshot", screenshotAfter: true }, options);
}

export async function performComputerAction(input, options = {}) {
    return invokeComputerUse({ ...input, screenshotAfter: input.screenshotAfter === true }, options);
}
