/**
 * Build the host faces (service entry + typert/remote artifacts) as ESM for
 * Node. @deepseek-ai/* stay external (resolved from the profile / harness
 * workspace at runtime); zod is bundled so the plugin pins its own copy.
 * DB drivers stay external: their internal require("node:buffer") etc. breaks
 * when esbuild rewrites CJS to ESM.
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [
    resolve(rootDir, "src/index.js"),
    resolve(rootDir, "src/typert.js"),
    resolve(rootDir, "src/remote.js"),
  ],
  outdir: resolve(rootDir, "lib"),
  format: "esm",
  platform: "node",
  target: "node20",
  bundle: true,
  sourcemap: false,
  external: ["@deepseek-ai/*", "mysql2", "pg", "redis", "mongodb"],
  logLevel: "info",
});

for (const file of ["index.js", "typert.js", "remote.js"]) {
  const path = resolve(rootDir, "lib", file);
  writeFileSync(path, readFileSync(path, "utf8").replace(/[ \t]+$/gm, ""), "utf8");
}
console.log("build-host: wrote lib/index.js, lib/typert.js, lib/remote.js");
