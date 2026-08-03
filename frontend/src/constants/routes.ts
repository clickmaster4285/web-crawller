export const ROUTES = {
  login: "/auth/login",
  overview: "/",
  competitors: "/competitors",
  products: "/products",
  pricing: "/pricing",
  catalogue: "/catalogue",
  insights: "/insights",
  alerts: "/alerts",
  reports: "/reports",
  sources: "/sources",
  crawls: "/crawls",
} as const;

export type AppRoute = (typeof ROUTES)[keyof typeof ROUTES];
