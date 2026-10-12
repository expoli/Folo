# Local AI runtime (`@follow/ai-runtime`)

Durable spec of the environment-neutral Local AI runtime and its platform adapters (desktop
Electron, mobile Expo, `tools/ai-gateway`). Edited in place; git history is its record.

## Capability

Folo can run summary, summary title, translation and chat on a model endpoint the user owns,
instead of Folo's servers. Two modes exist:

- `gateway`: a self-hosted process (`tools/ai-gateway`) serves the `/ai/*` paths over HTTP.
- `direct`: the app itself serves the same paths in-process — the desktop main process over IPC,
  the mobile app through a buffered local fetch — and calls an OpenAI-compatible endpoint.

Both modes answer **one contract**: the same request paths, the same request/response JSON, the
same SSE / NDJSON behaviour the Folo client already consumes.

## Layers

| Layer                        | Owns                                                                                                                                                                                 | Must not own                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `@follow/ai-runtime`         | prompts/language, chunking, loose JSON, summary, title, translation, chat context + reduce orchestration, direct-mode config/model-list/probe helpers, the request→`Response` router | fs/http/path, Electron, React Native, secure storage, Jotai/Zustand, database, `@follow/store` |
| desktop main (`local-ai/**`) | API-key custody (`safeStorage`), `net.fetch`, article network policy, notes file cache, IPC services, chat stream bridge                                                             | business prompts / summary / translation / reduce logic                                        |
| mobile (`lib/local-ai*`)     | SecureStore key custody, global fetch, settings lifecycle, buffered `Response`                                                                                                       | business logic                                                                                 |
| `tools/ai-gateway`           | env parsing, auth, CORS, body limit, Node request/response streaming, process lifecycle, Node notes-file cache adapter, `@ai-sdk/openai` model resolution                            | business logic                                                                                 |

The runtime is dependency-injected everywhere a platform is involved: model factory/provider,
`fetch`, logging, notes cache, optional article fetching, and the system-prompt overrides the
gateway takes from its environment.

## Invariants

1. Public `/ai/*` paths, request/response JSON, SSE/NDJSON shapes, env variable names and the
   Local AI settings shape are unchanged by refactors.
2. `@follow/ai-runtime` stays environment-neutral: no Node/Electron/RN/store import.
3. The gateway's business behaviour comes from the runtime; the gateway file keeps only
   platform/config/HTTP/cache adaptation.
4. Local AI failures are typed: bad input is a request error, an upstream/provider failure is not
   collapsed into one status.
5. Partial failures stay visible: a summary says how much of an article was read, a translation
   batch reports the entries that failed next to the rows that succeeded.
6. Secrets never fall back to plaintext storage; a fingerprint or cache key never contains a raw
   API key or token.
7. Article fetching from the desktop main process never reads loopback, link-local, private,
   internal or metadata destinations — including DNS-resolved addresses and redirect hops.

## Acceptance

- Focused typecheck + tests for the runtime, store, desktop main/renderer and mobile pass.
- `node tools/ai-gateway/test/check.mjs` passes against the built/runnable gateway.
- Regression tests exist for every corrected defect listed in the change that introduced this
  spec version.
