/**
 * Sidebar active SSH connection picker — between New Session and Workspaces.
 * Visual contract mirrors the New Session elevated button + ui-primitives Menu
 * (PermissionSelect / WorkspacePickFlow). Ops ModuleLoader bundles cannot
 * require @deepseek-ai/dsh-client-ui-primitives, so tokens are applied locally.
 */
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import {
  connectionLabel,
  switchActiveConnection,
  useActiveConnection,
} from "./activeConnection.js";

const HOST_ATTR = "data-dsh-ssh-active-conn";
const WORKSPACE_SLOT = '[data-slot="sidebar.workspaces"]';
const SIDEBAR_SLOT = '[data-slot="sidebar"]';

function findAppFrame() {
  const sidebar = typeof document !== "undefined" ? document.querySelector(SIDEBAR_SLOT) : null;
  return sidebar?.parentElement?.parentElement ?? null;
}

function useSidebarExpanded() {
  return React.useSyncExternalStore(
    (onStoreChange) => {
      if (typeof document === "undefined") return () => {};
      let frame = null;
      let mo = null;
      function bind() {
        frame = findAppFrame();
        if (!frame) return;
        mo = new MutationObserver(onStoreChange);
        mo.observe(frame, { attributes: true, attributeFilter: ["data-sidebar-collapsed"] });
        onStoreChange();
      }
      bind();
      if (!frame) {
        const wait = new MutationObserver(() => {
          if (findAppFrame()) {
            wait.disconnect();
            bind();
          }
        });
        wait.observe(document.body, { childList: true, subtree: true });
        return () => {
          wait.disconnect();
          mo?.disconnect();
        };
      }
      return () => {
        mo?.disconnect();
      };
    },
    () => {
      const frame = findAppFrame();
      if (!frame) return true;
      return !frame.hasAttribute("data-sidebar-collapsed");
    },
  );
}

function ChevronIcon({ open }) {
  return React.createElement(
    "svg",
    {
      width: 14,
      height: 14,
      viewBox: "0 0 14 14",
      fill: "none",
      "aria-hidden": true,
      style: { transform: open ? "rotate(180deg)" : undefined, transition: "transform 120ms ease" },
    },
    React.createElement("path", {
      d: "M3.5 5.25L7 8.75L10.5 5.25",
      stroke: "currentColor",
      strokeWidth: 1.5,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    }),
  );
}

function CheckIcon() {
  return React.createElement(
    "svg",
    { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
    React.createElement("path", {
      d: "M3.5 8.5L6.5 11.5L12.5 4.5",
      stroke: "currentColor",
      strokeWidth: 1.5,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    }),
  );
}

function ServerIcon({ size = 16 }) {
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
    React.createElement("rect", { x: 2, y: 2, width: 20, height: 8, rx: 2 }),
    React.createElement("rect", { x: 2, y: 14, width: 20, height: 8, rx: 2 }),
    React.createElement("line", { x1: 6, y1: 6, x2: 6.01, y2: 6 }),
    React.createElement("line", { x1: 6, y1: 18, x2: 6.01, y2: 18 }),
  );
}

