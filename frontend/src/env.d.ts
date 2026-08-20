/// <reference types="vite/client" />

/**
 * Backend port injected at dev/build time by `vite.config.ts` `define` —
 * read from `backend/.env` (PORT=…), the single source of truth. `undefined`
 * outside a Vite build (plain node/tsx), where the callers fall back.
 */
declare const __BACKEND_PORT__: string | undefined;
