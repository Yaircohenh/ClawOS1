import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  kernelApi,
  type ClawhubSkill,
  type ClawhubSkillDetailResponse,
  type InstalledSkill,
  type BuildResult,
  type VettingIssue,
} from "../api/kernel";

// ── Tab type ──────────────────────────────────────────────────────────────────
type Tab = "browse" | "installed" | "build";

// ── Helper: vetting issue colour ─────────────────────────────────────────────
function issueClass(level: VettingIssue["level"]) {
  if (level === "critical") {return "badge-danger";}
  if (level === "warning")  {return "badge-warn";}
  return "badge-neutral";
}
function issueIcon(level: VettingIssue["level"]) {
  if (level === "critical") {return "✗";}
  if (level === "warning")  {return "⚠";}
  return "ℹ";
}

// ── Skill card (Browse tab) ───────────────────────────────────────────────────
function SkillCard({
  skill,
  onInstall,
}: {
  skill: ClawhubSkill;
  onInstall: (slug: string) => void;
}) {
  const name    = skill.display_name || skill.name || skill.slug;
  const summary = skill.summary || skill.description || "No description available.";
  const isSuspicious   = skill.moderation?.isSuspicious === true;
  const isMalware      = skill.moderation?.isMalwareBlocked === true;

  return (
    <div className="card card-sm" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="row" style={{ alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text-strong)", fontFamily: "var(--mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {name}
          </div>
          {skill.version && (
            <span className="badge badge-neutral" style={{ marginTop: 4 }}>v{skill.version}</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {isMalware   && <span className="badge badge-danger">malware</span>}
          {isSuspicious && <span className="badge badge-warn">suspicious</span>}
        </div>
      </div>

      <div className="muted" style={{ fontSize: 12, lineHeight: 1.5, flex: 1 }}>{summary}</div>

      <div className="row" style={{ gap: 8, marginTop: 4 }}>
        {skill.stars !== undefined && (
          <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)" }}>
            ⭐ {skill.stars.toLocaleString()}
          </span>
        )}
        {skill.installs !== undefined && (
          <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--mono)" }}>
            ↓ {skill.installs.toLocaleString()}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          className="btn btn-primary btn-sm"
          disabled={isMalware}
          onClick={() => onInstall(skill.slug)}
        >
          Install
        </button>
      </div>
    </div>
  );
}

// ── Install modal ─────────────────────────────────────────────────────────────
function InstallModal({
  slug,
  detail,
  isLoading,
  acceptedDisclaimer,
  setAcceptedDisclaimer,
  keyValues,
  setKeyValues,
  onInstall,
  onClose,
  isInstalling,
  installError,
}: {
  slug: string;
  detail: ClawhubSkillDetailResponse | null;
  isLoading: boolean;
  acceptedDisclaimer: boolean;
  setAcceptedDisclaimer: (v: boolean) => void;
  keyValues: Record<string, string>;
  setKeyValues: (v: Record<string, string>) => void;
  onInstall: () => void;
  onClose: () => void;
  isInstalling: boolean;
  installError?: string;
}) {
  const hasCritical = detail?.vetting.issues.some((i) => i.level === "critical") ?? false;
  const canInstall  = acceptedDisclaimer && !hasCritical && !isInstalling && !!detail && detail.vetting.safe;

  return (
    <div
      className="cmd-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) {onClose();} }}
      style={{ alignItems: "center", paddingTop: 0 }}
    >
      <div
        className="cmd-box"
        style={{ maxWidth: 560, maxHeight: "85vh", overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}
      >
        {/* Header */}
        <div className="row" style={{ alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: "var(--text-strong)" }}>
              Install Skill
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{slug}</div>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={onClose}>✕</button>
        </div>

        {isLoading && (
          <div style={{ textAlign: "center", padding: 32, color: "var(--muted)" }}>
            <div className="skeleton" style={{ height: 16, width: "60%", margin: "0 auto 8px" }} />
            <div className="skeleton" style={{ height: 12, width: "40%", margin: "0 auto" }} />
          </div>
        )}

        {!isLoading && detail && (
          <>
            {/* Security Report */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Security Report — Score: {detail.vetting.score}/100
              </div>
              {detail.vetting.issues.length === 0 ? (
                <div className="callout callout-ok" style={{ fontSize: 12 }}>
                  <span>✓</span>
                  <span>No issues found. This skill passed all security checks.</span>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {detail.vetting.issues.map((issue, i) => (
                    <div key={i} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                      <span className={`badge ${issueClass(issue.level)}`} style={{ flexShrink: 0 }}>
                        {issueIcon(issue.level)} {issue.level}
                      </span>
                      <span style={{ fontSize: 12, color: "var(--text)" }}>{issue.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Required API keys */}
            {detail.requiredKeys.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Required API Keys
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {detail.requiredKeys.map((k) => (
                    <div key={k.envVar} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div className="row" style={{ gap: 8, alignItems: "center" }}>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--accent)", background: "var(--accent-subtle)", padding: "2px 8px", borderRadius: 4, flexShrink: 0 }}>
                          {k.envVar}
                        </span>
                        <span style={{ fontSize: 12, color: "var(--muted)", flex: 1 }}>{k.label}</span>
                        {k.url && (
                          <a
                            href={k.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn btn-sm"
                            style={{ fontSize: 11 }}
                          >
                            Get key →
                          </a>
                        )}
                      </div>
                      <input
                        className="input"
                        type="password"
                        placeholder={`Paste your ${k.envVar} here`}
                        value={keyValues[k.envVar] ?? ""}
                        onChange={(e) => setKeyValues({ ...keyValues, [k.envVar]: e.target.value })}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Disclaimer */}
            <div className="callout callout-warn" style={{ fontSize: 12 }}>
              <span>⚠</span>
              <span>
                This skill is published by a third party. ClawOS performed automated security
                checks but takes no responsibility for its behavior. Review the SKILL.md before
                activating on sensitive workspaces.
              </span>
            </div>

            <label className="row" style={{ gap: 10, cursor: "pointer", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={acceptedDisclaimer}
                onChange={(e) => setAcceptedDisclaimer(e.target.checked)}
              />
              I understand and accept the disclaimer
            </label>

            {installError && (
              <div className="callout callout-danger" style={{ fontSize: 12 }}>
                <span>✗</span><span>{installError}</span>
              </div>
            )}
          </>
        )}

        {/* Footer */}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary btn-sm"
            disabled={!canInstall}
            onClick={onInstall}
          >
            {isInstalling ? "Installing…" : hasCritical ? "Blocked — critical issues" : "Accept & Install"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Browse tab ────────────────────────────────────────────────────────────────
function BrowseTab({
  searchInput,
  onSearchChange,
  skills,
  isLoading,
  hasError,
  searchQuery,
  onInstall,
}: {
  searchInput: string;
  onSearchChange: (v: string) => void;
  skills: ClawhubSkill[];
  isLoading: boolean;
  hasError: boolean;
  searchQuery: string;
  onInstall: (slug: string) => void;
}) {
  return (
    <>
      <div style={{ marginBottom: 20 }}>
        <input
          className="input"
          type="search"
          placeholder="Search 3,286 skills on ClaWHub…"
          value={searchInput}
          onChange={(e) => onSearchChange(e.target.value)}
          style={{ maxWidth: 480 }}
        />
      </div>

      {isLoading && (
        <div className="grid-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card card-sm" style={{ gap: 10 }}>
              <div className="skeleton" style={{ height: 14, width: "60%" }} />
              <div className="skeleton" style={{ height: 12, width: "80%" }} />
              <div className="skeleton" style={{ height: 12, width: "40%" }} />
            </div>
          ))}
        </div>
      )}

      {hasError && (
        <div className="callout callout-warn">
          <span>⚠</span>
          <span>
            ClaWHub marketplace is currently unavailable. Check your connection or try again later.
          </span>
        </div>
      )}

      {!isLoading && !hasError && skills.length === 0 && searchQuery && (
        <div className="empty-state">
          <div className="empty-icon">🔍</div>
          <div className="empty-title">No skills found</div>
          <div className="empty-desc">Try a different search term or browse trending skills.</div>
        </div>
      )}

      {!isLoading && !hasError && skills.length === 0 && !searchQuery && (
        <div className="empty-state">
          <div className="empty-icon">🌐</div>
          <div className="empty-title">Connecting to ClaWHub…</div>
          <div className="empty-desc">Loading trending skills from the marketplace.</div>
        </div>
      )}

      {!isLoading && skills.length > 0 && (
        <>
          {!searchQuery && (
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
              Trending on ClaWHub
            </div>
          )}
          {searchQuery && (
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
              {skills.length} result{skills.length !== 1 ? "s" : ""} for "{searchQuery}"
            </div>
          )}
          <div className="grid-2">
            {skills.map((skill) => (
              <SkillCard key={skill.slug} skill={skill} onInstall={onInstall} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ── Installed tab ─────────────────────────────────────────────────────────────
function InstalledTab({
  skills,
  isLoading,
  onToggle,
  onUninstall,
}: {
  skills: InstalledSkill[];
  isLoading: boolean;
  onToggle: (slug: string, enabled: boolean) => void;
  onUninstall: (slug: string) => void;
}) {
  if (isLoading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="skeleton" style={{ height: 44 }} />
        ))}
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">📦</div>
        <div className="empty-title">No skills installed</div>
        <div className="empty-desc">Browse the marketplace and install skills to extend ClawOS.</div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <table className="table">
        <thead>
          <tr>
            <th>Skill</th>
            <th>Version</th>
            <th>Source</th>
            <th>Installed</th>
            <th>Enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {skills.map((s) => (
            <tr key={s.slug}>
              <td>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-strong)" }}>
                  {s.display_name}
                </span>
                <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                  {s.slug}
                </div>
              </td>
              <td>
                <span className="badge badge-neutral">v{s.version}</span>
              </td>
              <td>
                <span className={`badge ${s.source === "clawhub" ? "badge-accent" : "badge-info"}`}>
                  {s.source}
                </span>
              </td>
              <td style={{ fontSize: 12, color: "var(--muted)" }}>
                {new Date(s.installed_at).toLocaleDateString()}
              </td>
              <td>
                <label style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={s.enabled === 1}
                    onChange={(e) => onToggle(s.slug, e.target.checked)}
                  />
                  <span style={{ fontSize: 12 }}>{s.enabled ? "On" : "Off"}</span>
                </label>
              </td>
              <td>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => onUninstall(s.slug)}
                >
                  Uninstall
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Build tab ─────────────────────────────────────────────────────────────────
function BuildTab({
  buildDesc,
  setBuildDesc,
  buildResult,
  setBuildResult,
  onGenerate,
  isGenerating,
  generateError,
  onActivate,
  isActivating,
}: {
  buildDesc: string;
  setBuildDesc: (v: string) => void;
  buildResult: BuildResult | null;
  setBuildResult: (v: BuildResult | null) => void;
  onGenerate: () => void;
  isGenerating: boolean;
  generateError?: string;
  onActivate: () => void;
  isActivating: boolean;
}) {
  const [previewTab, setPreviewTab] = useState<"skill_md" | "script">("skill_md");

  return (
    <>
      <div className="callout callout-info" style={{ marginBottom: 20 }}>
        <span>ℹ</span>
        <span>
          If a task requires a skill that doesn't exist, you can build one here.
          ClawOS will use Claude to generate a SKILL.md definition and a shell script.
          An Anthropic API key is required.
        </span>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">Describe Your Skill</div>
        <div className="field" style={{ marginBottom: 12 }}>
          <label className="label">What should this skill do?</label>
          <textarea
            className="textarea"
            rows={4}
            placeholder="e.g. Search GitHub issues for a given repo and keyword, then summarise the top 5 results…"
            value={buildDesc}
            onChange={(e) => { setBuildDesc(e.target.value); setBuildResult(null); }}
          />
        </div>
        <div className="row" style={{ gap: 10 }}>
          <button
            className="btn btn-primary"
            disabled={!buildDesc.trim() || isGenerating}
            onClick={onGenerate}
          >
            {isGenerating ? "Generating…" : "Generate Skill"}
          </button>
          {buildResult && (
            <span style={{ fontSize: 12, color: "var(--ok)" }}>✓ Ready to review</span>
          )}
        </div>
        {generateError && (
          <div className="callout callout-danger" style={{ marginTop: 12, fontSize: 12 }}>
            <span>✗</span><span>{generateError}</span>
          </div>
        )}
      </div>

      {buildResult && (
        <div className="card">
          <div className="row" style={{ marginBottom: 12, alignItems: "center" }}>
            <div className="card-title" style={{ marginBottom: 0 }}>
              Generated: <span style={{ fontFamily: "var(--mono)" }}>{buildResult.displayName}</span>
            </div>
            <div style={{ flex: 1 }} />
            <div className="segment">
              <button
                className={`seg-btn ${previewTab === "skill_md" ? "active-auto" : ""}`}
                onClick={() => setPreviewTab("skill_md")}
              >
                SKILL.md
              </button>
              <button
                className={`seg-btn ${previewTab === "script" ? "active-auto" : ""}`}
                onClick={() => setPreviewTab("script")}
              >
                {buildResult.scriptFilename}
              </button>
            </div>
          </div>

          <pre style={{
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-md)",
            padding: 14,
            fontSize: 12,
            fontFamily: "var(--mono)",
            overflowX: "auto",
            maxHeight: 360,
            overflowY: "auto",
            color: "var(--text)",
            lineHeight: 1.5,
            marginBottom: 16,
          }}>
            {previewTab === "skill_md" ? buildResult.skillMd : buildResult.scriptContent}
          </pre>

          <div className="row" style={{ gap: 10 }}>
            <button
              className="btn btn-primary"
              disabled={isActivating}
              onClick={onActivate}
            >
              {isActivating ? "Activating…" : "Activate Skill"}
            </button>
            <button className="btn btn-sm" onClick={() => setBuildResult(null)}>
              Regenerate
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ── Main Skills component ─────────────────────────────────────────────────────
export function Skills() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("browse");

  // Browse / search
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Install modal
  const [installSlug, setInstallSlug]               = useState<string | null>(null);
  const [acceptedDisclaimer, setAcceptedDisclaimer] = useState(false);
  const [keyValues, setKeyValues]                   = useState<Record<string, string>>({});

  // Build tab
  const [buildDesc, setBuildDesc]     = useState("");
  const [buildResult, setBuildResult] = useState<BuildResult | null>(null);

  // Debounce search input → 400ms
  useEffect(() => {
    if (debounceRef.current) {clearTimeout(debounceRef.current);}
    debounceRef.current = setTimeout(() => setSearchQuery(searchInput), 400);
    return () => { if (debounceRef.current) {clearTimeout(debounceRef.current);} };
  }, [searchInput]);

  // ── Queries ────────────────────────────────────────────────────────────────
  const exploreQ = useQuery({
    queryKey: ["clawhub-explore"],
    queryFn: () => kernelApi.clawhub.explore(),
    enabled: tab === "browse" && !searchQuery,
    retry: 1,
    staleTime: 60_000,
  });

  const searchQ = useQuery({
    queryKey: ["clawhub-search", searchQuery],
    queryFn: () => kernelApi.clawhub.search(searchQuery),
    enabled: tab === "browse" && !!searchQuery,
    retry: 1,
  });

  const skillDetailQ = useQuery({
    queryKey: ["clawhub-skill", installSlug],
    queryFn: () => kernelApi.clawhub.getSkill(installSlug!),
    enabled: !!installSlug,
    retry: 0,
  });

  const installedQ = useQuery({
    queryKey: ["clawhub-installed"],
    queryFn: kernelApi.clawhub.listInstalled,
    enabled: tab === "installed",
    staleTime: 5_000,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────
  const installMut = useMutation({
    mutationFn: ({ slug }: { slug: string }) =>
      kernelApi.clawhub.install(slug, true, keyValues),
    onSuccess: () => {
      setInstallSlug(null);
      setKeyValues({});
      void qc.invalidateQueries({ queryKey: ["clawhub-installed"] });
      void qc.invalidateQueries({ queryKey: ["skill-keys"] });
    },
  });

  const uninstallMut = useMutation({
    mutationFn: (slug: string) => kernelApi.clawhub.uninstall(slug),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["clawhub-installed"] }),
  });

  const toggleMut = useMutation({
    mutationFn: ({ slug, enabled }: { slug: string; enabled: boolean }) =>
      kernelApi.clawhub.toggleEnabled(slug, enabled),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["clawhub-installed"] }),
  });

  const buildMut = useMutation({
    mutationFn: (desc: string) => kernelApi.clawhub.build(desc),
    onSuccess: (data) => setBuildResult(data),
  });

  const activateMut = useMutation({
    mutationFn: (result: BuildResult & { description?: string }) =>
      kernelApi.clawhub.activate(result),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["clawhub-installed"] });
      setTab("installed");
    },
  });

  // ── Derived data ───────────────────────────────────────────────────────────
  const browsedSkills = searchQuery
    ? (searchQ.data?.skills ?? [])
    : (exploreQ.data?.skills ?? []);
  const isLoading = searchQuery ? searchQ.isLoading : exploreQ.isLoading;
  const hasError  = searchQuery ? searchQ.isError   : exploreQ.isError;

  return (
    <div className="animate-rise">
      {/* Header */}
      <div className="page-header row">
        <div>
          <h1 className="page-title">Skills Marketplace</h1>
          <p className="page-subtitle">Browse, install, and build skills from ClaWHub</p>
        </div>
        <div style={{ flex: 1 }} />
        {tab === "installed" && (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            {installedQ.data?.skills.length ?? 0} installed
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="segment" style={{ marginBottom: 24 }}>
        {(["browse", "installed", "build"] as Tab[]).map((t) => (
          <button
            key={t}
            className={`seg-btn ${tab === t ? "active-auto" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "browse" ? "Browse" : t === "installed" ? "Installed" : "Build"}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "browse" && (
        <BrowseTab
          searchInput={searchInput}
          onSearchChange={(v) => { setSearchInput(v); }}
          skills={browsedSkills}
          isLoading={isLoading}
          hasError={hasError}
          searchQuery={searchQuery}
          onInstall={(slug) => { setInstallSlug(slug); setAcceptedDisclaimer(false); setKeyValues({}); installMut.reset(); }}
        />
      )}

      {tab === "installed" && (
        <InstalledTab
          skills={installedQ.data?.skills ?? []}
          isLoading={installedQ.isLoading}
          onToggle={(slug, enabled) => toggleMut.mutate({ slug, enabled })}
          onUninstall={(slug) => uninstallMut.mutate(slug)}
        />
      )}

      {tab === "build" && (
        <BuildTab
          buildDesc={buildDesc}
          setBuildDesc={setBuildDesc}
          buildResult={buildResult}
          setBuildResult={setBuildResult}
          onGenerate={() => buildMut.mutate(buildDesc)}
          isGenerating={buildMut.isPending}
          generateError={buildMut.error?.message}
          onActivate={() =>
            buildResult && activateMut.mutate({ ...buildResult, description: buildDesc })
          }
          isActivating={activateMut.isPending}
        />
      )}

      {/* Install modal */}
      {installSlug && (
        <InstallModal
          slug={installSlug}
          detail={skillDetailQ.data ?? null}
          isLoading={skillDetailQ.isLoading}
          acceptedDisclaimer={acceptedDisclaimer}
          setAcceptedDisclaimer={setAcceptedDisclaimer}
          keyValues={keyValues}
          setKeyValues={setKeyValues}
          onInstall={() => installMut.mutate({ slug: installSlug })}
          onClose={() => { setInstallSlug(null); setKeyValues({}); installMut.reset(); }}
          isInstalling={installMut.isPending}
          installError={installMut.error?.message}
        />
      )}
    </div>
  );
}
