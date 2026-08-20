import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

/**
 * Backend base URL for the `/api/*` browser proxy (Phase 5 prod deploy). In
 * dev the Vite server proxies `/api` to the backend, but the BUILT Nitro
 * server has no proxy — the browser calls `/api/*` against this same origin,
 * so the fetch handler must forward them to Express. Server functions
 * (`lib/crawl.ts`) use the same env var to call the backend directly.
 */
const backendUrl = () =>
  process.env.PARITY_BACKEND_URL ?? "http://localhost:3011";

type ServerEntry = {
  fetch: (
    request: Request,
    env: unknown,
    ctx: unknown,
  ) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(
  response: Response,
): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(
    consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`),
  );
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as {
      unhandled?: unknown;
      message?: unknown;
    };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

/**
 * Forwards a browser `/api/*` request to the Express backend, preserving the
 * method, body and headers (the JWT travels in the Authorization header, set
 * by `lib/http.ts` — it must pass through untouched). Streams the response
 * back so large payloads (catalogues, crawl results) aren't buffered twice.
 */
async function proxyToBackend(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = `${backendUrl()}${url.pathname}${url.search}`;
  const headers = new Headers(request.headers);
  // Host must point at the backend, not this origin.
  headers.set("host", new URL(backendUrl()).host);
  return fetch(target, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    // @ts-expect-error duplex is required when streaming a request body
    duplex: "half",
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      // Phase 5 prod deploy: browser `/api/*` calls hit this origin (the
      // Vite dev proxy only exists in dev). Forward them to Express.
      if (new URL(request.url).pathname.startsWith("/api")) {
        return await proxyToBackend(request);
      }
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
