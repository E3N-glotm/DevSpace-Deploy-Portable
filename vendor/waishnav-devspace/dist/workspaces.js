import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, opendir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { createManagedWorktree } from "./git-worktrees.js";
import { AccessDeniedError, assertAllowedPath, expandHomePath, isPathInsideRoot, resolveAllowedPath } from "./roots.js";
import { loadWorkspaceSkills, markSkillActivated, resolveSkillReadPath, } from "./skills.js";
import { loadLocalAgentProfiles, } from "./local-agent-profiles.js";
const MAX_CACHED_WORKSPACES = 64;
const MAX_CONTEXT_SCAN_ENTRIES = 25_000;
const MAX_CONTEXT_SCAN_DIRECTORIES = 2_048;
const MAX_CONTEXT_SCAN_DEPTH = 16;
const MAX_CONTEXT_SCAN_MS = 2_000;
export class WorkspaceRegistry {
    config;
    store;
    remoteAgents;
    workspaces = new Map();
    pendingCheckoutOpens = new Map();
    constructor(config, store, remoteAgents) {
        this.config = config;
        this.store = store;
        this.remoteAgents = remoteAgents;
    }
    async openWorkspace(input, openOptions = {}) {
        const options = typeof input === "string" ? { path: input } : input;
        const conversationScopeId = openOptions.conversationScopeId;
        if (!conversationScopeId || !this.store) {
            return this.openNewWorkspace(options);
        }
        const mode = options.mode ?? "checkout";
        if (mode === "worktree") {
            const remote = parseRemoteWorkspaceUri(options.path);
            const context = remote
                ? await this.openRemoteWorkspace(remote, mode, options.baseRef)
                : await this.openWorktreeWorkspace(options.path, options.baseRef);
            return { ...context, workspaceReused: false, includeBootstrapContext: true };
        }
        const projectKey = await this.conversationProjectKey(options);
        const targetKey = this.conversationCheckoutTargetKey(projectKey);
        const operationKey = JSON.stringify([conversationScopeId, targetKey]);
        const pending = this.pendingCheckoutOpens.get(operationKey);
        if (pending) {
            const context = await pending;
            return { ...context, workspaceReused: true, includeBootstrapContext: false };
        }
        const open = this.openConversationCheckout(options, conversationScopeId, targetKey);
        this.pendingCheckoutOpens.set(operationKey, open);
        try {
            return await open;
        }
        finally {
            if (this.pendingCheckoutOpens.get(operationKey) === open)
                this.pendingCheckoutOpens.delete(operationKey);
        }
    }
    async openNewWorkspace(options) {
        const remote = parseRemoteWorkspaceUri(options.path);
        if (remote)
            return this.openRemoteWorkspace(remote, options.mode ?? "checkout", options.baseRef);
        const mode = options.mode ?? "checkout";
        if (mode === "worktree")
            return this.openWorktreeWorkspace(options.path, options.baseRef);
        return this.openCheckoutWorkspace(options.path);
    }
    async openConversationCheckout(input, conversationScopeId, targetKey) {
        const binding = this.store?.getConversationBinding(conversationScopeId, targetKey);
        if (binding) {
            const reusableWorkspace = await this.findReusableCheckoutWorkspace(binding);
            if (reusableWorkspace) {
                const context = await this.reusedWorkspaceContext(reusableWorkspace);
                this.store?.touchConversationBinding(conversationScopeId, targetKey);
                return { ...context, workspaceReused: true, includeBootstrapContext: false };
            }
            this.workspaces.delete(binding.workspaceSessionId);
            this.store?.deleteConversationBinding(conversationScopeId, targetKey);
        }
        const remote = parseRemoteWorkspaceUri(input.path);
        const context = remote
            ? await this.openRemoteWorkspace(remote, "checkout")
            : await this.openCheckoutWorkspace(input.path);
        this.store?.setConversationBinding({ conversationScopeId, targetKey, workspaceSessionId: context.workspace.id });
        return { ...context, workspaceReused: false, includeBootstrapContext: true };
    }
    async findReusableCheckoutWorkspace(binding) {
        const session = this.store?.getSession(binding.workspaceSessionId);
        if (!session || session.status !== "active" || session.mode !== "checkout")
            return undefined;
        if (session.backend === "remote-agent") {
            try {
                const agent = this.remoteAgents?.resolveAgent(session.backendId, true);
                if (!agent)
                    return undefined;
                const inspected = await this.remoteAgents.inspectWorkspace(agent.id, session.root, { mode: "checkout" });
                const workspace = this.getWorkspace(binding.workspaceSessionId);
                if (workspace.backend !== "remote-agent" || workspace.backendId !== agent.id || workspace.root !== inspected.root)
                    return undefined;
                workspace.git = inspected.git ?? workspace.git;
                workspace.title = inspected.title ?? workspace.title;
                return workspace;
            }
            catch {
                return undefined;
            }
        }
        let root;
        try {
            root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
            const rootStats = await stat(root);
            if (!rootStats.isDirectory())
                return undefined;
        }
        catch (error) {
            if (error instanceof AccessDeniedError ||
                (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")))
                return undefined;
            throw error;
        }
        const workspace = this.getWorkspace(binding.workspaceSessionId);
        if (workspace.mode !== "checkout" || workspace.root !== root)
            return undefined;
        return workspace;
    }
    async conversationProjectKey(input) {
        const remote = parseRemoteWorkspaceUri(input.path);
        if (remote) {
            const agent = this.remoteAgents?.resolveAgent(remote.agent, true);
            if (!agent)
                throw new Error(`Remote workspace agent is unavailable: ${remote.agent}`);
            return `remote-agent:${agent.id}:${normalizeRemoteAbsolutePath(remote.path)}`;
        }
        const candidate = this.config.permissions.allowExternalPaths
            ? resolve(expandHomePath(input.path))
            : assertAllowedPath(input.path, this.config.allowedRoots);
        return canonicalPath(candidate);
    }
    conversationCheckoutTargetKey(projectKey) {
        return JSON.stringify(["checkout", projectKey, null]);
    }
    async reusedWorkspaceContext(workspace) {
        if (workspace.backend === "remote-agent") {
            const inspected = await this.remoteAgents.inspectWorkspace(workspace.backendId, workspace.root, { mode: workspace.mode });
            workspace.git = inspected.git ?? workspace.git;
            workspace.title = inspected.title ?? workspace.title;
            return {
                workspace,
                agentsFiles: normalizeRemoteContextFiles(inspected.agentsFiles),
                availableAgentsFiles: normalizeRemoteAvailableFiles(inspected.availableAgentsFiles),
                workspaceReused: true,
                includeBootstrapContext: false,
            };
        }
        workspace.agentProfiles = await loadLocalAgentProfiles(this.config, workspace.root);
        const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
        const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);
        return { workspace, agentsFiles, availableAgentsFiles, workspaceReused: true, includeBootstrapContext: false };
    }
    getWorkspace(workspaceId) {
        const workspace = this.workspaces.get(workspaceId);
        if (workspace) {
            this.store?.touchSession(workspaceId);
            return workspace;
        }
        const session = this.store?.getSession(workspaceId);
        if (!session) {
            throw new Error(`Unknown workspaceId: ${workspaceId}. Open the target project or worktree again and continue with the new workspaceId.`);
        }
        const isRemote = session.backend === "remote-agent";
        const root = isRemote
            ? normalizeRemoteAbsolutePath(session.root)
            : this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
        if (isRemote)
            this.remoteAgents?.resolveAgent(session.backendId, true);
        const restoredWorkspace = {
            id: session.id,
            root,
            backend: session.backend ?? "local",
            backendId: session.backendId,
            mode: session.mode,
            sourceRoot: session.sourceRoot,
            title: session.title ?? basename(root),
            git: {
                sha: session.gitSha,
                branch: session.gitBranch,
                originUrl: session.gitOriginUrl,
            },
            worktree: session.mode === "worktree"
                ? {
                    path: root,
                    baseRef: session.baseRef ?? "HEAD",
                    baseSha: session.baseSha ?? "",
                    dirtySource: false,
                    detached: true,
                    managed: session.managed,
                }
                : undefined,
            ...(isRemote ? { skills: [], skillDiagnostics: [] } : this.loadSkillsForWorkspace(root)),
            agentProfiles: [],
            activatedSkillDirs: new Set(),
        };
        this.store?.touchSession(workspaceId);
        this.cacheWorkspace(restoredWorkspace);
        return restoredWorkspace;
    }
    listSessions(input = {}) {
        return this.store?.listSessions(input) ?? [];
    }
    archiveSession(workspaceId) {
        const session = this.store?.archiveSession(workspaceId);
        this.workspaces.delete(workspaceId);
        return session;
    }
    async resumeWorkspace(workspaceId) {
        const session = this.store?.getSession(workspaceId);
        if (!session)
            throw new Error(`Unknown workspace session: ${workspaceId}`);
        this.store?.activateSession(workspaceId);
        const isRemote = session.backend === "remote-agent";
        let root;
        let git;
        let remoteContext;
        if (isRemote) {
            const agent = this.remoteAgents?.resolveAgent(session.backendId, true);
            if (!agent)
                throw new Error(`Remote agent is unavailable for workspace ${workspaceId}.`);
            remoteContext = await this.remoteAgents.inspectWorkspace(agent.id, session.root, { mode: "checkout" });
            root = remoteContext.root;
            git = remoteContext.git ?? {};
        }
        else {
            root = this.assertWorkspaceRootAllowed(session.root, session.mode, session.sourceRoot);
            git = inspectGitMetadata(root);
        }
        const workspace = {
            id: session.id,
            root,
            backend: session.backend ?? "local",
            backendId: session.backendId,
            mode: session.mode,
            sourceRoot: session.sourceRoot,
            title: session.title ?? basename(root),
            git,
            worktree: session.mode === "worktree"
                ? {
                    path: root,
                    baseRef: session.baseRef ?? "HEAD",
                    baseSha: session.baseSha ?? "",
                    dirtySource: false,
                    detached: true,
                    managed: session.managed,
                }
                : undefined,
            ...(isRemote ? { skills: [], skillDiagnostics: [] } : this.loadSkillsForWorkspace(root)),
            agentProfiles: isRemote ? [] : await loadLocalAgentProfiles(this.config, root),
            activatedSkillDirs: new Set(),
        };
        this.store?.touchSession(workspaceId, {
            title: workspace.title,
            gitSha: git.sha,
            gitBranch: git.branch,
            gitOriginUrl: git.originUrl,
        });
        this.cacheWorkspace(workspace);
        const agentsFiles = isRemote
            ? normalizeRemoteContextFiles(remoteContext?.agentsFiles)
            : await this.loadInitialAgentsFiles(workspace.root);
        const availableAgentsFiles = isRemote
            ? normalizeRemoteAvailableFiles(remoteContext?.availableAgentsFiles)
            : await this.findAvailableAgentsFiles(workspace.root, agentsFiles);
        return { workspace, agentsFiles, availableAgentsFiles };
    }
    resolvePath(workspace, inputPath) {
        if (workspace.backend === "remote-agent")
            return resolveRemoteWorkspacePath(workspace.root, inputPath);
        if (this.config.permissions.allowExternalPaths) {
            return resolve(workspace.root, expandHomePath(inputPath));
        }
        const absolutePath = resolveAllowedPath(inputPath, workspace.root, [workspace.root]);
        if (!isPathInsideRoot(absolutePath, workspace.root)) {
            throw new Error(`Path is outside workspace root: ${inputPath}`);
        }
        return absolutePath;
    }
    resolveReadPath(workspace, inputPath) {
        if (workspace.backend === "remote-agent") {
            return {
                absolutePath: this.resolvePath(workspace, inputPath),
                readRoots: [workspace.root],
                remote: true,
            };
        }
        try {
            return {
                absolutePath: this.resolvePath(workspace, inputPath),
                readRoots: [workspace.root],
            };
        }
        catch (workspaceError) {
            const skillRead = resolveSkillReadPath(workspace.skills, workspace.activatedSkillDirs, inputPath);
            if (!skillRead)
                throw workspaceError;
            return {
                absolutePath: skillRead.absolutePath,
                readRoots: [workspace.root, skillRead.skill.baseDir],
                skillRead,
            };
        }
    }
    markReadPathLoaded(workspace, readPath) {
        if (readPath.skillRead?.isSkillFile) {
            markSkillActivated(workspace.activatedSkillDirs, readPath.skillRead.skill);
        }
    }
    resolveWorkingDirectory(workspace, workingDirectory) {
        if (workspace.backend === "remote-agent")
            return workingDirectory ? this.resolvePath(workspace, workingDirectory) : workspace.root;
        if (this.config.permissions.allowExternalPaths) {
            return workingDirectory
                ? resolve(workspace.root, expandHomePath(workingDirectory))
                : workspace.root;
        }
        const directory = workingDirectory ? this.resolvePath(workspace, workingDirectory) : workspace.root;
        return assertAllowedPath(directory, [workspace.root]);
    }
    async openCheckoutWorkspace(path) {
        const root = this.config.permissions.allowExternalPaths
            ? resolve(expandHomePath(path))
            : assertAllowedPath(path, this.config.allowedRoots);
        const rootStats = await ensureCheckoutWorkspaceRoot(root);
        if (!rootStats.isDirectory()) {
            throw new Error(`Workspace root must be a directory: ${path}`);
        }
        return this.createWorkspaceContext({ root, mode: "checkout" });
    }
    async openRemoteWorkspace(remote, mode, baseRef) {
        if (!this.remoteAgents)
            throw new Error("Remote Workspace Backend is unavailable in this DevSpace runtime.");
        const context = await this.remoteAgents.inspectWorkspace(remote.agent, remote.path, { mode, baseRef });
        return this.createRemoteWorkspaceContext(context, mode, baseRef);
    }
    async openWorktreeWorkspace(path, baseRef) {
        const worktree = await createManagedWorktree({
            sourcePath: path,
            baseRef,
            config: this.config,
        });
        return this.createWorkspaceContext({
            root: worktree.path,
            mode: "worktree",
            sourceRoot: worktree.sourceRoot,
            worktree,
        });
    }
    async createWorkspaceContext(input) {
        const git = inspectGitMetadata(input.root);
        const workspace = {
            id: `ws_${randomBytes(5).toString("hex")}`,
            root: input.root,
            backend: "local",
            backendId: undefined,
            mode: input.mode,
            sourceRoot: input.sourceRoot,
            title: basename(input.root),
            git,
            worktree: input.worktree,
            ...this.loadSkillsForWorkspace(input.root),
            agentProfiles: await loadLocalAgentProfiles(this.config, input.root),
            activatedSkillDirs: new Set(),
        };
        this.store?.createSession({
            id: workspace.id,
            root: workspace.root,
            mode: workspace.mode,
            sourceRoot: workspace.sourceRoot,
            baseRef: workspace.worktree?.baseRef,
            baseSha: workspace.worktree?.baseSha,
            managed: workspace.worktree?.managed,
            title: workspace.title,
            gitSha: git.sha,
            gitBranch: git.branch,
            gitOriginUrl: git.originUrl,
            backend: workspace.backend,
            backendId: workspace.backendId,
        });
        this.cacheWorkspace(workspace);
        const agentsFiles = await this.loadInitialAgentsFiles(workspace.root);
        const availableAgentsFiles = await this.findAvailableAgentsFiles(workspace.root, agentsFiles);
        return { workspace, agentsFiles, availableAgentsFiles, workspaceReused: false, includeBootstrapContext: true };
    }
    async createRemoteWorkspaceContext(input, mode, baseRef) {
        const workspace = {
            id: `ws_${randomBytes(5).toString("hex")}`,
            root: normalizeRemoteAbsolutePath(input.root),
            backend: "remote-agent",
            backendId: input.agent.id,
            mode,
            sourceRoot: input.sourceRoot ? normalizeRemoteAbsolutePath(input.sourceRoot) : undefined,
            title: input.title ?? posix.basename(input.root) ?? input.agent.name,
            git: input.git ?? {},
            worktree: input.worktree
                ? { ...input.worktree, baseRef: input.worktree.baseRef ?? baseRef ?? "HEAD" }
                : undefined,
            skills: [],
            skillDiagnostics: [],
            agentProfiles: [],
            activatedSkillDirs: new Set(),
        };
        this.store?.createSession({
            id: workspace.id,
            root: workspace.root,
            backend: workspace.backend,
            backendId: workspace.backendId,
            mode: workspace.mode,
            sourceRoot: workspace.sourceRoot,
            baseRef: workspace.worktree?.baseRef,
            baseSha: workspace.worktree?.baseSha,
            managed: workspace.worktree?.managed,
            title: workspace.title,
            gitSha: workspace.git?.sha,
            gitBranch: workspace.git?.branch,
            gitOriginUrl: workspace.git?.originUrl,
        });
        this.cacheWorkspace(workspace);
        return {
            workspace,
            agentsFiles: normalizeRemoteContextFiles(input.agentsFiles),
            availableAgentsFiles: normalizeRemoteAvailableFiles(input.availableAgentsFiles),
            workspaceReused: false,
            includeBootstrapContext: true,
        };
    }
    loadSkillsForWorkspace(root) {
        const result = loadWorkspaceSkills(this.config, root);
        return {
            skills: result.skills,
            skillDiagnostics: result.diagnostics,
        };
    }
    cacheWorkspace(workspace) {
        // Persisted workspace sessions remain authoritative. This Map is only a
        // hot cache, so evicting an old entry is safe: getWorkspace() restores
        // it from WorkspaceStore on demand.
        this.workspaces.delete(workspace.id);
        this.workspaces.set(workspace.id, workspace);
        while (this.workspaces.size > MAX_CACHED_WORKSPACES) {
            const oldestId = this.workspaces.keys().next().value;
            if (!oldestId)
                break;
            this.workspaces.delete(oldestId);
        }
    }
    assertWorkspaceRootAllowed(root, mode, sourceRoot) {
        if (this.config.permissions.allowExternalPaths) {
            return resolve(expandHomePath(root));
        }
        if (mode === "worktree") {
            if (!sourceRoot) {
                throw new Error(`Stored worktree workspace is missing sourceRoot: ${root}`);
            }
            assertAllowedPath(sourceRoot, this.config.allowedRoots);
            return assertAllowedPath(root, [this.config.worktreeRoot]);
        }
        return assertAllowedPath(root, this.config.allowedRoots);
    }
    async loadInitialAgentsFiles(root) {
        const agentDir = resolve(this.config.agentDir);
        const resolvedRoot = (await tryRealpath(root)) ?? root;
        const resolvedAgentDir = (await tryRealpath(agentDir)) ?? agentDir;
        const loadedFiles = [];
        for (const file of loadProjectContextFiles({ cwd: root, agentDir })) {
            const path = resolve(file.path);
            if (!isInitialAgentsFilePath(path, root, agentDir))
                continue;
            const content = await readResolvedContextFile(path, file.content, resolvedRoot, resolvedAgentDir);
            if (content === undefined)
                continue;
            loadedFiles.push({
                path,
                content,
            });
        }
        return loadedFiles;
    }
    async findAvailableAgentsFiles(root, loadedFiles) {
        const loadedPaths = new Set(loadedFiles.map((file) => resolve(file.path)));
        const loadedRealPaths = new Set();
        for (const file of loadedFiles) {
            const realPath = await tryRealpath(file.path);
            if (realPath)
                loadedRealPaths.add(realPath);
        }
        const discovered = [];
        const scanBudget = {
            entries: 0,
            directories: 0,
            deadline: Date.now() + MAX_CONTEXT_SCAN_MS,
            truncated: false,
        };
        await walkWorkspace(root, async (path, entry) => {
            if (!entry.isFile())
                return;
            if (!CONTEXT_FILE_NAMES.has(entry.name))
                return;
            if (loadedPaths.has(path))
                return;
            const realPath = await tryRealpath(path);
            if (realPath && loadedRealPaths.has(realPath))
                return;
            discovered.push({ path });
        }, scanBudget, 0);
        return discovered.sort((a, b) => a.path.localeCompare(b.path));
    }
}

export function isRemoteWorkspace(workspace) {
    return workspace?.backend === "remote-agent" && Boolean(workspace?.backendId);
}

export function parseRemoteWorkspaceUri(value) {
    const text = String(value ?? "").trim();
    if (!/^devspace:\/\//i.test(text))
        return undefined;
    let parsed;
    try {
        parsed = new URL(text);
    }
    catch {
        throw new Error(`Invalid remote workspace URI: ${text}`);
    }
    const agent = decodeURIComponent(parsed.hostname || "").trim();
    if (!agent)
        throw new Error("Remote workspace URI must include an agent id or name, for example devspace://gpu-01/home/ubuntu/workspace/project.");
    const path = normalizeRemoteAbsolutePath(decodeURIComponent(parsed.pathname || "/"));
    return { agent, path };
}

export function normalizeRemoteAbsolutePath(value) {
    const text = String(value ?? "").replace(/\\/g, "/");
    if (!text.startsWith("/"))
        throw new Error(`Remote Linux path must be absolute: ${value}`);
    const normalized = posix.normalize(text);
    if (!normalized.startsWith("/"))
        throw new Error(`Remote Linux path must be absolute: ${value}`);
    return normalized;
}

export function resolveRemoteWorkspacePath(root, inputPath) {
    const normalizedRoot = normalizeRemoteAbsolutePath(root);
    const input = String(inputPath ?? "").replace(/\\/g, "/");
    const candidate = input.startsWith("/")
        ? normalizeRemoteAbsolutePath(input)
        : normalizeRemoteAbsolutePath(posix.join(normalizedRoot, input || "."));
    const relationship = posix.relative(normalizedRoot, candidate);
    if (relationship === ".." || relationship.startsWith("../") || posix.isAbsolute(relationship))
        throw new Error(`Path is outside remote workspace root: ${inputPath}`);
    return candidate;
}

function normalizeRemoteContextFiles(value) {
    return (Array.isArray(value) ? value : [])
        .filter((item) => item && typeof item.path === "string")
        .map((item) => ({ path: normalizeRemoteAbsolutePath(item.path), content: String(item.content ?? "") }));
}

function normalizeRemoteAvailableFiles(value) {
    return (Array.isArray(value) ? value : [])
        .filter((item) => item && typeof item.path === "string")
        .map((item) => ({ path: normalizeRemoteAbsolutePath(item.path) }));
}

async function canonicalPath(path) {
    const missingSegments = [];
    let candidate = path;
    while (true) {
        try {
            return resolve(await realpath(candidate), ...missingSegments.slice().reverse());
        }
        catch (error) {
            if (!isErrnoException(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR"))
                throw error;
            const parent = dirname(candidate);
            if (parent === candidate)
                return path;
            missingSegments.push(basename(candidate));
            candidate = parent;
        }
    }
}

function inspectGitMetadata(root) {
    const invoke = (args) => {
        const result = spawnSync("git", ["-C", root, ...args], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 5000,
        });
        return result.status === 0 ? (result.stdout ?? "").trim() : undefined;
    };
    const sha = invoke(["rev-parse", "HEAD"]);
    if (!sha)
        return { sha: undefined, branch: undefined, originUrl: undefined };
    return {
        sha,
        branch: invoke(["branch", "--show-current"]) || "DETACHED",
        originUrl: invoke(["remote", "get-url", "origin"]),
    };
}
export async function ensureCheckoutWorkspaceRoot(path, ops = { stat, mkdir }) {
    try {
        return await ops.stat(path);
    }
    catch (error) {
        if (!isErrnoException(error) || error.code !== "ENOENT") {
            throw error;
        }
    }
    await ops.mkdir(path, { recursive: true });
    return await ops.stat(path);
}
const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const SKIPPED_CONTEXT_DIRS = new Set([
    ".git",
    ".hg",
    ".svn",
    ".devspace",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
]);
export function formatAgentsPath(path, workspaceRoot) {
    if (!workspaceRoot)
        return path.split(sep).join("/");
    if (String(workspaceRoot).startsWith("/") && String(path).startsWith("/")) {
        const relationship = posix.relative(workspaceRoot, path);
        if (relationship === "" || relationship === ".." || relationship.startsWith("../"))
            return String(path).replace(/\\/g, "/");
        return relationship;
    }
    const relationship = relative(workspaceRoot, path);
    if (relationship === "" ||
        relationship.startsWith("..") ||
        relationship === ".." ||
        relationship.includes(`..${sep}`)) {
        return path.split(sep).join("/");
    }
    return relationship.split(sep).join("/");
}
function isInitialAgentsFilePath(path, root, agentDir) {
    if (isPathInsideRoot(path, agentDir))
        return true;
    return isPathInsideRoot(path, root) && dirname(path) === root;
}
async function readResolvedContextFile(path, fallbackContent, root, agentDir) {
    try {
        const resolvedPath = await realpath(path);
        if (!isInitialAgentsFilePath(resolvedPath, root, agentDir))
            return undefined;
        return await readFile(resolvedPath, "utf8");
    }
    catch {
        return fallbackContent;
    }
}
async function tryRealpath(path) {
    try {
        return await realpath(path);
    }
    catch {
        return undefined;
    }
}
async function walkWorkspace(directory, visit, budget, depth) {
    if (budget && (budget.entries >= MAX_CONTEXT_SCAN_ENTRIES ||
        budget.directories >= MAX_CONTEXT_SCAN_DIRECTORIES ||
        depth > MAX_CONTEXT_SCAN_DEPTH || Date.now() >= budget.deadline)) {
        budget.truncated = true;
        return;
    }
    if (budget)
        budget.directories += 1;
    let entries;
    try {
        entries = await opendir(directory);
    }
    catch {
        return;
    }
    for await (const entry of entries) {
        if (budget) {
            budget.entries += 1;
            if (budget.entries > MAX_CONTEXT_SCAN_ENTRIES || Date.now() >= budget.deadline) {
                budget.truncated = true;
                break;
            }
        }
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            if (!SKIPPED_CONTEXT_DIRS.has(entry.name)) {
                await walkWorkspace(path, visit, budget, depth + 1);
            }
            continue;
        }
        await visit(path, entry);
    }
}
function isErrnoException(error) {
    return error instanceof Error && "code" in error;
}
