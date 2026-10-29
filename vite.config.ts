import { defineConfig } from "vite";

// Dev server is fixed to 1420 (Tauri's devUrl). Assets are emitted with stable
// names where pdf.js needs to locate its worker.
export default defineConfig({
  root: "ui",
  publicDir: "public",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  worker: { format: "es" },
});
