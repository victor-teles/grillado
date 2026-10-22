import { readFileSync } from "node:fs";
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
console.log("built dist/cli.js");
