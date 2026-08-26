/**
 * dsh-ops-workspace — Host half.
 * Creates ~/.dsh/dsh-ops and registers it as the fixed「运维」workspace.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "ops-workspace";

export const inject = ["workspaceRegistry"];

const OPS_DIR = "dsh-ops";
const OPS_TITLE = "运维";

function resolveOpsPath() {
  const fromEnv = process.env.DSH_HOME;
  const dshHome =
    typeof fromEnv === "string" && fromEnv.trim().length > 0
      ? fromEnv.trim()
      : join(homedir(), ".dsh");
  return join(dshHome, OPS_DIR);
}

function logInfo(ctx, message) {
  if (ctx.logger?.info) ctx.logger.info(message);
  else console.info(message);
}

function logWarn(ctx, message) {
  if (ctx.logger?.warn) ctx.logger.warn(message);
  else console.warn(message);
}

export function apply(ctx) {
  ctx.effect(() => {
    let cancelled = false;
    (async () => {
      const opsPath = resolveOpsPath();
      await mkdir(opsPath, { recursive: true });
      if (cancelled) return;
      const workspace = await ctx.workspaceRegistry.create(opsPath, OPS_TITLE);
      if (cancelled) return;
      if (workspace.title !== OPS_TITLE && typeof workspace.setTitle === "function") {
        try {
          await workspace.setTitle(OPS_TITLE);
        } catch {
          // Keep existing title on conflict / offline.
        }
      }
      logInfo(ctx, `[ops-workspace] ready at ${opsPath} (${workspace.id})`);
    })().catch((error) => {
      const message = error?.message ?? String(error);
      logWarn(ctx, `[ops-workspace] ensure failed: ${message}`);
    });
    return () => {
      cancelled = true;
    };
  }, "ops-workspace: ensure fixed workspace on host");
}
