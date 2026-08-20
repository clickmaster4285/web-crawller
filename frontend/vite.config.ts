import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// TanStack Start + file-based routing. Pages live in `src/pages` (the routes
// directory), so each page folder/file maps 1:1 to a URL. The Start plugin
// owns route-tree generation, configured here through `router`.
export default defineConfig({
  plugins: [
    tanstackStart({
      router: {
        routesDirectory: "pages",
        generatedRouteTree: "routeTree.gen.ts",
      },
    }),
    viteReact(),
    tailwindcss(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    host: "0.0.0.0",
    port: 3012,
    strictPort: true,
    allowedHosts: ["pricefinderai.clickmasters.pk"],
    // Proxy API calls to the Express backend (port 3011 — keep in sync with
    // backend/.env PORT and lib/crawl.ts + server.ts fallbacks). The frontend
    // always talks to `/api/*` same-origin; Vite forwards to the backend.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3011",
        changeOrigin: true,
      },
    },
  },
});
