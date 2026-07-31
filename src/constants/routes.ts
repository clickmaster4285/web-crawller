export const ROUTES = {
  login: "/auth/login",
  signup: "/auth/signup",
  overview: "/",
  competitors: "/competitors",
  products: "/products",
  pricing: "/pricing",
  catalogue: "/catalogue",
  insights: "/insights",
  alerts: "/alerts",
  reports: "/reports",
  sources: "/sources",
} as const;

export type AppRoute = (typeof ROUTES)[keyof typeof ROUTES];
