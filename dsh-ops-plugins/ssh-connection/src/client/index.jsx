/**
 * dsh-ssh-connection browser entry: mounts sshConnection Remote and Settings
 * 「SSH 资源」tab.
 */
import * as React from "react";
import { createSshConnectionApi } from "./api.js";
import { SshResources } from "./SshResources.jsx";
import { mountSidebarActiveConnection } from "./SidebarActiveConnection.jsx";
import TYPERT_REMOTE from "../remote.js";

const NS = "ssh-connection";

export const inject = ["remote", "slots", "connection"];

export async function apply(ctx) {
  const disposers = [];
  try {
    const dispose = await ctx.remote.$mount(TYPERT_REMOTE);
    if (typeof dispose === "function") disposers.push(dispose);
  } catch (error) {
    for (const d of disposers.reverse()) await d();
    throw error;
  }

  const api = createSshConnectionApi(ctx);

  mountSidebarActiveConnection(ctx, api);

  ctx.slots.inject("settings.plugins.tab", () =>
    ctx.slots.register(
      {
        name: "settings.plugins.tab",
        id: "ssh-connection-resources",
        order: 80,
        label: "SSH 资源",
        locale: NS,
        inject: () => ({ api, credentials: ctx.connection?.api?.credentials })
      },
      SshResources
    )
  );

  return async () => {
    for (const d of disposers.reverse()) await d();
  };
}
