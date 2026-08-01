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
    host: true,
    port: 8080,
    strictPort: true,
    // Proxy API calls to the Express backend (port 3000). The frontend
    // always talks to `/api/*` same-origin; Vite forwards to the backend.
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
