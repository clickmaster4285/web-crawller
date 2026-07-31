export interface MockUser {
  id: string;
  name: string;
  email: string;
  company: string;
}

const STORAGE_KEY = "parity.session";

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
export function signIn(email: string, name?: string): MockUser {
  const user: MockUser = {
    id: crypto.randomUUID(),
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
