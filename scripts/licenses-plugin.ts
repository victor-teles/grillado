// Vite plugin: writes dist/web/third-party-licenses.txt with the license text of every npm package
// that ends up in the web bundle (including lazily loaded chunks such as Mermaid's).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

function packageRoot(id: string): string | null {
  const i = id.lastIndexOf("/node_modules/");
  if (i === -1) return null;
  const rest = id.slice(i + "/node_modules/".length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  return path.join(id.slice(0, i), "node_modules", name);
}

export function thirdPartyLicenses(): Plugin {
  return {
    name: "grillado-third-party-licenses",
    apply: "build",
    generateBundle() {
      const roots = new Set<string>();
      for (const id of this.getModuleIds()) {
        const root = packageRoot(id.replace(/\\/g, "/").replace(/^\0/, ""));
        if (root && existsSync(path.join(root, "package.json"))) roots.add(root);
      }
      const entries = [...roots]
        .map((root) => {
          const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
          const file = readdirSync(root).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
          const text = file ? readFileSync(path.join(root, file), "utf8").trim() : `License: ${pkg.license ?? "see package"}`;
          return { name: `${pkg.name}@${pkg.version}`, license: String(pkg.license ?? ""), text };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const body = entries.map((e) => `${"=".repeat(72)}\n${e.name} (${e.license})\n${"=".repeat(72)}\n${e.text}\n`).join("\n");
      this.emitFile({ type: "asset", fileName: "third-party-licenses.txt", source: `Third-party packages bundled in Grillado's web UI.\n\n${body}` });
    },
  };
}
