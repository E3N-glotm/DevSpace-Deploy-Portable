/**
 * console-server HTTP client。
 *
 * leaseId 管理：
 * - 启动时调 /api/ui/open 获取 leaseId，存 localStorage
 * - 每 60s 心跳（TTL 90s）
 * - 页面卸载时调 /api/ui/close
 * - 写操作自动附加 X-Console-Lease header
 */

const LEASE_KEY = "devspace.console.leaseId";
const LEASE_TTL_MS = 90_000;
const HEARTBEAT_INTERVAL_MS = 60_000;

let cachedLeaseId: string | null = null;

export function getLeaseId(): string | null {
  if (cachedLeaseId) return cachedLeaseId;
  try {
    const stored = localStorage.getItem(LEASE_KEY);
    if (stored) {
      cachedLeaseId = stored;
      return stored;
    }
  } catch {
    // localStorage 不可用（如 WebView2 沙盒），降级为内存
  }
  return null;
}

function setLeaseId(id: string | null) {
  cachedLeaseId = id;
  try {
    if (id) {
      localStorage.setItem(LEASE_KEY, id);
    } else {
      localStorage.removeItem(LEASE_KEY);
    }
  } catch {
    // 忽略
  }
}

export interface LeaseStatus {
  active: boolean;
  reason?: string;
  leaseId?: string;
  expiresAt?: string;
}

export async function openLease(): Promise<LeaseStatus> {
  const res = await fetch("/api/ui/open", { method: "POST" });
  if (!res.ok) {
    throw new Error(`openLease failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  if (data.leaseId) {
    setLeaseId(data.leaseId);
  }
  return data;
}

export async function heartbeatLease(): Promise<LeaseStatus> {
  const leaseId = getLeaseId();
  if (!leaseId) {
    return { active: false, reason: "no-lease" };
  }
  const res = await fetch("/api/ui/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ leaseId }),
  });
  if (!res.ok) {
    if (res.status === 401) {
      // lease 失效，清除本地缓存，尝试重新打开
      setLeaseId(null);
      return openLease();
    }
    throw new Error(`heartbeat failed: ${res.status}`);
  }
  return res.json();
}

export async function closeLease(): Promise<void> {
  const leaseId = getLeaseId();
  if (!leaseId) return;
  try {
    await fetch("/api/ui/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId }),
    });
  } catch {
    // 忽略关闭错误
  }
  setLeaseId(null);
}

export async function getLeaseStatus(): Promise<LeaseStatus> {
  const res = await fetch("/api/ui/lease");
  return res.json();
}

/** 启动 lease 心跳循环，返回停止函数 */
export function startLeaseHeartbeat(): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await heartbeatLease();
    } catch (err) {
      console.warn("[lease] heartbeat error:", err);
    }
  };
  const timer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  // 页面卸载时关闭 lease
  window.addEventListener("beforeunload", () => {
    stopped = true;
    clearInterval(timer);
    closeLease();
  });
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (options.body && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  // 写操作附加 leaseId
  if (options.method && options.method !== "GET") {
    const leaseId = getLeaseId();
    if (leaseId) {
      headers["x-console-lease"] = leaseId;
    }
  }
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && options.method && options.method !== "GET") {
    // lease 失效，尝试重新打开后重试一次
    try {
      await openLease();
      const newLeaseId = getLeaseId();
      if (newLeaseId) {
        headers["x-console-lease"] = newLeaseId;
        return fetch(path, { ...options, headers });
      }
    } catch {
      // 重新打开失败，返回原 401
    }
  }
  return res;
}

export async function apiGetJson<T = unknown>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function apiGetText(path: string): Promise<string> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.text();
}

export async function apiPostJson<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function apiPostText(path: string, body?: unknown): Promise<string> {
  const res = await apiFetch(path, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
  return res.text();
}

// ===== 类型定义 =====

export interface ConfigInfo {
  configured: boolean;
  tunnelProvider: "ngrok" | "cloudflare";
  toolMode: "minimal" | "full" | "codex";
  permissions: {
    profile: "workspace" | "full-access" | "custom";
    allowExternalPaths: boolean;
    allowArbitraryCommands: boolean;
    allowShellMutation: boolean;
    allowNetworkAccess: boolean;
    allowCredentialAccess: boolean;
    allowComputerUse: boolean;
    allowInteractiveProcesses: boolean;
    allowPersistentProcesses: boolean;
  };
  features: {
    computerUse: boolean;
    memories: boolean;
    hooks: boolean;
    uiSessionReview: boolean;
  };
  portableVersion: string;
  protocolVersion: string;
  publicBaseUrl: string;
  port: number;
  allowedRoots: string[];
  hasOwnerToken: boolean;
  hasNgrokToken: boolean;
  hasCloudflareToken: boolean;
  ngrokProxyUrl: string;
  cloudflaredInstalled: boolean;
  cloudflaredVersion: string;
  configDir: string;
  authFile: string;
  stateDir: string;
  pluginRoot: string;
  mcpUrl: string;
}

export interface DriveInfo {
  letter: string;
  label?: string;
  freeBytes?: number;
  totalBytes?: number;
}

export interface PluginEntry {
  id: string;
  name: string;
  version?: string;
  enabled: boolean;
  installed: boolean;
  manifest?: unknown;
  slot?: number | null;
  versions?: string[];
  selectedVersion?: string;
}

export interface PluginListResponse {
  plugins?: PluginEntry[];
  slots?: Array<{ slot: number; pluginId: string | null; version?: string }>;
}

export interface SessionEntry {
  id: string;
  workspaceRoot: string;
  createdAt?: string;
  updatedAt?: string;
  status?: string;
  fileCount?: number;
  [k: string]: unknown;
}

export interface MemoryEntry {
  id: string;
  scope: "global" | "workspace";
  key?: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
  [k: string]: unknown;
}

export interface LogPaths {
  devspace: string;
  tunnel: string;
  directory: string;
}

export interface ProcessEntry {
  pid: number;
  parentPid: number;
  name: string;
  executablePath?: string;
  commandLine?: string;
}
