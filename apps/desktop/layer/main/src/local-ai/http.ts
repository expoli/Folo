import { net } from "electron"

/**
 * Chromium's network stack, so direct-mode requests follow the same proxy as the rest of the app.
 * Plain `fetch` (undici) only sees an in-app proxy and fails behind a system proxy.
 */
export const netFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  net.fetch(input instanceof Request ? input : input.toString(), init)) as typeof globalThis.fetch

// The request/response helpers are platform neutral, so they live with the direct-mode core that
// every app shares.
export { jsonResponse, parseJsonBody } from "@follow/store/ai-local/direct/http"
