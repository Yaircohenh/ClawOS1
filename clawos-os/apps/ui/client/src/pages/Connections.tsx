import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { kernelApi, type SkillKey } from "../api/kernel";

const PROVIDERS = [
  {
    id: "anthropic", name: "Anthropic", icon: "🧠", desc: "Claude AI models",
    fields: [{ key: "api_key", label: "API Key", placeholder: "sk-ant-…" }],
  },
  {
    id: "xai", name: "xAI (Grok)", icon: "⚡", desc: "Grok language models",
    fields: [{ key: "api_key", label: "API Key", placeholder: "xai-…" }],
  },
  {
    id: "openai", name: "OpenAI", icon: "🤖", desc: "GPT models",
    fields: [{ key: "api_key", label: "API Key", placeholder: "sk-…" }],
  },
  {
    id: "brave", name: "Brave Search", icon: "🦁", desc: "Web search API",
    fields: [{ key: "api_key", label: "API Key", placeholder: "BSA…" }],
  },
  {
    id: "smtp", name: "SMTP / Email", icon: "📧", desc: "Send emails",
    fields: [
      { key: "host",     label: "Host",     placeholder: "smtp.gmail.com" },
      { key: "port",     label: "Port",     placeholder: "587" },
      { key: "user",     label: "Username", placeholder: "you@example.com" },
      { key: "password", label: "Password", placeholder: "••••••••" },
    ],
  },
];

const STATUS_COLORS: Record<string, string> = {
  connected: "badge-ok",
  error:     "badge-danger",
  unknown:   "badge-neutral",
  missing:   "badge-neutral",
};

