/**
 * The right-side SSH terminal panel: a floating panel pinned to the right edge
 * of the conversation view. Shows a connection toolbar, an xterm.js terminal
 * for the active session, and a connect dialog.
 */
import * as React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { XTERM_CSS } from "./xterm-css.js";
import { useSshUi, getSshUiSnapshot, sshUiSetActive, sshUiSetBusy, sshUiSetConnections, sshUiSetError, sshUiSetOpen } from "./store.js";
import { SshFiles } from "./SshFiles.jsx";
import { SshTunnels } from "./SshTunnels.jsx";
import { SshDatabase } from "./SshDatabase.jsx";

const { useEffect, useRef, useState, Component } = React;

/** Error boundary so a crash in one tab (Files/Tunnels) never closes the panel. */
class TabErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error("[dsh-ssh-ops] tab crashed:", error);
  }
  render() {
    if (this.state.error) {
      return React.createElement("div", {
        style: { margin: "auto", padding: 16, fontSize: 12, color: "#f85149", textAlign: "center" }
      }, `此页签出错：${this.state.error?.message ?? String(this.state.error)}`);
    }
    return this.props.children;
  }
}

let stylesInjected = false;
const PANEL_LAYOUT_STYLE_ID = "dsh-ssh-ops-panel-layout";
const PANEL_WIDTH_KEY = "dsh-ssh-ops.panel-width";
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 720;

function maxPanelWidth() {
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.floor(window.innerWidth * 0.7)));
}

function clampPanelWidth(width) {
  return clamp(Math.round(width), PANEL_MIN_WIDTH, maxPanelWidth());
}

function initialPanelWidth() {
  try {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored)) return clampPanelWidth(stored);
  } catch {}
  return 480;
}


function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `${XTERM_CSS}

/*
 * The shell overlay does not reserve layout space on its own.  When the SSH
 * drawer is open, make the main conversation column yield the drawer width so
 * text never continues underneath the terminal.  The class suffix is emitted
 * by DSH's CSS modules and is stable across its hashed prefix.
 */
html[data-dsh-ssh-ops-panel-open] [class*="centerCol"] {
  margin-right: var(--dsh-ssh-ops-panel-space, 496px) !important;
  transition: margin-right 160ms ease;
}

/* On narrow screens, preserving a usable conversation column matters more
 * than a permanent split view, so the terminal remains an overlay. */
@media (max-width: 900px) {
  html[data-dsh-ssh-ops-panel-open] [class*="centerCol"] {
    margin-right: 0 !important;
  }
}`;
  document.head.appendChild(style);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** One xterm instance bound to one host session via long-poll reads. */
function XtermView({ api, sessionId, connectionId }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    ensureStyles();
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 5000,
      // Some remote commands produce LF-only text. Treat it as a normal
      // terminal newline so rows do not continue at the previous column.
      convertEol: true,
      theme: { background: "#101418" }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;
    term.open(containerRef.current);
    fit.fit();

    let alive = true;
    let resizeObserver = null;
    let writeQueue = Promise.resolve();

    const onData = (data) => {
      writeQueue = writeQueue.then(() => api.write(sessionId, data)).catch(() => {});
    };
    term.onData(onData);

    const loop = async () => {
      while (alive) {
        try {
          const { data, exit } = await api.read(sessionId, 300);
          if (data) term.write(data);
          if (exit !== null) {
            setClosed(true);
            if (alive) term.write(`\r\n\x1b[90m[session exited]\x1b[0m\r\n`);
            return;
          }
        } catch (error) {
          if (!alive) return;
          if (error?.code === "no-session") return;
          // transient; keep polling
        }
      }
    };
    loop();

    const onResize = () => {
      try {
        fit.fit();
        const dims = term.cols && term.rows ? { cols: term.cols, rows: term.rows } : null;
        if (dims && alive) api.resize(sessionId, dims.cols, dims.rows).catch(() => {});
      } catch {}
    };
    resizeObserver = new ResizeObserver(onResize);
    if (containerRef.current) resizeObserver.observe(containerRef.current);

    return () => {
      alive = false;
      resizeObserver?.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId, connectionId, api]);

  return (
    <div style={panelStyles.xtermWrap} ref={containerRef} data-closed={closed || undefined} />
  );
}

