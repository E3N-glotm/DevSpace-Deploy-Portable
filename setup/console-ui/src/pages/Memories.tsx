import { useEffect, useState } from "react";
import { apiGetJson, apiPostJson, type MemoryEntry } from "../api";

interface MemoryListResponse {
  memories?: MemoryEntry[];
  [k: string]: unknown;
}

export default function Memories() {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id?: string; content: string; scope: "global" | "workspace"; key?: string } | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGetJson<MemoryListResponse>("/api/memories");
      setMemories(data.memories || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const upsert = async () => {
    if (!editing || !editing.content.trim()) return;
    setActionLoading("upsert");
    setError(null);
    try {
      await apiPostJson("/api/memories/upsert", {
        id: editing.id,
        scope: editing.scope,
        key: editing.key,
        content: editing.content,
      });
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
    }
  };

  const remove = async (id: string) => {
    if (!confirm(`确认删除 Memory ${id}?`)) return;
    setActionLoading(`delete:${id}`);
    setError(null);
    try {
      await apiPostJson("/api/memories/delete", { id });
      await refresh();
    } catch (err) {
      setError(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
    }
  };

  const startEdit = (m?: MemoryEntry) => {
    setEditing({
      id: m?.id,
      content: m?.content || "",
      scope: m?.scope || "workspace",
      key: m?.key,
    });
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">显式 Memories</h1>
        <p className="page-desc">全局与工作区范围的持久化记忆，含凭据检测</p>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      <div className="card">
        <h3 className="card-title">操作</h3>
        <button className="btn btn-primary" onClick={() => startEdit()}>
          新建 Memory
        </button>
      </div>

      {editing && (
        <div className="card">
          <h3 className="card-title">{editing.id ? "编辑 Memory" : "新建 Memory"}</h3>
          <div className="field">
            <label className="field-label">范围</label>
            <select
              value={editing.scope}
              onChange={(e) => setEditing({ ...editing, scope: e.target.value as "global" | "workspace" })}
            >
              <option value="workspace">workspace（当前工作区）</option>
              <option value="global">global（全局）</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label">Key（可选）</label>
            <input
              type="text"
              value={editing.key || ""}
              onChange={(e) => setEditing({ ...editing, key: e.target.value })}
              placeholder="便于检索的标识"
            />
          </div>
          <div className="field">
            <label className="field-label">内容</label>
            <textarea
              value={editing.content}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              placeholder="Memory 内容（敏感凭据会被自动检测并拒绝）"
              rows={6}
            />
          </div>
          <div className="btn-group">
            <button className="btn btn-primary" onClick={upsert} disabled={actionLoading !== null}>
              {actionLoading === "upsert" ? <span className="loading" /> : null}
              保存
            </button>
            <button className="btn" onClick={() => setEditing(null)} disabled={actionLoading !== null}>
              取消
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h3 className="card-title">Memory 列表 ({memories.length})</h3>
        {loading ? (
          <div className="empty-state">
            <span className="loading" /> 加载中…
          </div>
        ) : memories.length === 0 ? (
          <div className="empty-state">暂无 Memory</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>范围</th>
                <th>Key</th>
                <th>内容预览</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {memories.map((m) => (
                <tr key={m.id}>
                  <td style={{ fontSize: 11 }}>{m.id}</td>
                  <td>
                    <span className={m.scope === "global" ? "tag tag-warning" : "tag tag-muted"}>
                      {m.scope}
                    </span>
                  </td>
                  <td>{m.key || "—"}</td>
                  <td style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.content.slice(0, 80)}
                    {m.content.length > 80 ? "…" : ""}
                  </td>
                  <td style={{ fontSize: 11 }}>{m.updatedAt || "—"}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn btn-sm" onClick={() => startEdit(m)} disabled={actionLoading !== null}>
                        编辑
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => remove(m.id)}
                        disabled={actionLoading !== null}
                      >
                        删除
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
