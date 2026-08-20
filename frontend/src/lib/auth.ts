/**
 * Auth — real JWT session against the Parity Express backend.
 *
 * Replaces the old localStorage-only mock auth. `signIn` calls
 * `POST /api/auth/login` on the backend (dev-proxied to :3011); the returned
 * JWT is stored under `parity.token` and the user profile under
 * `parity.session` so the existing `getUser()`-based route guard keeps
 * working unchanged.
 */

import { http, setToken, clearToken } from "./http";

export interface MockUser {
  id: string;
  name: string;
  email: string;
  company: string;
}

const SESSION_KEY = "parity.session";

/** Demo credentials shown on the login page (seeded into MongoDB on boot). */
export const DEMO_CREDENTIALS = {
  email: "admin@clickmasters.com",
  password: "1234",
} as const;

export function getUser(): MockUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as MockUser) : null;
  } catch {
    return null;
  }
}

interface AuthResponse {
  success: boolean;
  message: string;
  token: string;
  user: { id: string; name: string; email: string };
}

/**
 * Signs in against the real backend. Throws with the backend's message on
 * invalid credentials.
 */
export async function signIn(
  email: string,
  password: string,
): Promise<MockUser> {
  const res = await http.post<AuthResponse>("/auth/login", { email, password });
  setToken(res.token);
  const user: MockUser = {
    id: res.user.id,
    name: res.user.name,
    email: res.user.email,
    company: "ABC Electronics",
  };
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  return user;
}

export function signOut() {
  clearToken();
  window.localStorage.removeItem(SESSION_KEY);
}
