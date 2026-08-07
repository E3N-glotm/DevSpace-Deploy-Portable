import { useEffect, useState } from "react";
import { apiGetJson, apiPostJson, type SessionEntry } from "../api";

interface SessionListResponse {
  sessions?: SessionEntry[];
  [k: string]: unknown;
}

interface SessionDetails {
  session?: SessionEntry;
  files?: Array<{
    path: string;
    status?: string;
    patch?: string;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

export default function Sessions() {
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<SessionDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGetJson<SessionListResponse>("/api/sessions");
      setSessions(data.sessions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const loadDetails = async (id: string) => {
    setSelectedId(id);
    setDetails(null);
    setError(null);
    try {
      const data = await apiPostJson<SessionDetails>("/api/sessions/details", { sessionId: id });
      setDetails(data);
    } catch (err) {
      setError(`加载详情失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const rollback = async (id: string) => {
    if (!confirm(`确认回滚会话 ${id}? 此操作会恢复 tracked paths 到审阅时的状态。`)) return;
    setActionLoading(`rollback:${id}`);
    setError(null);
    try {
      await apiPostJson("/api/sessions/rollback", { sessionId: id });
      await loadDetails(id);
    } catch (err) {
      setError(`回滚失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
    }
  };

  const restoreSafety = async (id: string) => {
    if (!confirm(`确认恢复 ${id} 的安全快照?`)) return;
    setActionLoading(`restore:${id}`);
    setError(null);
    try {
      await apiPostJson("/api/sessions/restore-safety", { sessionId: id });
      await loadDetails(id);
    } catch (err) {
      setError(`恢复失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">会话审阅</h1>
        <p className="page-desc">有界稀疏审阅日志、tracked-path 回滚与安全快照</p>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      <div className="card">
        <h3 className="card-title">会话列表 ({sessions.length})</h3>
        {loading ? (
          <div className="empty-state">
            <span className="loading" /> 加载中…
          </div>
        ) : sessions.length === 0 ? (
          <div className="empty-state">暂无审阅会话</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>工作区</th>
                <th>更新时间</th>
                <th>文件数</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr
                  key={s.id}
                  style={{ cursor: "pointer", background: selectedId === s.id ? "var(--accent-soft)" : undefined }}
                  onClick={() => loadDetails(s.id)}
                >
                  <td style={{ fontSize: 11 }}>{s.id}</td>
                  <td style={{ fontSize: 11 }}>{s.workspaceRoot}</td>
                  <td>{s.updatedAt || "—"}</td>
                  <td>{s.fileCount ?? "—"}</td>
                  <td>
                    <button
                      className="btn btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        loadDetails(s.id);
                      }}
                    >
                      查看
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedId && details && (
        <div className="card">
          <h3 className="card-title">会话详情: {selectedId}</h3>
          <div className="btn-group" style={{ marginBottom: 12 }}>
            <button
              className="btn btn-danger"
              onClick={() => rollback(selectedId)}
              disabled={actionLoading !== null}
            >
              {actionLoading === `rollback:${selectedId}` ? <span className="loading" /> : null}
              回滚 tracked paths
            </button>
            <button
              className="btn"
              onClick={() => restoreSafety(selectedId)}
              disabled={actionLoading !== null}
            >
              {actionLoading === `restore:${selectedId}` ? <span className="loading" /> : null}
              恢复安全快照
            </button>
          </div>

          {details.files && details.files.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>路径</th>
                  <th>状态</th>
                  <th>查看 patch</th>
                </tr>
              </thead>
              <tbody>
                {details.files.map((f, i) => (
                  <tr key={i}>
                    <td style={{ fontSize: 11 }}>{f.path}</td>
                    <td>
                      {f.status && <span className="tag tag-muted">{f.status}</span>}
                    </td>
                    <td>
                      {f.patch ? (
                        <pre style={{ maxHeight: 200 }}>{f.patch}</pre>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">无文件变更记录</div>
          )}
        </div>
      )}
    </div>
  );
}
