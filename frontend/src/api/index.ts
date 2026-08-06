/**
 * API layer — one module per backend domain (mirrors the backend route
 * groups), plus centralized query keys. Pages import from `@/api`; hooks in
 * `@/hooks/useData.ts` wrap the getters with TanStack Query.
 */
export * from "./analytics";
export * from "./alerts";
export * from "./catalogue";
export * from "./competitors";
export * from "./crawl-results";
export * from "./insights";
export * from "./matching";
export * from "./my-store";
export * from "./pricing";
export * from "./query-keys";
export * from "./reports";
export * from "./stores";
export * from "./workspace";
