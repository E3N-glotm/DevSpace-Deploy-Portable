import { useEffect, useState } from "react";
import { HashRouter, NavLink, Route, Routes } from "react-router-dom";
import {
  apiGetJson,
  closeLease,
  getLeaseStatus,
  openLease,
  startLeaseHeartbeat,
  type ConfigInfo,
  type LeaseStatus,
} from "./api";
import Dashboard from "./pages/Dashboard";
import Configuration from "./pages/Configuration";
import Plugins from "./pages/Plugins";
import Sessions from "./pages/Sessions";
import Memories from "./pages/Memories";
import Logs from "./pages/Logs";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/configuration", label: "配置" },
  { to: "/plugins", label: "插件" },
  { to: "/sessions", label: "会话审阅" },
  { to: "/memories", label: "Memories" },
  { to: "/logs", label: "日志" },
];

export default function App() {
  const [lease, setLease] = useState<LeaseStatus | null>(null);
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let stopHeartbeat: (() => void) | null = null;
    (async () => {
      try {
        // 1. 检查当前 lease 状态
        const status = await getLeaseStatus();
        if (!status.active) {
          // 2. 无活跃 lease，打开新的
          const opened = await openLease();
          setLease(opened);
        } else {
          setLease(status);
        }
        // 3. 启动心跳
        stopHeartbeat = startLeaseHeartbeat();
        // 4. 加载配置
        const cfg = await apiGetJson<ConfigInfo>("/api/config");
        setConfig(cfg);
      } catch (err) {
        setBootError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      if (stopHeartbeat) stopHeartbeat();
      closeLease();
    };
  }, []);

  return (
    <HashRouter>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">DS</div>
            <div className="brand-text">
              <div className="brand-title">DevSpace Portable</div>
              <div className="brand-sub">
                {config ? `v${config.portableVersion}` : "加载中…"}
              </div>
            </div>
          </div>
          <nav className="nav">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  "nav-item" + (isActive ? " nav-item-active" : "")
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-footer">
            <div className={`lease-badge ${lease?.active ? "lease-active" : "lease-inactive"}`}>
              <span className="lease-dot" />
              {lease?.active ? "UI 租约活跃" : lease?.reason || "无租约"}
            </div>
          </div>
        </aside>
        <main className="main">
          {bootError ? (
            <div className="boot-error">
              <h2>启动失败</h2>
              <pre>{bootError}</pre>
              <p>请确认 console-server 已启动（node setup/console-server.cjs）。</p>
            </div>
          ) : (
            <Routes>
              <Route path="/" element={<Dashboard config={config} lease={lease} />} />
              <Route path="/configuration" element={<Configuration config={config} onConfigChange={setConfig} />} />
              <Route path="/plugins" element={<Plugins />} />
              <Route path="/sessions" element={<Sessions />} />
              <Route path="/memories" element={<Memories />} />
              <Route path="/logs" element={<Logs />} />
            </Routes>
          )}
        </main>
      </div>
    </HashRouter>
  );
}
