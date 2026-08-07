import { useEffect, useState } from "react";
import { apiGetJson, apiGetText, type LogPaths } from "../api";

export default function Logs() {
  const [paths, setPaths] = useState<LogPaths | null>(null);
  const [activeLog, setActiveLog] = useState<"devspace" | "tunnel">("devspace");
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const p = await apiGetJson<LogPaths>("/api/logs");
        setPaths(p);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const loadLog = async (which: "devspace" | "tunnel") => {
    setLoading(true);
    setError(null);
    try {
      const text = await apiGetText(`/api/logs/${which}`);
      setContent(text || "(空)");
    } catch (err) {
      setError(`读取日志失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLog(activeLog);
    if (!autoRefresh) return;
    const timer = setInterval(() => loadLog(activeLog), 5000);
    return () => clearInterval(timer);
  }, [activeLog, autoRefresh]);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">日志</h1>
        <p className="page-desc">DevSpace 与隧道日志末尾 256 KiB，5 秒自动刷新</p>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      {paths && (
        <div className="card">
          <h3 className="card-title">日志路径</h3>
          <div className="card-row">
            <span className="card-row-label">DevSpace 日志</span>
            <span className="card-row-value">{paths.devspace}</span>
          </div>
          <div className="card-row">
            <span className="card-row-label">隧道日志</span>
            <span className="card-row-value">{paths.tunnel}</span>
          </div>
          <div className="card-row">
            <span className="card-row-label">日志目录</span>
            <span className="card-row-value">{paths.directory}</span>
          </div>
        </div>
      )}

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 className="card-title" style={{ margin: 0 }}>
            日志内容
          </h3>
          <div className="btn-group">
            <button
              className={`btn btn-sm ${activeLog === "devspace" ? "btn-primary" : ""}`}
              onClick={() => setActiveLog("devspace")}
            >
              DevSpace
            </button>
            <button
              className={`btn btn-sm ${activeLog === "tunnel" ? "btn-primary" : ""}`}
              onClick={() => setActiveLog("tunnel")}
            >
              隧道
            </button>
            <button
              className={`btn btn-sm ${autoRefresh ? "btn-primary" : ""}`}
              onClick={() => setAutoRefresh(!autoRefresh)}
            >
              {autoRefresh ? "暂停自动刷新" : "开启自动刷新"}
            </button>
            <button className="btn btn-sm" onClick={() => loadLog(activeLog)} disabled={loading}>
              {loading ? <span className="loading" /> : null}
              立即刷新
            </button>
          </div>
        </div>
        <pre style={{ maxHeight: 600 }}>{content}</pre>
      </div>
    </div>
  );
}