async function refreshConnections(api) {
  try {
    const listed = await api.list();
    const connections = listed.connections ?? [];
    sshUiSetConnections(connections);
    const snap = getSshUiSnapshot();
    const serverActive = listed.activeConnectionId ?? null;
    if (serverActive && serverActive !== snap.activeConnectionId && !snap.activeSessionId) {
      sshUiSetActive(serverActive, null);
    } else if (!snap.activeConnectionId && serverActive) {
      sshUiSetActive(serverActive, snap.activeSessionId);
    } else if (!snap.activeConnectionId && connections.length > 0) {
      sshUiSetActive(connections[0].connectionId, snap.activeSessionId);
    }
  } catch (error) {
    sshUiSetError(`无法刷新 SSH 连接列表：${error?.message ?? String(error)}`);
  }
}

export function SshPanel({ api, locale }) {
  const ui = useSshUi();
  const [panelWidth, setPanelWidth] = useState(initialPanelWidth);
  const [tab, setTab] = useState("terminal");
  const [clusterOpen, setClusterOpen] = useState(false);
  const [clusterCmd, setClusterCmd] = useState("");
  const [clusterResults, setClusterResults] = useState(null);
  const [clusterBusy, setClusterBusy] = useState(false);
  const [clusterProfiles, setClusterProfiles] = useState([]);
  const [clusterBatchSelected, setClusterBatchSelected] = useState({});
  const [clusterBatchBusy, setClusterBatchBusy] = useState(false);
  const panelRef = useRef(null);
  const t = zhDict;

  useEffect(() => {
    if (!ui.open) return;
    refreshConnections(api);
    const timer = setInterval(() => refreshConnections(api), 5000);
    return () => clearInterval(timer);
  }, [ui.open, api]);

  // Files work on the transport alone; the terminal needs a PTY. Open one when
  // the panel is shown with a live connection but no session yet.
  const openingSessionRef = useRef(false);
  useEffect(() => {
    if (!ui.open || !ui.activeConnectionId || ui.activeSessionId || openingSessionRef.current) return;
    let cancelled = false;
    openingSessionRef.current = true;
    (async () => {
      sshUiSetBusy(true);
      sshUiSetError(null);
      try {
        const value = await api.openSession(ui.activeConnectionId, 100, 30);
        if (!cancelled) sshUiSetActive(ui.activeConnectionId, value.sessionId);
      } catch (err) {
        if (!cancelled) sshUiSetError(err?.message ?? String(err));
      } finally {
        openingSessionRef.current = false;
        if (!cancelled) sshUiSetBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ui.open, ui.activeConnectionId, ui.activeSessionId, api]);

  useEffect(() => {
    if (!ui.open) return;

    ensureStyles();
    const root = document.documentElement;
    const syncReservedSpace = () => {
      const width = Math.ceil(panelRef.current?.getBoundingClientRect().width || 480);
      // Keep a small breathing gap between the message column and the drawer.
      root.style.setProperty("--dsh-ssh-ops-panel-space", `${width + 16}px`);
    };

    syncReservedSpace();
    root.dataset.dshSshOpsPanelOpen = "true";
    const observer = new ResizeObserver(syncReservedSpace);
    if (panelRef.current) observer.observe(panelRef.current);

    return () => {
      observer.disconnect();
      delete root.dataset.dshSshOpsPanelOpen;
      root.style.removeProperty("--dsh-ssh-ops-panel-space");
    };
  }, [ui.open]);

  useEffect(() => {
    const onWindowResize = () => setPanelWidth((width) => clampPanelWidth(width));
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, []);

  if (!ui.open) return null;

  const active = ui.connections.find((c) => c.connectionId === ui.activeConnectionId);

  const openSession = async () => {
    if (!active) return;
    sshUiSetBusy(true);
    sshUiSetError(null);
    try {
      const value = await api.openSession(active.connectionId, 100, 30);
      sshUiSetActive(active.connectionId, value.sessionId);
    } catch (err) {
      sshUiSetError(err?.message ?? String(err));
    } finally {
      sshUiSetBusy(false);
    }
  };

  const closeSession = async () => {
    if (!ui.activeSessionId) return;
    try {
      await api.closeSession(ui.activeSessionId);
    } catch {}
    sshUiSetActive(ui.activeConnectionId, null);
  };

  const closePanel = () => {
    // Hide only. Keep ctx.ssh transport alive (monitor / files / settings
    // "已连接" must survive). Drop the PTY so an idle shell is not held while
    // the drawer is closed; opening the drawer opens a fresh session.
    const snap = getSshUiSnapshot();
    if (snap.activeSessionId) {
      api.closeSession(snap.activeSessionId).catch(() => {});
      sshUiSetActive(snap.activeConnectionId, null);
    }
    sshUiSetOpen(false);
  };

  const clusterBatchConnect = async () => {
    const ids = Object.keys(clusterBatchSelected).filter((id) => clusterBatchSelected[id]);
    if (ids.length === 0) return;
    setClusterBatchBusy(true);
    for (const profileId of ids) {
      try {
        const connection = await api.profileConnect(profileId);
        sshUiSetActive(connection.connectionId, null);
        try {
          const session = await api.openSession(connection.connectionId, 100, 30);
          sshUiSetActive(connection.connectionId, session.sessionId);
        } catch {}
      } catch {}
    }
    await refreshConnections(api);
    setClusterBatchSelected({});
    setClusterBatchBusy(false);
  };

  const runCluster = async () => {
    if (!clusterCmd.trim() || ui.connections.length === 0) return;
    setClusterBusy(true);
    setClusterResults(null);
    try {
      // Call ssh_exec on each connection via the api (concurrent).
      const results = await Promise.all(ui.connections.map(async (conn) => {
        try {
          const value = await api.call("sshOps/execOnConnection", { connectionId: conn.connectionId, command: clusterCmd.trim(), timeoutMs: 30000 });
          return { name: conn.name || conn.host, host: conn.host, ok: value.ok !== false, output: value.stdout || value.error || "" };
        } catch (err) {
          return { name: conn.name || conn.host, host: conn.host, ok: false, output: err?.message ?? String(err) };
        }
      }));
      setClusterResults(results);
    } finally {
      setClusterBusy(false);
    }
  };

  const beginResize = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelRef.current?.getBoundingClientRect().width ?? panelWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onPointerMove = (moveEvent) => {
      // The drawer is anchored at the right, so moving its left edge left makes
      // it wider and moving it right makes it narrower.
      setPanelWidth(clampPanelWidth(startWidth + startX - moveEvent.clientX));
    };
    const endResize = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endResize);
      window.removeEventListener("pointercancel", endResize);
      setPanelWidth((width) => {
        try {
          localStorage.setItem(PANEL_WIDTH_KEY, String(width));
        } catch {}
        return width;
      });
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endResize);
    window.addEventListener("pointercancel", endResize);
  };

  return (
    <div ref={panelRef} style={{ ...panelStyles.root, width: panelWidth }}>
      <div
        style={panelStyles.resizeHandle}
        onPointerDown={beginResize}
        role="separator"
        aria-label="调整 SSH 终端宽度"
        aria-orientation="vertical"
        title="拖动以调整 SSH 终端宽度"
      />
      <div style={panelStyles.header}>
        <span style={panelStyles.title}>{t.panelTitle}</span>
        <button onClick={closePanel} disabled={ui.busy} style={panelStyles.btnSmall} title={t.closePanel}>×</button>
      </div>

      <div style={panelStyles.connBar}>
        {ui.connections.length > 0 ? (
          <>
            <span
              style={panelStyles.connLabel}
              title={active ? `${active.username}@${active.host}:${active.port}` : undefined}
            >
              {active ? (active.name || `${active.username}@${active.host}`) : ui.connections[0].name || `${ui.connections[0].username}@${ui.connections[0].host}`}
            </span>
            <span style={panelStyles.dot} />
            {!ui.activeSessionId && (
              <button onClick={openSession} disabled={ui.busy || !active} style={panelStyles.btnTiny}>
                {ui.busy ? t.busy : t.openSession}
              </button>
            )}
            {ui.activeSessionId && (
              <button onClick={closeSession} style={panelStyles.btnTiny}>{t.closeSession}</button>
            )}
          </>
        ) : (
          <span style={panelStyles.connEmpty}>{t.empty}</span>
        )}
      </div>

      {ui.error && <div style={panelStyles.error}>{ui.error}</div>}

      <div style={panelStyles.tabs}>
        {[
          ["terminal", t.tabTerminal],
          ["files", t.tabFiles],
          ["tunnels", t.tabTunnels]
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            disabled={!active && key !== "terminal"}
            style={{
              ...panelStyles.tab,
              ...(tab === key ? panelStyles.tabActive : {})
            }}
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => {
            setClusterOpen(!clusterOpen);
            if (!clusterOpen) {
              setClusterResults(null);
              setClusterCmd("");
              api.profileList().then((v) => setClusterProfiles(v.profiles || [])).catch(() => {});
            }
          }}
          style={panelStyles.tab}
          title="批量连接服务器并执行命令"
        >
          批量
        </button>
        <button
          onClick={() => setTab("database")}
          style={{
            ...panelStyles.tab,
            ...(tab === "database" ? panelStyles.tabActive : {})
          }}
          title="数据库连接与查询"
        >
          {t.tabDatabase}
        </button>
      </div>

      <div style={panelStyles.body}>
        <TabErrorBoundary key="terminal">
          <div style={{ ...panelStyles.tabPane, display: tab === "terminal" ? "flex" : "none" }}>
            {ui.activeSessionId && active ? (
              <XtermView api={api} sessionId={ui.activeSessionId} connectionId={active.connectionId} />
            ) : (
              <div style={panelStyles.emptyState}>{active ? t.sessionClosed : t.noConnection}</div>
            )}
          </div>
        </TabErrorBoundary>
        {active && (
          <>
            <TabErrorBoundary key="files">
              <div style={{ ...panelStyles.tabPane, display: tab === "files" ? "flex" : "none" }}>
                <SshFiles api={api} connectionId={active.connectionId} />
              </div>
            </TabErrorBoundary>
            <TabErrorBoundary key="tunnels">
              <div style={{ ...panelStyles.tabPane, display: tab === "tunnels" ? "flex" : "none" }}>
                <SshTunnels api={api} connectionId={active.connectionId} />
              </div>
            </TabErrorBoundary>
          </>
        )}
        <TabErrorBoundary key="database">
          <div style={{ ...panelStyles.tabPane, display: tab === "database" ? "flex" : "none" }}>
            <SshDatabase api={api} />
          </div>
        </TabErrorBoundary>
      </div>


      {clusterOpen && (
        <div style={panelStyles.dialogBackdrop} onClick={() => setClusterOpen(false)}>
          <div style={panelStyles.dialog} onClick={(e) => e.stopPropagation()}>
            <div style={panelStyles.dialogTitle}>批量执行</div>

            {/* 已连接的服务器 */}
            <div style={{ fontSize: 12, color: "#9aa3af", marginBottom: 6 }}>
              已连接 {ui.connections.length} 台：{ui.connections.map((c) => c.name || c.host).join("、") || "无"}
            </div>

            {/* 未连接的服务器列表 — 先连接再执行 */}
            {clusterProfiles.length > 0 && (
              <div style={panelStyles.batchSection}>
                <span style={panelStyles.batchTitle}>添加更多服务器（勾选后点连接）</span>
                <div style={panelStyles.batchList}>
                  {clusterProfiles
                    .filter((p) => !ui.connections.some((c) => c.name === p.name))
                    .map((profile) => (
                      <label key={profile.profileId} style={panelStyles.batchItem}>
                        <input
                          type="checkbox"
                          checked={!!clusterBatchSelected[profile.profileId]}
                          onChange={() => setClusterBatchSelected((s) => ({ ...s, [profile.profileId]: !s[profile.profileId] }))}
                        />
                        <span>{profile.name || profile.host} — {profile.username}@{profile.host}:{profile.port}</span>
                      </label>
                    ))}
                </div>
                <button type="button" onClick={clusterBatchConnect} disabled={clusterBatchBusy || !Object.values(clusterBatchSelected).some(Boolean)} style={panelStyles.btnSecondary}>
                  {clusterBatchBusy ? "连接中…" : "连接选中"}
                </button>
              </div>
            )}

            {/* 命令输入 */}
            <input
              value={clusterCmd}
              onChange={(e) => setClusterCmd(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runCluster()}
              placeholder="输入要批量执行的命令…"
              style={panelStyles.input}
            />
            <div style={{ ...panelStyles.dialogActions, marginTop: 8 }}>
              <button onClick={() => setClusterOpen(false)} style={panelStyles.btnSecondary}>关闭</button>
              <button onClick={runCluster} disabled={clusterBusy || !clusterCmd.trim() || ui.connections.length === 0} style={panelStyles.btnPrimary}>
                {clusterBusy ? "执行中…" : `执行（${ui.connections.length} 台）`}
              </button>
            </div>

            {/* 结果 */}
            {clusterResults && (
              <div style={{ marginTop: 8, maxHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                {clusterResults.map((r, i) => (
                  <div key={i} style={{ padding: "6px 8px", background: "#101418", borderRadius: 6, border: `1px solid ${r.ok ? "#3fb950" : "#f85149"}` }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: r.ok ? "#3fb950" : "#f85149" }}>{r.name}</div>
                    <pre style={{ fontSize: 11, color: "#d7dbe2", margin: "4px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{r.output.slice(0, 500)}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const zhDict = {
  panelTitle: "SSH 终端",
  connect: "连接服务器",
  closePanel: "关闭 SSH 终端面板（不断开服务器连接）",
  openSession: "打开终端",
  closeSession: "关闭终端",
  empty: "还没有连接。请在设置 → SSH 资源里连接服务器。",
  sessionClosed: "会话已关闭",
  noConnection: "未连接",
  busy: "忙…",
  tabTerminal: "终端",
  tabFiles: "文件",
  tabTunnels: "转发",
  tabDatabase: "数据库"
};

const enDict = {
  panelTitle: "SSH Terminal",
  connect: "Connect",
  closePanel: "Close SSH terminal panel (keep server connection)",
  openSession: "Open",
  closeSession: "Close",
  empty: "No connection. Connect a server in Settings → SSH resources.",
  sessionClosed: "Session closed",
  noConnection: "Not connected",
  busy: "Busy…",
  tabTerminal: "Terminal",
  tabFiles: "Files",
  tabTunnels: "Tunnels",
  tabDatabase: "Database"
};

const panelStyles = {
  root: {
    position: "fixed",
    top: 0,
    right: 0,
    bottom: 0,
    width: 480,
    maxWidth: "70vw",
    zIndex: 900,
    display: "flex",
    flexDirection: "column",
    background: "#101418",
    borderLeft: "1px solid #262b33",
    boxShadow: "-8px 0 24px rgba(0,0,0,.35)",
    fontFamily: "var(--dsw-font-family, system-ui, sans-serif)",
    color: "#d7dbe2"
  },
  resizeHandle: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: -5,
    width: 10,
    cursor: "col-resize",
    zIndex: 1,
    touchAction: "none"
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px",
    borderBottom: "1px solid #262b33",
    flex: "none"
  },
  title: { fontSize: 13, fontWeight: 600, flex: 1 },
  btnSmall: {
    background: "transparent",
    border: "1px solid #3a414b",
    color: "#d7dbe2",
    borderRadius: 6,
    width: 26,
    height: 26,
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1
  },
  btnTiny: {
    background: "transparent",
    border: "1px solid #3a414b",
    color: "#d7dbe2",
    borderRadius: 6,
    padding: "2px 8px",
    fontSize: 12,
    cursor: "pointer"
  },
  connBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderBottom: "1px solid #1f242c",
    flex: "none"
  },
  connLabel: { fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 },
  dot: { width: 8, height: 8, borderRadius: "50%", background: "#3fb950", flex: "none" },
  connEmpty: { fontSize: 12, color: "#8b93a1" },
  error: {
    padding: "6px 12px",
    fontSize: 12,
    color: "#f85149",
    background: "rgba(248,81,73,.1)",
    borderBottom: "1px solid rgba(248,81,73,.3)",
    flex: "none"
  },
  body: { flex: 1, minHeight: 0, padding: 8, display: "flex", flexDirection: "column" },
  tabPane: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
  tabs: {
    display: "flex", gap: 4, padding: "0 8px", borderBottom: "1px solid #1f242c",
    flex: "none", alignItems: "center"
  },
  tab: {
    background: "transparent", border: "none", color: "#8b93a1",
    padding: "6px 12px", fontSize: 12, cursor: "pointer",
    borderBottom: "2px solid transparent"
  },
  tabActive: { color: "#d7dbe2", borderBottomColor: "#2d6cdf" },
  emptyState: { margin: "auto", fontSize: 12, color: "#8b93a1", textAlign: "center" },
  xtermWrap: { flex: 1, minWidth: 0, overflow: "hidden" },
  dialogBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.5)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  },
  dialog: {
    width: 360,
    maxWidth: "90vw",
    background: "#181c22",
    border: "1px solid #2a303a",
    borderRadius: 12,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    boxShadow: "0 12px 40px rgba(0,0,0,.5)"
  },
  dialogTitle: { fontSize: 14, fontWeight: 600, marginBottom: 2 },
  temporaryTitle: { fontSize: 12, color: "#9aa3af", marginTop: 2 },
  field: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#9aa3af" },
  input: {
    background: "#101418",
    border: "1px solid #2a303a",
    borderRadius: 6,
    color: "#d7dbe2",
    padding: "6px 8px",
    fontSize: 13,
    outline: "none"
  },
  dialogError: { fontSize: 12, color: "#f85149" },
  dialogStatus: {
    fontSize: 12,
    color: "#9cc8ff",
    background: "rgba(45,108,223,.12)",
    border: "1px solid rgba(45,108,223,.3)",
    borderRadius: 6,
    padding: "7px 8px"
  },
  keyImportRow: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
  proxyJumpSection: { display: "flex", flexDirection: "column", gap: 6 },
  proxyJumpToggle: { background: "transparent", border: "none", color: "#9aa3af", fontSize: 12, cursor: "pointer", textAlign: "left", padding: 0 },
  proxyJumpList: { display: "flex", flexDirection: "column", gap: 4, padding: "6px 0" },
  proxyJumpRow: { display: "flex", gap: 4 },
  sshConfigRow: { flex: "none" },
  batchSection: { display: "flex", flexDirection: "column", gap: 6, padding: "8px 0", borderTop: "1px solid #262b33" },
  batchTitle: { fontSize: 12, color: "#9aa3af" },
  batchList: { display: "flex", flexDirection: "column", gap: 4, maxHeight: 120, overflowY: "auto" },
  batchItem: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#d7dbe2", cursor: "pointer" },
  hiddenFileInput: { display: "none" },
  keyImportHint: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "#8b93a1" },
  dialogActions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  btnPrimary: {
    background: "#2d6cdf",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 13,
    cursor: "pointer"
  },
  btnSecondary: {
    background: "transparent",
    color: "#d7dbe2",
    border: "1px solid #3a414b",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 13,
    cursor: "pointer"
  }
};