function SkillKeysSection() {
  const qc = useQueryClient();
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [feedback, setFeedback]   = useState<Record<string, { ok: boolean; msg: string }>>({});

  const { data, isLoading } = useQuery({
    queryKey: ["skill-keys"],
    queryFn: kernelApi.clawhub.getSkillKeys,
    refetchInterval: 15_000,
  });

  const updateMut = useMutation({
    mutationFn: ({ envVar, value }: { envVar: string; value: string }) =>
      kernelApi.clawhub.updateSkillKey(envVar, value),
    onSuccess: (_, { envVar }) => {
      setFeedback((f) => ({ ...f, [envVar]: { ok: true, msg: "Saved!" } }));
      void qc.invalidateQueries({ queryKey: ["skill-keys"] });
      setTimeout(() => setFeedback((f) => { const n = { ...f }; delete n[envVar]; return n; }), 2500);
    },
    onError: (err, { envVar }) => {
      setFeedback((f) => ({ ...f, [envVar]: { ok: false, msg: (err).message } }));
    },
  });

  const deleteMut = useMutation({
    mutationFn: (envVar: string) => kernelApi.clawhub.deleteSkillKey(envVar),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["skill-keys"] }),
  });

  const keys: SkillKey[] = data?.keys ?? [];

  if (!isLoading && keys.length === 0) {return null;}

  return (
    <div style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 14, fontWeight: 700, color: "var(--text-strong)", marginBottom: 4 }}>
        Skill API Keys
      </h2>
      <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 20 }}>
        API keys required by your installed skills. Keys are encrypted at rest.
      </p>

      {isLoading && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 88, borderRadius: "var(--r-md)" }} />
          ))}
        </div>
      )}

      <div className="grid-2">
        {keys.map((k) => {
          const fb = feedback[k.envVar];
          return (
            <div key={k.envVar} className="provider-card">
              <div className="provider-header">
                <span className="provider-icon">🔑</span>
                <div>
                  <div className="row" style={{ gap: 8 }}>
                    <div className="provider-name" style={{ fontFamily: "var(--mono)", fontSize: 13 }}>{k.envVar}</div>
                    <span className={`badge ${k.configured ? "badge-ok" : "badge-neutral"}`}>
                      {k.configured ? "configured" : "missing"}
                    </span>
                  </div>
                  <div className="provider-desc">{k.label}</div>
                  {k.requiredBy.length > 0 && (
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                      Used by: {k.requiredBy.join(", ")}
                    </div>
                  )}
                </div>
              </div>

              <div className="stack">
                <div className="field">
                  <label className="label">
                    {k.configured ? `Current: ${k.maskedValue ?? "••••••••"}` : "API Key"}
                  </label>
                  <input
                    className="input"
                    type="password"
                    placeholder="Paste new key to update…"
                    value={keyInputs[k.envVar] ?? ""}
                    onChange={(e) => setKeyInputs((p) => ({ ...p, [k.envVar]: e.target.value }))}
                  />
                </div>
              </div>

              {fb && (
                <div className={`callout callout-${fb.ok ? "ok" : "danger"}`} style={{ fontSize: 12 }}>
                  {fb.msg}
                </div>
              )}

              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!keyInputs[k.envVar]?.trim() || updateMut.isPending}
                  onClick={() => updateMut.mutate({ envVar: k.envVar, value: keyInputs[k.envVar] })}
                >
                  Save
                </button>
                {k.url && (
                  <a href={k.url} target="_blank" rel="noopener noreferrer" className="btn btn-sm" style={{ fontSize: 11 }}>
                    Get key →
                  </a>
                )}
                {k.configured && (
                  <button
                    className="btn btn-danger btn-sm"
                    disabled={deleteMut.isPending}
                    onClick={() => deleteMut.mutate(k.envVar)}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Connections() {
  const qc = useQueryClient();
  const [forms, setForms] = useState<Record<string, Record<string, string>>>({});
  const [feedback, setFeedback] = useState<Record<string, { ok: boolean; msg: string }>>({});

  const { data } = useQuery({
    queryKey: ["connections"],
    queryFn: kernelApi.listConnections,
    refetchInterval: 15_000,
  });

  const statusMap = Object.fromEntries(
    (data?.connections ?? []).map((c) => [c.provider, c])
  );

  const saveMut = useMutation({
    mutationFn: ({ provider, fields }: { provider: string; fields: Record<string, string> }) =>
      kernelApi.saveConnection(provider, fields),
    onSuccess: (_, { provider }) => {
      setFeedback((f) => ({ ...f, [provider]: { ok: true, msg: "Saved!" } }));
      void qc.invalidateQueries({ queryKey: ["connections"] });
      setTimeout(() => setFeedback((f) => { const n = { ...f }; delete n[provider]; return n; }), 2500);
    },
    onError: (err, { provider }) => {
      setFeedback((f) => ({ ...f, [provider]: { ok: false, msg: (err).message } }));
    },
  });

  const testMut = useMutation({
    mutationFn: kernelApi.testConnection,
    onSuccess: (res, provider) => {
      const ok = (res as { ok: boolean }).ok;
      setFeedback((f) => ({ ...f, [provider]: { ok, msg: ok ? "Connection OK ✓" : "Test failed" } }));
      void qc.invalidateQueries({ queryKey: ["connections"] });
      setTimeout(() => setFeedback((f) => { const n = { ...f }; delete n[provider]; return n; }), 3000);
    },
    onError: (err, provider) => {
      setFeedback((f) => ({ ...f, [provider]: { ok: false, msg: (err).message } }));
    },
  });

  const deleteMut = useMutation({
    mutationFn: kernelApi.deleteConnection,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connections"] }),
  });

  const setField = (provider: string, key: string, value: string) => {
    setForms((f) => ({ ...f, [provider]: { ...f[provider], [key]: value } }));
  };

  return (
    <div className="animate-rise">
      <div className="page-header">
        <h1 className="page-title">Connections</h1>
        <p className="page-subtitle">Manage API keys and external service credentials</p>
      </div>

      <div className="grid-2" style={{ marginBottom: 0 }}>
        {PROVIDERS.map((p) => {
          const conn = statusMap[p.id];
          const status = conn?.status ?? "missing";
          const fb = feedback[p.id];

          return (
            <div key={p.id} className="provider-card">
              <div className="provider-header">
                <span className="provider-icon">{p.icon}</span>
                <div>
                  <div className="row" style={{ gap: 8 }}>
                    <div className="provider-name">{p.name}</div>
                    <span className={`badge ${STATUS_COLORS[status]}`}>{status}</span>
                  </div>
                  <div className="provider-desc">{p.desc}</div>
                </div>
              </div>

              <div className="stack">
                {p.fields.map((f) => (
                  <div key={f.key} className="field">
                    <label className="label">{f.label}</label>
                    <input
                      className="input"
                      type={f.key.includes("password") || f.key === "api_key" ? "password" : "text"}
                      placeholder={f.placeholder}
                      value={forms[p.id]?.[f.key] ?? ""}
                      onChange={(e) => setField(p.id, f.key, e.target.value)}
                    />
                  </div>
                ))}
              </div>

              {fb && (
                <div className={`callout callout-${fb.ok ? "ok" : "danger"}`} style={{ fontSize: 12 }}>
                  {fb.msg}
                </div>
              )}

              <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={saveMut.isPending}
                  onClick={() => saveMut.mutate({ provider: p.id, fields: forms[p.id] ?? {} })}
                >
                  Save
                </button>
                {status === "connected" && (
                  <button
                    className="btn btn-sm"
                    disabled={testMut.isPending}
                    onClick={() => testMut.mutate(p.id)}
                  >
                    Test
                  </button>
                )}
                {status !== "missing" && (
                  <button
                    className="btn btn-danger btn-sm"
                    disabled={deleteMut.isPending}
                    onClick={() => deleteMut.mutate(p.id)}
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <SkillKeysSection />
    </div>
  );
}
