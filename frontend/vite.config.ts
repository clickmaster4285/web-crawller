import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";


function readBackendPort(): string {
  try {
    const envPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../backend/.env",
    );
    const env = readFileSync(envPath, "utf8");
    const match = env.match(/^PORT\s*=\s*"?(\d+)"?\s*$/m);
    if (match) return match[1];
  } catch {
    // backend/.env missing (fresh clone) — fall back to the historical default.
  }
  return "3000";
}

const backendPort = readBackendPort();

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
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: true,
      },
    },
  },
  define: {
    // Injected at dev/build time so the server-function fallback in
    // lib/crawl.ts / server.ts uses the same backend/.env PORT.
    __BACKEND_PORT__: JSON.stringify(backendPort),
  },
});
