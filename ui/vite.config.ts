/** Builds the notebook UI as one IIFE bundle; scripts/build-notebook-ui.mjs inlines it. */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: new URL("../.ui-build", import.meta.url).pathname,
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    minify: true,
    lib: { entry: "main.tsx", formats: ["iife"], name: "NotebookUI", fileName: () => "app.js" },
  },
});