function ensurePickerCss() {
  if (typeof document === "undefined") return;
  const CSS_VER = "3";
  let style = document.querySelector('[data-dsh-ssh-active-conn-css]');
  if (style && style.getAttribute("data-dsh-ssh-active-conn-css") === CSS_VER) return;
  if (!style) {
    style = document.createElement("style");
    document.head.appendChild(style);
  }
  style.setAttribute("data-dsh-ssh-active-conn-css", CSS_VER);
  // Match SidebarRoot .newSession geometry exactly (38×, pad 8/16, r12, margin 0 2px 8px).
  style.textContent = [
    "[data-dsh-ssh-active-conn]{flex:none;margin:0 2px 8px;min-width:0;align-self:stretch;box-sizing:border-box}",
    ".dsc-root{position:relative;display:flex;flex-direction:column;width:100%;min-width:0}",
    ".dsc-trigger{display:flex;align-items:center;justify-content:flex-start;gap:6px;width:100%;height:38px;padding:8px 16px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;font-family:var(--dsw-font-family,inherit);cursor:pointer;overflow:hidden;text-align:left}",
    ".dsc-trigger:hover:not(:disabled):not(.dsc-trigger-empty):not(.dsc-trigger-static){background:var(--dsw-alias-button-floating-hover)}",
    ".dsc-trigger:disabled{opacity:.55;cursor:default}",
    ".dsc-trigger-icon{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}",
    ".dsc-trigger-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".dsc-trigger-chevron{display:inline-flex;flex:none;color:var(--dsw-alias-label-caption,#8b93a1)}",
    ".dsc-trigger-static{cursor:default}",
    ".dsc-trigger-static:hover{background:var(--dsw-alias-button-elevated-fill)}",
    ".dsc-trigger-empty{color:var(--dsw-alias-label-secondary,#9aa3b2);cursor:default}",
    ".dsc-trigger-empty:hover{background:var(--dsw-alias-button-elevated-fill)}",
    ".dsc-trigger-empty .dsc-trigger-icon{color:var(--dsw-alias-label-caption,#8b93a1)}",
    ".dsc-menu{box-sizing:border-box;position:fixed;z-index:1100;min-width:218px;max-width:360px;padding:4px;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-inverted,var(--dsw-alias-border-l2));border-radius:12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay,#fff));box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.18));color:var(--dsw-alias-label-primary)}",
    ".dsc-item{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:none;border-radius:10px;background:transparent;cursor:pointer;font-size:14px;line-height:22px;font-family:inherit;color:inherit;text-align:left}",
    ".dsc-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
    ".dsc-item-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".dsc-item-check{display:inline-flex;flex:none;width:16px;height:16px;color:var(--dsw-alias-state-business-primary,#4f8cff)}",
    "[data-sidebar-collapsed] [data-dsh-ssh-active-conn]{align-self:flex-start;width:36px;margin:0 0 12px}",
    "[data-sidebar-collapsed] [data-dsh-ssh-active-conn] .dsc-trigger{width:36px;height:36px;padding:0;justify-content:center;gap:0;border-color:transparent;background:transparent;border-radius:8px}",
    "[data-sidebar-collapsed] [data-dsh-ssh-active-conn] .dsc-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
    "[data-sidebar-collapsed] [data-dsh-ssh-active-conn] .dsc-trigger-label,[data-sidebar-collapsed] [data-dsh-ssh-active-conn] .dsc-trigger-chevron{display:none}",
    "[data-sidebar-collapsed] [data-dsh-ssh-active-conn] .dsc-trigger-icon{color:var(--dsw-alias-label-primary)}",
    "[data-sidebar-collapsed] [data-dsh-ssh-active-conn] .dsc-trigger-empty .dsc-trigger-icon{color:var(--dsw-alias-label-caption,#8b93a1)}",
  ].join("");
}

function ConnectionMenu({ open, anchorRect, connections, activeConnectionId, onSelect, onClose }) {
  const listRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return undefined;
    function onDoc(ev) {
      if (listRef.current && listRef.current.contains(ev.target)) return;
      onClose();
    }
    function onKey(ev) {
      if (ev.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open || !anchorRect) return null;

  const style = {
    left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - 226)),
    top: anchorRect.bottom + 4,
    width: Math.max(218, anchorRect.width),
  };

  return ReactDOM.createPortal(
    React.createElement(
      "div",
      { ref: listRef, className: "dsc-menu", role: "listbox", style },
      connections.map((c) => {
        const selected = c.connectionId === activeConnectionId;
        return React.createElement(
          "button",
          {
            key: c.connectionId,
            type: "button",
            role: "option",
            "aria-selected": selected,
            className: "dsc-item",
            onClick: () => onSelect(c.connectionId),
          },
          React.createElement("span", { className: "dsc-trigger-icon" }, React.createElement(ServerIcon, { size: 16 })),
          React.createElement("span", { className: "dsc-item-label" }, connectionLabel(c)),
          selected ? React.createElement("span", { className: "dsc-item-check" }, React.createElement(CheckIcon)) : React.createElement("span", { className: "dsc-item-check" }),
        );
      }),
    ),
    document.body,
  );
}

export function SidebarActiveConnection({ api }) {
  const state = useActiveConnection(api);
  const expanded = useSidebarExpanded();
  const { connections, activeConnectionId, busy } = state;
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef(null);
  const [anchorRect, setAnchorRect] = React.useState(null);

  React.useEffect(() => {
    if (!open) return undefined;
    function place() {
      setAnchorRect(triggerRef.current?.getBoundingClientRect() ?? null);
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const empty = connections.length === 0;
  const active = empty ? null : (connections.find((c) => c.connectionId === activeConnectionId) ?? connections[0]);
  const label = empty ? "尚未连接服务器" : connectionLabel(active);
  const hint = empty ? "请先在设置 → SSH 资源中连接服务器" : label;
  const canSwitch = connections.length >= 2 && !busy;
  const triggerClass =
    "dsc-trigger"
    + (empty ? " dsc-trigger-empty" : "")
    + (!empty && !canSwitch ? " dsc-trigger-static" : "");

  return React.createElement(
    "div",
    { className: "dsc-root" },
    React.createElement(
      "button",
      {
        ref: triggerRef,
        type: "button",
        className: triggerClass,
        title: hint,
        "aria-label": empty ? hint : "当前 SSH 服务器",
        "aria-haspopup": canSwitch ? "listbox" : undefined,
        "aria-expanded": canSwitch ? open : undefined,
        disabled: busy,
        onClick: () => {
          if (!canSwitch) return;
          setOpen((v) => !v);
        },
      },
      React.createElement("span", { className: "dsc-trigger-icon" }, React.createElement(ServerIcon, { size: expanded ? 16 : 18 })),
      React.createElement("span", { className: "dsc-trigger-label" }, label),
      canSwitch
        ? React.createElement("span", { className: "dsc-trigger-chevron" }, React.createElement(ChevronIcon, { open }))
        : null,
    ),
    React.createElement(ConnectionMenu, {
      open: open && canSwitch,
      anchorRect,
      connections,
      activeConnectionId: active?.connectionId,
      onClose: () => setOpen(false),
      onSelect: (connectionId) => {
        setOpen(false);
        switchActiveConnection(api, connectionId).catch(() => { /* ignore */ });
      },
    }),
  );
}

/** Module singleton — HMR / double apply must not leave two pickers. */
let pickerMount = null;

export function mountSidebarActiveConnection(ctx, api) {
  ensurePickerCss();
  ctx.effect(() => {
    let host = null;
    let root = null;
    let observer = null;

    function unmount() {
      if (pickerMount && pickerMount.host === host) pickerMount = null;
      root?.unmount();
      root = null;
      host?.remove();
      host = null;
    }

    function tryMount() {
      if (host) return true;
      const workspaces = document.querySelector(WORKSPACE_SLOT);
      const regionArea = workspaces?.parentElement;
      const sidebar = regionArea?.parentElement;
      if (!regionArea || !sidebar) return false;

      // Drop orphan hosts from previous mounts / races.
      for (const el of document.querySelectorAll(`[${HOST_ATTR}]`)) {
        if (pickerMount && el === pickerMount.host) continue;
        el.remove();
      }
      if (pickerMount?.host && document.contains(pickerMount.host)) {
        host = pickerMount.host;
        root = pickerMount.root;
        root.render(React.createElement(SidebarActiveConnection, { api }));
        return true;
      }

      host = document.createElement("div");
      host.setAttribute(HOST_ATTR, "");
      sidebar.insertBefore(host, regionArea);
      root = ReactDOMClient.createRoot(host);
      root.render(React.createElement(SidebarActiveConnection, { api }));
      pickerMount = { host, root };
      return true;
    }

    if (!tryMount()) {
      observer = new MutationObserver(() => {
        if (tryMount()) observer?.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    return () => {
      observer?.disconnect();
      unmount();
    };
  }, "ssh-connection: sidebar active picker");
}
