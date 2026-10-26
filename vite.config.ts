import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { thirdPartyLicenses } from "./scripts/licenses-plugin";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss(), thirdPartyLicenses()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "web/src"),
      // Keep EPL-2.0 elkjs out of the bundle (see web/src/vendor/elk-stub.js).
      "elkjs/lib/elk.bundled.js": path.resolve(import.meta.dirname, "web/src/vendor/elk-stub.js"),
    },
  },
  build: { outDir: "../dist/web", emptyOutDir: true, sourcemap: false },
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:4747" } },
});
