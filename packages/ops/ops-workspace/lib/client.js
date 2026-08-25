/**
 * dsh-ops-workspace — browser half.
 *
 * - Host ensures ~/.dsh/dsh-ops (title「运维」); this half waits for it.
 * - Hide「添加工作区」UI only (Host directoryPicker stays mounted).
 * - Pin「新会话」to the ops workspace.
 * - On boot: if no usable current session, open the newest non-archived
 *   session in ops workspace; only mint a blank via connectWorkspace when
 *   none exist. Never force a blank over existing history.
 */
window.__ModuleLoader__.load({
  id: "dsh-ops-workspace",
  factory: function (require) {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;

    var OPS_DIR = "dsh-ops";
    var OPS_TITLE = "运维";
    var VIEW_PERSIST_KEY = "dsh.workspace.view.v5";

    function basename(path) {
      if (!path) return "";
      var parts = String(path).replace(/[\\/]+$/, "").split(/[/\\]/);
      return parts[parts.length - 1] || "";
    }

    function isOpsWorkspace(workspace) {
      if (!workspace) return false;
      var normalized = String(workspace.path || "").replace(/\\/g, "/");
      if (normalized.indexOf("/.dsh/" + OPS_DIR) !== -1) return true;
      if (basename(workspace.path) === OPS_DIR) return true;
      return workspace.title === OPS_TITLE;
    }

    function pickOpsWorkspace(items) {
      var preferred = null;
      var fallback = null;
      for (var i = 0; i < (items || []).length; i++) {
        var w = items[i];
        if (!isOpsWorkspace(w)) continue;
        var normalized = String(w.path || "").replace(/\\/g, "/");
        if (normalized.indexOf("/.dsh/" + OPS_DIR) !== -1) preferred = w;
        else if (!fallback) fallback = w;
      }
      return preferred || fallback;
    }

    function waitBaselines(workspaces, timeoutMs) {
      return new Promise(function (resolve, reject) {
        var snap = workspaces.list.getSnapshot();
        if (snap.baselinesReady) {
          resolve(snap);
          return;
        }
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          unsub();
          reject(new Error("workspace baselines not ready"));
        }, timeoutMs || 60000);
        var unsub = workspaces.list.subscribe(function () {
          var next = workspaces.list.getSnapshot();
          if (!next.baselinesReady || done) return;
          done = true;
          clearTimeout(timer);
          unsub();
          resolve(next);
        });
      });
    }

    function waitForOpsWorkspace(workspaces, timeoutMs) {
      return new Promise(function (resolve, reject) {
        function check() {
          return pickOpsWorkspace(workspaces.list.getSnapshot().items || []);
        }
        var existing = check();
        if (existing) {
          resolve(existing);
          return;
        }
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          unsub();
          reject(new Error("ops workspace not registered yet"));
        }, timeoutMs || 60000);
        var unsub = workspaces.list.subscribe(function () {
          if (done) return;
          var found = check();
          if (!found) return;
          done = true;
          clearTimeout(timer);
          unsub();
          resolve(found);
        });
      });
    }

    function forceFlatSessionView() {
      try {
        var raw = localStorage.getItem(VIEW_PERSIST_KEY);
        var state = raw ? JSON.parse(raw) : {};
        if (!state || typeof state !== "object") state = {};
        state.groupBy = "flat";
        if (!state.orderBy) state.orderBy = "updated";
        if (!state.groupExpansion) state.groupExpansion = {};
        if (!state.sessionOrderByAccount) state.sessionOrderByAccount = {};
        if (!state.sessionUpdatedAtByAccount) state.sessionUpdatedAtByAccount = {};
        localStorage.setItem(VIEW_PERSIST_KEY, JSON.stringify(state));
      } catch (err) { /* ignore */ }
    }

    function ensureCss() {
      if (typeof document === "undefined") return;
      var ver = "6";
      var style = document.querySelector("[data-dsh-ops-workspace-css]");
      if (style && style.getAttribute("data-dsh-ops-workspace-css") === ver) return;
      if (!style) {
        style = document.createElement("style");
        document.head.appendChild(style);
      }
      style.setAttribute("data-dsh-ops-workspace-css", ver);
      style.textContent = [
        'button[aria-label="添加工作区"],',
        'button[aria-label="Add workspace"],',
        'button[aria-label="添加工作区…"],',
        'button[aria-label="Add workspace…"]{display:none!important}',
        '[data-slot="sidebar.workspaces"] button[aria-label^="工作区“"],',
        '[data-slot="sidebar.workspaces"] button[aria-label^="Workspace actions"]{display:none!important}',
        'button[aria-label="选择工作区"],',
        'button[aria-label="Choose workspace"]{pointer-events:none!important;cursor:default!important}',
        'button[aria-label="选择工作区"] svg:last-of-type,',
        'button[aria-label="Choose workspace"] svg:last-of-type{display:none!important}',
        '[data-slot="conversation.hero.workspace"]{display:none!important}',
      ].join("");
    }

    function hideAddMenusByText() {
      if (typeof document === "undefined") return;
      var labels = ["添加工作区", "添加工作区…", "Add workspace", "Add workspace…"];
      var nodes = document.querySelectorAll('[role="menuitem"], button');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var text = (el.getAttribute("aria-label") || el.textContent || "").trim();
        for (var j = 0; j < labels.length; j++) {
          if (text === labels[j] || text.indexOf(labels[j]) === 0) {
            el.style.setProperty("display", "none", "important");
            break;
          }
        }
      }
    }

    function watchAndHideAddUi() {
      ensureCss();
      hideAddMenusByText();
      if (typeof MutationObserver === "undefined" || typeof document === "undefined") {
        return function () {};
      }
      var observer = new MutationObserver(function () {
        ensureCss();
        hideAddMenusByText();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      return function () { observer.disconnect(); };
    }

    /** Newest non-archived session in the ops workspace, or null. */
    function pickRecentOpsSession(workspaces, sessions, workspace) {
      var archived = workspaces.list.getSnapshot().archivedSessionIds || [];
      var byId = sessions.list.getSnapshot().byId || {};
      var bestId = null;
      var bestTime = Number.NEGATIVE_INFINITY;
      var ids = workspace.sessionIds || [];
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        if (archived.indexOf(id) >= 0) continue;
        var summary = byId[id];
        if (!summary) continue;
        var t = typeof summary.updatedAt === "number" ? summary.updatedAt : 0;
        if (t >= bestTime) {
          bestTime = t;
          bestId = id;
        }
      }
      return bestId;
    }

    function currentIsInOps(workspaces, sessions, opsWorkspaceId) {
      var current = sessions.list.getSnapshot().current;
      if (!current) return false;
      var archived = workspaces.list.getSnapshot().archivedSessionIds || [];
      if (archived.indexOf(current) >= 0) return false;
      var items = workspaces.list.getSnapshot().items || [];
      for (var i = 0; i < items.length; i++) {
        var w = items[i];
        if (w.workspaceId !== opsWorkspaceId) continue;
        return (w.sessionIds || []).indexOf(current) >= 0;
      }
      return false;
    }

    async function ensureOpsSessionOpen(workspaces, sessions, workspace) {
      if (currentIsInOps(workspaces, sessions, workspace.workspaceId)) {
        return sessions.list.getSnapshot().current;
      }
      var recent = pickRecentOpsSession(workspaces, sessions, workspace);
      if (recent) {
        sessions.open(recent);
        return recent;
      }
      var sessionId = await workspaces.connectWorkspace(workspace.workspaceId);
      sessions.open(sessionId);
      return sessionId;
    }

    var name = "ops-workspace";
    var inject = ["workspaces", "sessions"];

    function apply(ctx) {
      forceFlatSessionView();
      var stopHide = watchAndHideAddUi();

      var workspaces = ctx.workspaces;
      var sessions = ctx.sessions;
      if (!workspaces || !sessions) {
        console.warn("[ops-workspace] workspaces/sessions unavailable — plugin inactive");
        return function () { stopHide(); };
      }

      var opsWorkspaceId = null;
      var originalStart = workspaces.startSession.bind(workspaces);

      ctx.effect(function () {
        var cancelled = false;
        var restoreStart = null;

        (async function () {
          await waitBaselines(workspaces);
          if (cancelled) return;

          var workspace = await waitForOpsWorkspace(workspaces);
          if (cancelled) return;

          opsWorkspaceId = workspace.workspaceId;
          workspaces.startSession = function () {
            originalStart(opsWorkspaceId);
          };
          restoreStart = function () {
            workspaces.startSession = originalStart;
          };

          await ensureOpsSessionOpen(workspaces, sessions, workspace);
          console.info("[ops-workspace] session ready:", workspace.path);
        })().catch(function (err) {
          console.warn("[ops-workspace] open failed:", err && err.message ? err.message : err);
        });

        return function () {
          cancelled = true;
          if (restoreStart) restoreStart();
        };
      }, "ops-workspace: open fixed workspace session");

      return function () {
        stopHide();
      };
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return exports;
  },
});
