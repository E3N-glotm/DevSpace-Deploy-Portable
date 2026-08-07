import { useEffect, useState } from "react";
import {
  apiGetJson,
  apiGetText,
  apiPostText,
  type ConfigInfo,
  type LeaseStatus,
  type ProcessEntry,
} from "../api";

interface DashboardProps {
  config: ConfigInfo | null;
  lease: LeaseStatus | null;
}

export default function Dashboard({ config, lease }: DashboardProps) {
  const [status, setStatus] = useState<string>("加载中…");
  const [processes, setProcesses] = useState<ProcessEntry[]>([]);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [statusText, procData] = await Promise.all([
        apiGetText("/api/status"),
        apiGetJson<{ processes: ProcessEntry[] }>("/api/processes"),
      ]);
      setStatus(statusText);
      setProcesses(procData.processes || []);
    } catch (err) {
      setStatus(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, []);

  const runAction = async (action: string, label: string) => {
    setActionLoading(action);
    setActionResult(null);
    try {
      const result = await apiPostText(`/api/services/${action}`);
      setActionResult(`${label}: ${result}`);
      await refresh();
    } catch (err) {
      setActionResult(`${label} 失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <p className="page-desc">服务状态、进程概览与生命周期控制</p>
      </div>

      {actionResult && (
        <div className={actionResult.includes("失败") ? "notice notice-error" : "notice notice-success"}>
          {actionResult}
        </div>
      )}

      <div className="card">
        <h3 className="card-title">服务控制</h3>
        <div className="btn-group">
          <button
            className="btn btn-primary"
            onClick={() => runAction("start", "启动")}
            disabled={actionLoading !== null}
          >
            {actionLoading === "start" ? <span className="loading" /> : null}
            启动
          </button>
          <button
            className="btn btn-danger"
            onClick={() => runAction("stop", "停止")}
            disabled={actionLoading !== null}
          >
            {actionLoading === "stop" ? <span className="loading" /> : null}
            停止
          </button>
          <button
            className="btn"
            onClick={() => runAction("restart", "重启")}
            disabled={actionLoading !== null}
          >
            {actionLoading === "restart" ? <span className="loading" /> : null}
            重启
          </button>
          <button
            className="btn"
            onClick={() => runAction("enable", "启用计划任务")}
            disabled={actionLoading !== null}
          >
            启用计划任务
          </button>
          <button
            className="btn"
            onClick={() => runAction("disable", "禁用计划任务")}
            disabled={actionLoading !== null}
          >
            禁用计划任务
          </button>
          <button className="btn" onClick={refresh} disabled={actionLoading !== null}>
            刷新
          </button>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">配置摘要</h3>
        {config ? (
          <div>
            <div className="card-row">
              <span className="card-row-label">已配置</span>
              <span className="card-row-value">
                <span className={config.configured ? "tag tag-success" : "tag tag-warning"}>
                  {config.configured ? "是" : "否"}
                </span>
              </span>
            </div>
            <div className="card-row">
              <span className="card-row-label">隧道提供商</span>
              <span className="card-row-value">{config.tunnelProvider}</span>
            </div>
            <div className="card-row">
              <span className="card-row-label">工具模式</span>
              <span className="card-row-value">{config.toolMode}</span>
            </div>
            <div className="card-row">
              <span className="card-row-label">权限档位</span>
              <span className="card-row-value">{config.permissions.profile}</span>
            </div>
            <div className="card-row">
              <span className="card-row-label">MCP URL</span>
              <span className="card-row-value">{config.mcpUrl || "(未启动)"}</span>
            </div>
            <div className="card-row">
              <span className="card-row-label">公网 Base URL</span>
              <span className="card-row-value">{config.publicBaseUrl || "(未启动)"}</span>
            </div>
            <div className="card-row">
              <span className="card-row-label">Computer Use</span>
              <span className="card-row-value">
                <span className={config.features.computerUse ? "tag tag-success" : "tag tag-muted"}>
                  {config.features.computerUse ? "启用" : "禁用"}
                </span>
              </span>
            </div>
          </div>
        ) : (
          <div className="empty-state">配置加载中…</div>
        )}
      </div>

      <div className="card">
        <h3 className="card-title">状态详情</h3>
        <pre>{status}</pre>
      </div>

      <div className="card">
        <h3 className="card-title">Portable 进程 ({processes.length})</h3>
        {processes.length === 0 ? (
          <div className="empty-state">无归属进程</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>PID</th>
                <th>名称</th>
                <th>父 PID</th>
                <th>可执行路径</th>
              </tr>
            </thead>
            <tbody>
              {processes.map((p) => (
                <tr key={p.pid}>
                  <td>{p.pid}</td>
                  <td>{p.name}</td>
                  <td>{p.parentPid}</td>
                  <td style={{ fontSize: 11, color: "var(--text-muted)" }}>{p.executablePath}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
