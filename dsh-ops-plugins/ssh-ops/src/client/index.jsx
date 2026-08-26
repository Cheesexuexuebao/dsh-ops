/**
 * dsh-ssh-ops browser plugin entry: mounts the sshOps Remote contribution,
 * then registers the sidebar footer action (open/close the SSH panel) and the
 * right-side floating panel itself.
 */
import * as React from "react";
import { createSshApi } from "./api.js";
import { SshPanel } from "./SshPanel.jsx";
import { getSshUiSnapshot, sshUiSetActive, sshUiSetConnections, sshUiSetError, sshUiSetOpen, useSshUi } from "./store.js";
import TYPERT_REMOTE from "../remote.js";

const NS = "ssh-ops";

export const inject = ["remote", "slots", "locale", "connection"];

let cssInjected = false;
function ensureTriggerCss() {
  if (cssInjected || typeof document === "undefined") return;
  cssInjected = true;
  const style = document.createElement("style");
  style.setAttribute("data-dsh-ssh-ops-trigger", "");
  style.textContent = [
    ".dso-trigger{display:flex;align-items:center;gap:8px;width:100%;background:transparent;border:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#9aa3b2);padding:7px 10px;border-radius:8px;font-size:13px;font-family:var(--dsw-font-family,inherit);transition:color .15s ease,background .15s ease}",
    ".dso-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#e7eaf0)}",
    ".dso-trigger-active{color:var(--dsw-alias-label-primary,#e7eaf0)}",
    ".dso-trigger-rail{width:auto;justify-content:center;padding:7px}",
    ".dso-trigger-label{white-space:nowrap}",
  ].join("");
  document.head.appendChild(style);
}

/** Terminal glyph — ui-primitives has no Terminal; same inline-SVG style as ssh-monitor. */
function TerminalIcon({ size = 16 }) {
  return React.createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
    },
    React.createElement("polyline", { points: "4 17 10 11 4 5" }),
    React.createElement("line", { x1: "12", y1: "19", x2: "20", y2: "19" })
  );
}

export async function apply(ctx) {
  const disposers = [];
  try {
    const dispose = await ctx.remote.$mount(TYPERT_REMOTE);
    if (typeof dispose === "function") disposers.push(dispose);
  } catch (error) {
    for (const d of disposers.reverse()) await d();
    throw error;
  }

  const api = createSshApi(ctx);
  ensureTriggerCss();

  ctx.locale.register(NS, {
    zh: {
      sshAction: "SSH 终端",
      sshActionClose: "关闭 SSH 终端",
    },
    en: {
      sshAction: "SSH Terminal",
      sshActionClose: "Close SSH terminal",
    },
  });

  // Same seat as SSH 监控. Use slot-provided `t` (locale: NS) — do not call
  // ctx.locale.t(ns, key); that API is not what the locale service exposes and
  // crashing the inject/render path hides this footer action entirely.
  disposers.push(
    ctx.slots.inject("sidebar.footer.action", () =>
      ctx.slots.register(
        {
          name: "sidebar.footer.action",
          id: "ssh-ops-footer-action",
          order: 1,
          locale: NS,
          label: "SSH 终端",
        },
        SshFooterAction
      )
    )
  );

  disposers.push(
    ctx.slots.inject("shell.overlay", () =>
      ctx.slots.register(
        {
          name: "shell.overlay",
          id: "ssh-ops-panel",
          order: 100,
          locale: NS,
          inject: () => ({ api }),
        },
        SshPanel
      )
    )
  );

  const onConnectionConnected = async (event) => {
    const detail = event?.detail;
    if (!detail?.connectionId) return;
    try {
      const listed = await api.list();
      sshUiSetConnections(listed.connections);
      sshUiSetActive(detail.connectionId, null);
      sshUiSetError(null);
      if (detail.openTerminal === true) {
        sshUiSetOpen(true);
      }
    } catch (cause) {
      sshUiSetError(cause?.message ?? String(cause));
    }
  };
  const onConnectionDisconnected = async (event) => {
    const detail = event?.detail;
    try {
      const listed = await api.list();
      sshUiSetConnections(listed.connections);
      const snap = getSshUiSnapshot();
      if (detail?.connectionId && snap.activeConnectionId === detail.connectionId) {
        sshUiSetActive(listed.activeConnectionId ?? null, null);
      }
    } catch { /* ignore */ }
  };
  window.addEventListener("dsh-ssh-connection:connected", onConnectionConnected);
  window.addEventListener("dsh-ssh-connection:disconnected", onConnectionDisconnected);
  const onActiveChanged = async (event) => {
    const connectionId = event?.detail?.connectionId;
    if (!connectionId) return;
    try {
      const snap = getSshUiSnapshot();
      if (snap.activeSessionId) {
        await api.closeSession(snap.activeSessionId);
      }
      const listed = await api.list();
      sshUiSetConnections(listed.connections);
      sshUiSetActive(connectionId, null);
      sshUiSetError(null);
    } catch (cause) {
      sshUiSetError(cause?.message ?? String(cause));
    }
  };
  window.addEventListener("dsh-ssh-connection:active-changed", onActiveChanged);
  disposers.push(() => window.removeEventListener("dsh-ssh-connection:connected", onConnectionConnected));
  disposers.push(() => window.removeEventListener("dsh-ssh-connection:disconnected", onConnectionDisconnected));
  disposers.push(() => window.removeEventListener("dsh-ssh-connection:active-changed", onActiveChanged));

  document.querySelectorAll('[data-dsh-ssh-ops-tab="true"]').forEach((el) => el.remove());

  return async () => {
    for (const d of disposers.reverse()) {
      if (typeof d === "function") await d();
    }
  };
}

/** Sidebar footer trigger — mirrors ssh-monitor MonitorTrigger. */
function SshFooterAction(props) {
  const ui = useSshUi();
  const wide = props.wide !== false;
  const open = !!ui.open;
  const t = typeof props.t === "function" ? props.t : (key) => key;
  const nameLabel = t("sshAction") || "SSH 终端";
  const title = open ? (t("sshActionClose") || "关闭 SSH 终端") : nameLabel;
  const isRail = !wide;
  const cls = "dso-trigger" + (isRail ? " dso-trigger-rail" : "") + (open ? " dso-trigger-active" : "");

  return React.createElement(
    "button",
    {
      type: "button",
      className: cls,
      title,
      "aria-label": title,
      "aria-pressed": open ? "true" : "false",
      onClick: () => sshUiSetOpen(!getSshUiSnapshot().open),
    },
    React.createElement(TerminalIcon, { size: 16 }),
    isRail ? null : React.createElement("span", { className: "dso-trigger-label" }, nameLabel)
  );
}
