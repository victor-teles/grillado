import { chmodSync, cpSync, readFileSync, rmSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/cli/main.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  legalComments: "eof",
  banner: { js: "#!/usr/bin/env node" },
  define: { __GRILLADO_VERSION__: JSON.stringify(pkg.version) },
});
chmodSync("dist/cli.js", 0o755);
// Plan 004: the skills `grillado skills get` serves ship next to the CLI, so they match its version.
rmSync("dist/skill-data", { recursive: true, force: true });
cpSync("skill-data", "dist/skill-data", { recursive: true });
console.log("built dist/cli.js");
