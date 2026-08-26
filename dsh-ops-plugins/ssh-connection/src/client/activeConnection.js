/**
 * Shared active SSH connection state for browser plugins.
 * The sidebar picker owns writes; ssh-ops / ssh-monitor subscribe via event or
 * window.__dshSshActiveConnection.
 */
import * as React from "react";
import { useSyncExternalStore } from "react";

export const ACTIVE_CHANGED_EVENT = "dsh-ssh-connection:active-changed";

const listeners = new Set();

let snapshot = {
  connections: [],
  activeConnectionId: null,
  busy: false,
};

function emit() {
  for (const listener of listeners) listener();
}

export function getActiveConnectionSnapshot() {
  return snapshot;
}

export function subscribeActiveConnection(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function patch(next) {
  snapshot = { ...snapshot, ...next };
  emit();
}

export function connectionLabel(connection) {
  if (!connection) return "";
  return connection.name || `${connection.username}@${connection.host}`;
}

/** Prefer unique ids; if the same profile was connected twice, keep one. */
function dedupeConnections(connections) {
  const byId = new Map();
  for (const c of connections || []) {
    if (!c?.connectionId || byId.has(c.connectionId)) continue;
    byId.set(c.connectionId, c);
  }
  const byProfile = new Map();
  const result = [];
  for (const c of byId.values()) {
    const key = c.profileId || `${c.username}@${c.host}:${c.port}`;
    if (byProfile.has(key)) continue;
    byProfile.set(key, c);
    result.push(c);
  }
  return result;
}

export async function refreshActiveConnections(api) {
  const listed = await api.list();
  const connections = dedupeConnections(listed.connections);
  let activeConnectionId = listed.activeConnectionId ?? null;
  if (activeConnectionId && !connections.some((c) => c.connectionId === activeConnectionId)) {
    activeConnectionId = connections[0]?.connectionId ?? null;
  }
  patch({ connections, activeConnectionId });
  return { ...listed, connections, activeConnectionId };
}

export async function switchActiveConnection(api, connectionId) {
  if (!connectionId || connectionId === snapshot.activeConnectionId || snapshot.busy) return;
  patch({ busy: true });
  try {
    await api.setActive(connectionId);
    patch({ activeConnectionId: connectionId });
    window.dispatchEvent(new CustomEvent(ACTIVE_CHANGED_EVENT, { detail: { connectionId } }));
  } finally {
    patch({ busy: false });
  }
}

export function useActiveConnection(api) {
  useSyncExternalStore(subscribeActiveConnection, getActiveConnectionSnapshot);

  // Poll connection list; the picker is the single writer for setActive.
  React.useEffect(() => {
    let cancelled = false;
    function tick() {
      refreshActiveConnections(api).catch(() => { /* ignore */ });
    }
    tick();
    const timer = setInterval(tick, 5000);
    function onActive(ev) {
      if (ev?.detail?.connectionId) {
        patch({ activeConnectionId: ev.detail.connectionId });
      }
      tick();
    }
    window.addEventListener(ACTIVE_CHANGED_EVENT, onActive);
    window.addEventListener("dsh-ssh-connection:connected", tick);
    window.addEventListener("dsh-ssh-connection:disconnected", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener(ACTIVE_CHANGED_EVENT, onActive);
      window.removeEventListener("dsh-ssh-connection:connected", tick);
      window.removeEventListener("dsh-ssh-connection:disconnected", tick);
    };
  }, [api]);

  return snapshot;
}

// Cross-bundle read API for plain JS clients (ssh-monitor).
if (typeof window !== "undefined") {
  window.__dshSshActiveConnection = {
    getSnapshot: getActiveConnectionSnapshot,
    subscribe: subscribeActiveConnection,
  };
}
