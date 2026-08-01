export interface MockUser {
  id: string;
  name: string;
  email: string;
  company: string;
}

const STORAGE_KEY = "parity.session";

/** Demo credentials shown on the login page. Login stays permissive — any credentials work. */
export const DEMO_CREDENTIALS = {
  email: "admin@clickmasters.com",
  password: "1234",
} as const;

export function getUser(): MockUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as MockUser) : null;
  } catch {
    return null;
  }
}

function persist(user: MockUser) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
}

/** Demo auth — accepts any credentials and creates/restores a local session. */
function createId(): string {
  // crypto.randomUUID() only exists in secure contexts (HTTPS or localhost).
  // The demo runs over plain HTTP on the LAN (e.g. http://192.168.x.x:8080),
  // where it is undefined — fall back to a timestamp+random id.
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `demo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function signIn(email: string, name?: string): MockUser {
  const user: MockUser = {
    id: createId(),
    name: name?.trim() || email.split("@")[0] || "Demo user",
    email,
    company: "ABC Electronics",
  };
  persist(user);
  return user;
}

export function signOut() {
  window.localStorage.removeItem(STORAGE_KEY);
}
