import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import path from "path";

// The dashboard is prebuilt and shipped inside the npm package (§7.5), the
// same way templates/ is — so it stays offline-capable and version-locked
// with no CDN. Relative base so it works on any OS-assigned port.
export default defineConfig({
  root: path.resolve(import.meta.dirname, "ui"),
  base: "./",
  plugins: [react(), tailwind()],
  // React's API, Preact's size: the bundle drops from ~248 kB to ~50 kB with
  // no source changes. Nothing here needs React internals, and the components
  // stay plain React so the Next.js site (§7.6) can use them as-is.
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
      "react-dom/client": "preact/compat/client",
      "react/jsx-runtime": "preact/jsx-runtime",
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/dashboard"),
    emptyOutDir: true,
    // One JS and one CSS file keeps the server's static handler trivial.
    rollupOptions: { output: { entryFileNames: "app.js", assetFileNames: "app[extname]" } },
  },
});
