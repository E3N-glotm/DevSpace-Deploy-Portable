import { useState } from "react";
import { apiGetJson, apiPostJson, type ConfigInfo } from "../api";

interface ConfigurationProps {
  config: ConfigInfo | null;
  onConfigChange: (cfg: ConfigInfo) => void;
}

interface ConfigureInput {
  tunnelProvider?: "ngrok" | "cloudflare";
  toolMode?: "minimal" | "full" | "codex";
  permissionProfile?: "workspace" | "full-access" | "custom";
  allowedRoots?: string[];
  publicBaseUrl?: string;
  port?: number;
  ngrokToken?: string;
  cloudflareToken?: string;
  ngrokProxyUrl?: string;
  ownerToken?: string;
  features?: {
    computerUse?: boolean;
    memories?: boolean;
    hooks?: boolean;
    uiSessionReview?: boolean;
  };
}

export default function Configuration({ config, onConfigChange }: ConfigurationProps) {
  const [form, setForm] = useState<ConfigureInput>({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const update = (patch: Partial<ConfigureInput>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      await apiPostJson("/api/configure", form);
      const fresh = await apiGetJson<ConfigInfo>("/api/config");
      onConfigChange(fresh);
      setResult("配置已保存");
      setForm({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!config) {
    return <div className="empty-state">配置加载中…</div>;
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">配置</h1>
        <p className="page-desc">隧道、权限、工具模式与功能开关</p>
      </div>

      {result && <div className="notice notice-success">{result}</div>}
      {error && <div className="notice notice-error">{error}</div>}

      <div className="card">
        <h3 className="card-title">当前配置</h3>
        <div className="card-row">
          <span className="card-row-label">配置目录</span>
          <span className="card-row-value">{config.configDir}</span>
        </div>
        <div className="card-row">
          <span className="card-row-label">状态目录</span>
          <span className="card-row-value">{config.stateDir}</span>
        </div>
        <div className="card-row">
          <span className="card-row-label">插件根目录</span>
          <span className="card-row-value">{config.pluginRoot}</span>
        </div>
        <div className="card-row">
          <span className="card-row-label">Owner Token</span>
          <span className="card-row-value">
            <span className={config.hasOwnerToken ? "tag tag-success" : "tag tag-warning"}>
              {config.hasOwnerToken ? "已设置" : "未设置"}
            </span>
          </span>
        </div>
        <div className="card-row">
          <span className="card-row-label">ngrok Token</span>
          <span className="card-row-value">
            <span className={config.hasNgrokToken ? "tag tag-success" : "tag tag-muted"}>
              {config.hasNgrokToken ? "已设置" : "未设置"}
            </span>
          </span>
        </div>
        <div className="card-row">
          <span className="card-row-label">Cloudflare Token</span>
          <span className="card-row-value">
            <span className={config.hasCloudflareToken ? "tag tag-success" : "tag tag-muted"}>
              {config.hasCloudflareToken ? "已设置" : "未设置"}
            </span>
          </span>
        </div>
        <div className="card-row">
          <span className="card-row-label">cloudflared</span>
          <span className="card-row-value">
            <span className={config.cloudflaredInstalled ? "tag tag-success" : "tag tag-warning"}>
              {config.cloudflaredInstalled ? `已安装 ${config.cloudflaredVersion}` : "未安装"}
            </span>
          </span>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">修改配置</h3>

        <div className="field">
          <label className="field-label">隧道提供商</label>
          <select
            value={form.tunnelProvider ?? config.tunnelProvider}
            onChange={(e) => update({ tunnelProvider: e.target.value as "ngrok" | "cloudflare" })}
          >
            <option value="ngrok">ngrok</option>
            <option value="cloudflare">cloudflare</option>
          </select>
        </div>

        <div className="field">
          <label className="field-label">工具模式</label>
          <select
            value={form.toolMode ?? config.toolMode}
            onChange={(e) => update({ toolMode: e.target.value as "minimal" | "full" | "codex" })}
          >
            <option value="minimal">minimal</option>
            <option value="full">full</option>
            <option value="codex">codex (实验)</option>
          </select>
        </div>

        <div className="field">
          <label className="field-label">权限档位</label>
          <select
            value={form.permissionProfile ?? config.permissions.profile}
            onChange={(e) =>
              update({ permissionProfile: e.target.value as "workspace" | "full-access" | "custom" })
            }
          >
            <option value="workspace">workspace（受限）</option>
            <option value="full-access">full-access（当前用户全权）</option>
            <option value="custom">custom（自定义）</option>
          </select>
        </div>

        <div className="field">
          <label className="field-label">允许的工作区根（逗号分隔）</label>
          <input
            type="text"
            placeholder={config.allowedRoots.join(", ") || "(未设置)"}
            onChange={(e) =>
              update({
                allowedRoots: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
          <div className="field-hint">留空则不修改；输入新值会覆盖现有列表</div>
        </div>

        <div className="field">
          <label className="field-label">监听端口</label>
          <input
            type="number"
            placeholder={String(config.port)}
            onChange={(e) => update({ port: e.target.value ? parseInt(e.target.value, 10) : undefined })}
          />
        </div>

        <div className="field">
          <label className="field-label">Owner Token（≥16 字符）</label>
          <input
            type="password"
            placeholder={config.hasOwnerToken ? "(已设置，留空不修改)" : "请输入"}
            onChange={(e) => update({ ownerToken: e.target.value || undefined })}
          />
        </div>

        <div className="field">
          <label className="field-label">ngrok Token</label>
          <input
            type="password"
            placeholder={config.hasNgrokToken ? "(已设置，留空不修改)" : "请输入"}
            onChange={(e) => update({ ngrokToken: e.target.value || undefined })}
          />
        </div>

        <div className="field">
          <label className="field-label">Cloudflare Token</label>
          <input
            type="password"
            placeholder={config.hasCloudflareToken ? "(已设置，留空不修改)" : "请输入"}
            onChange={(e) => update({ cloudflareToken: e.target.value || undefined })}
          />
        </div>

        <div className="field">
          <label className="field-label">功能开关</label>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 4 }}>
            <label>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                defaultChecked={config.features.computerUse}
                onChange={(e) =>
                  update({ features: { ...form.features, computerUse: e.target.checked } })
                }
              />{" "}
              Computer Use
            </label>
            <label>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                defaultChecked={config.features.memories}
                onChange={(e) =>
                  update({ features: { ...form.features, memories: e.target.checked } })
                }
              />{" "}
              Memories
            </label>
            <label>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                defaultChecked={config.features.hooks}
                onChange={(e) => update({ features: { ...form.features, hooks: e.target.checked } })}
              />{" "}
              Hooks
            </label>
            <label>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                defaultChecked={config.features.uiSessionReview}
                onChange={(e) =>
                  update({
                    features: { ...form.features, uiSessionReview: e.target.checked },
                  })
                }
              />{" "}
              会话审阅
            </label>
          </div>
        </div>

        <div className="btn-group">
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <span className="loading" /> : null}
            保存配置
          </button>
        </div>
      </div>
    </div>
  );
}
