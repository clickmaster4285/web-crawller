/**
 * HTTP client for the Parity Express backend.
 *
 * Thin wrapper around fetch that:
 *   - prefixes `/api` (dev-proxied to the backend at :3000)
 *   - attaches the JWT from localStorage when present
 *   - throws on non-2xx with the backend's `message` when available
 *
 * Phase 5 auth: the token is mirrored into a `parity.token` cookie (same
 * value, non-httpOnly, `path=/` + SameSite=Lax). The browser-side http client
 * keeps reading localStorage, but TanStack Start SERVER functions run on the
 * Nitro server and fetch the backend directly — they can only see cookies, so
 * `getCookie("parity.token")` is how they recover the JWT to forward.
 */

const TOKEN_KEY = "parity.token";
const TOKEN_COOKIE = "parity.token";

function setTokenCookie(token: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}; path=/; SameSite=Lax`;
}

function clearTokenCookie() {
  if (typeof document === "undefined") return;
  document.cookie = `${TOKEN_COOKIE}=; path=/; SameSite=Lax; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  window.localStorage.setItem(TOKEN_KEY, token);
  setTokenCookie(token);
}

export function clearToken() {
  window.localStorage.removeItem(TOKEN_KEY);
  clearTokenCookie();
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  // Only set a JSON content type when there's a body (POST/PUT).
  if (init.body) headers.set("Content-Type", "application/json");

  const res = await fetch(`/api${path}`, { ...init, headers });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON response (e.g. proxy error page) — leave body null.
  }

  if (res.status === 401) {
    // Stale/expired token — clear the session and send the user back to login
    // so a dead session doesn't strand them on ErrorState pages.
    clearToken();
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("parity.session");
      if (!window.location.pathname.startsWith("/auth/")) {
        window.location.assign("/auth/login");
      }
    }
  }

  if (!res.ok) {
    const message =
      (body as { message?: string } | null)?.message ??
      `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }

  return body as T;
}

export const http = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(data ?? {}) }),
  put: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(data ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
