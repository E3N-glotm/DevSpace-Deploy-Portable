import { useEffect, useState } from "react";
import { apiGetJson, apiPostJson, type PluginEntry, type PluginListResponse } from "../api";

export default function Plugins() {
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [slots, setSlots] = useState<Array<{ slot: number; pluginId: string | null; version?: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [installPath, setInstallPath] = useState("");

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGetJson<PluginListResponse>("/api/plugins");
      setPlugins(data.plugins || []);
      setSlots(data.slots || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const runPluginAction = async (action: string, pluginId: string, extra?: Record<string, unknown>) => {
    setActionLoading(`${action}:${pluginId}`);
    setError(null);
    try {
      await apiPostJson(`/api/plugins/${action}`, { pluginId, ...(extra || {}) });
      await refresh();
    } catch (err) {
      setError(`${action} ${pluginId} 失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
    }
  };

  const install = async () => {
    if (!installPath.trim()) return;
    setActionLoading("install");
    setError(null);
    try {
      await apiPostJson("/api/plugins/install", { source: installPath.trim() });
      setInstallPath("");
      await refresh();
    } catch (err) {
      setError(`安装失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
    }
  };

  const refreshAll = async () => {
    setActionLoading("refresh");
    setError(null);
    try {
      await apiPostJson("/api/plugins/refresh");
      await refresh();
    } catch (err) {
      setError(`刷新失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">插件</h1>
        <p className="page-desc">本地插件管理：安装、启用、停用、卸载、槽位绑定</p>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      <div className="card">
        <h3 className="card-title">操作</h3>
        <div className="btn-group">
          <button className="btn" onClick={refreshAll} disabled={actionLoading !== null}>
            {actionLoading === "refresh" ? <span className="loading" /> : null}
            刷新插件清单
          </button>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label className="field-label">安装新插件（路径或 ZIP）</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              placeholder="C:\path\to\plugin or plugin.zip"
              value={installPath}
              onChange={(e) => setInstallPath(e.target.value)}
            />
            <button className="btn btn-primary" onClick={install} disabled={actionLoading !== null || !installPath.trim()}>
              {actionLoading === "install" ? <span className="loading" /> : null}
              安装
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">槽位绑定（16 个固定槽）</h3>
        {slots.length === 0 ? (
          <div className="empty-state">暂无槽位数据</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>槽位</th>
                <th>插件 ID</th>
                <th>版本</th>
              </tr>
            </thead>
            <tbody>
              {slots.map((s) => (
                <tr key={s.slot}>
                  <td>#{s.slot}</td>
                  <td>{s.pluginId || "(空)"}</td>
                  <td>{s.version || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 className="card-title">已安装插件 ({plugins.length})</h3>
        {loading ? (
          <div className="empty-state">
            <span className="loading" /> 加载中…
          </div>
        ) : plugins.length === 0 ? (
          <div className="empty-state">暂无已安装插件</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>ID</th>
                <th>版本</th>
                <th>状态</th>
                <th>槽位</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {plugins.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td style={{ fontSize: 11, color: "var(--text-muted)" }}>{p.id}</td>
                  <td>{p.selectedVersion || p.version || "—"}</td>
                  <td>
                    {p.enabled ? (
                      <span className="tag tag-success">已启用</span>
                    ) : (
                      <span className="tag tag-muted">已停用</span>
                    )}
                  </td>
                  <td>{p.slot != null ? `#${p.slot}` : "—"}</td>
                  <td>
                    <div className="row-actions">
                      {p.enabled ? (
                        <button
                          className="btn btn-sm"
                          onClick={() => runPluginAction("disable", p.id)}
                          disabled={actionLoading !== null}
                        >
                          停用
                        </button>
                      ) : (
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => runPluginAction("enable", p.id)}
                          disabled={actionLoading !== null}
                        >
                          启用
                        </button>
                      )}
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => {
                          if (confirm(`确认卸载插件 ${p.name}?`)) {
                            runPluginAction("uninstall", p.id);
                          }
                        }}
                        disabled={actionLoading !== null}
                      >
                        卸载
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
