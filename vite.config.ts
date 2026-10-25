import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "web/src") } },
  build: { outDir: "../dist/web", emptyOutDir: true, sourcemap: false },
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:4747" } },
});
