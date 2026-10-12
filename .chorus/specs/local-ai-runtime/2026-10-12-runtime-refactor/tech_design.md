# Tech design — Local AI runtime refactor

Spec-lite: `.chorus/specs/local-ai-runtime/2026-10-12-runtime-refactor/`

## 1. Package layout

New workspace package `packages/internal/ai-runtime` (`@follow/ai-runtime`), subpath exports like
the other internal packages (`./*` → `./src/*.ts`, no build step: bundlers and vitest consume the
TypeScript source, exactly like `@follow/store`).

| Module        | Moved from                             | Notes                                                         |
| ------------- | -------------------------------------- | ------------------------------------------------------------- |
| `prompts`     | `store/ai-local/direct/prompts.ts`     | verbatim prompts, `languageName`, `NO_CONTEXT_NOTE`           |
| `chunking`    | `store/ai-local/direct/chunking.ts`    | `splitIntoChunks`                                             |
| `loose-json`  | `store/ai-local/direct/loose-json.ts`  | `parseJsonLoose`, `stripCodeFence`                            |
| `http`        | `store/ai-local/direct/http.ts`        | `jsonResponse`, `parseJsonBody` (typed 400 on a bad body)     |
| `errors`      | new                                    | `LocalAIRequestError`, `statusForError`, `errorMessage` (D8)  |
| `limits`      | new                                    | numeric defaults/ceilings without a provider import           |
| `provider`    | `store/ai-local/direct/provider.ts`    | call-option bounds (D11), `LanguageModelFactory`              |
| `summary`     | `store/ai-local/direct/summary.ts`     | + `systemPrompt` override                                     |
| `title`       | `store/ai-local/direct/title.ts`       | + `systemPrompt` / `log` overrides                            |
| `translation` | `store/ai-local/direct/translation.ts` | + `runTranslationBatch`, `TRANSLATABLE_FIELDS` (D8)           |
| `context`     | desktop main `local-ai/context.ts`     | chat context shaping/prompting                                |
| `reduce`      | desktop main `local-ai/reduce.ts`      | note cache key, batching, `summarizeEntries`, `ReduceOptions` |
| `chat`        | new (from both chat handlers)          | `reduceChatContext` orchestration (DI: model, cache, budget)  |
| `config`      | `store/ai-local/direct/config.ts`      | model list identity/TTL (D5), probe                           |
| `router`      | `store/ai-local/direct/routes.ts`      | typed status mapping (D8), model factory DI                   |
| `test-model`  | `store/ai-local/direct/test-model.ts`  | test double of a `LanguageModel`                              |

Dependency injection points: a `LanguageModelFactory` for the provider (the direct mode uses the
OpenAI-compatible factory of the runtime, the gateway brings `@ai-sdk/openai`), the platform
`fetch`, a `log` callback that receives prefix-free lines, a `NotesCache`-shaped note cache, the
article-fetch pass (desktop only) and the env-driven system-prompt/`ReduceOptions` overrides.

## 2. Adapters after the move, and the compatibility policy

- `packages/internal/store/src/modules/ai-local/`: `client.ts` + `config.ts` (runtime config of the
  store layer), `settings.ts` (settings → `LocalAIDirectConfig` mapping, moved out of `direct/`).
- **Compatibility policy: no shims.** The intermediate `direct/*.ts` re-export files were deleted
  rather than kept: the two importers that still pointed at them (the mobile Local AI test and the
  desktop main routes test) were migrated to `@follow/ai-runtime/*`, and
  `@follow/store/package.json` dropped the runtime dependency again. A path that only re-exports
  hides which package owns a behaviour, and there is no unreleased consumer that needs it.
- Desktop main: `local-ai/{chat,streams,notes-cache,credentials,article-text,article-fetch,network-guard,http,routes}.ts`.
  `chat.ts` keeps the Electron notes cache + article fetch pass and mounts the UI message stream;
  `routes.ts` keeps only chat-stream dispatch plus the runtime router call.
- Desktop renderer / mobile: transports and settings wiring only.
- Gateway: `server.mjs` keeps env config, CORS/auth/body limit, Node request/response streaming,
  notes file cache and `@ai-sdk/openai` model resolution; summary, title, translation, chat context,
  the reduce pre-pass and the prompts come from the runtime.

## 3. Defect fixes

**D1 — settings event order.** `setSetting` writes the atoms first and dispatches
`SETTING_CHANGE_EVENT` afterwards, so a subscriber that rereads the settings sees the new value.

**D2 — no plaintext key fallback.** `safeSecureStore` gained an options argument
(`{ allowInsecureFallback?: boolean }`, default `true` so authentication callers are unchanged).
Local AI passes `allowInsecureFallback: false`: reads return `null` instead of the SQLite copy,
writes throw `SecureStorageUnavailableError` instead of storing plaintext, and `setDirectApiKey`
reports `LocalAISetApiKeyResult` (`encryption-unavailable` / `empty-key` / `write-failed`) so the
settings screen can explain it. A leftover SQLite copy of the key is removed.

**D3 — connection-time address pinning.** `network-guard.ts` holds the policy
(`isBlockedAddress`, `isBlockedHostname`, `parseArticleUrl`, `resolvePinnedDestination`): blocked
names, blocked literal addresses (unspecified/loopback/link-local/private/CGNAT/unique-local/
multicast/IPv4-mapped), and a hostname that resolves to any blocked address is refused — a name that
cannot be resolved locally is refused too (fail closed: there is nothing to pin otherwise).

`article-fetch.ts` then _pins_ the connection: `resolvePinnedDestination` returns the validated
address, and `nodePinnedRequest` opens the socket against that address while `Host` (the article's
host, including a non-default port) and, for https, `servername` (SNI + certificate verification)
stay on the article's hostname. Redirects are followed by `createGuardedArticleFetch` itself — the
transport returns the 3xx answer instead of following it — so every hop is resolved, validated and
pinned once, and a name that changes its answer between the check and the connection cannot move the
request (DNS rebinding). One connection per hop (`agent: false`), five hops at most.

Consequences: Chromium's network stack is no longer used for article reads, because it cannot be
told which address to connect to; the app's proxy configuration therefore does not apply to these
requests (recorded as a residual risk). The transport, the resolver and the request primitive are
injectable, so every branch is covered by deterministic tests.

**D4 — config-generation invalidation.** `LocalAIConfig` gained an optional `fingerprint` (from
`localAIRuntimeFingerprint`, which covers a gateway address as well as the direct endpoint, model and
tuning; never the token). `configureLocalAI` compares the runtime identity — mode, base URL, token
presence and that fingerprint — and, when it changes, bumps the generation and aborts the requests of
the previous runtime through `getLocalAIRequestSignal()`, which `client.ts` passes to every request.
A request of the old configuration therefore fails instead of writing its answer into the caches of
the new one. Both apps chain the summary/translation resets (started immediately, failures reported
and contained) and fingerprint both modes.

**D5 — model-list cache identity.** The cache key is `url|FNV-1a(key)` (never the key itself), a
rejection is remembered for the short failure TTL (10 s) while a catalogue keeps 60 s, so a corrected
key is retried immediately and two keys cannot share an answer. The 401 message names the endpoint,
not the key.

**D6 — toggle keeps the mode.** The mobile switch writes `{ enabled }` through `setLocalAIEnabled`;
the configured mode survives turning local AI off and on.

**D7 — zero budget.** `applyFetchedTexts` distinguishes `verbatimChars === undefined` (no cap
announced) from `0` (nothing left to spend: the entry keeps the text it arrived with) instead of
treating 0 as unlimited.

**D8 — typed errors and visible partial failures.** `LocalAIRequestError` carries a status (400 for
input/model configuration), the router marks the failure of a model call as `upstream` (502, with or
without a provider status code) and anything else is a 500. `runTranslationBatch` emits `{ id, data }`
rows for successes, a `{ failures: [{ id, error }] }` terminal row for the entries that failed — both
a rejected call and an answer without a single usable field — in both the direct handler and the
gateway, so partial failures stop being silent while the successful rows keep streaming.

**D9 — stream hygiene.** The renderer's direct fetch removes its `abort` listener when the stream
finishes or is cancelled; the main-process stream bridge flushes the final `TextDecoder` state before
reporting `done`.

**D10 — summary LRU and reset.** `batchClean` keeps the entry id when flattening `data`, so the least
recently used entries are deleted instead of `state.data[language]`. The `reset()` persistence
callback returns its promise, so a failing reset reaches the caller (which reports it) instead of
becoming an unhandled rejection.

**D11 — numeric bounds.** `directCallOptions` accepts `temperature: 0`, clamps temperature to `[0, 2]`,
bounds output tokens (1…128 000), chunk sizes (500…200 000) and concurrency (1…16), and treats a
non-positive value as "not set" (the settings leave a field empty). The gateway's env parsing uses the
same ceilings.

## 4. Gateway workspace integration

- `pnpm-workspace.yaml` lists `tools/ai-gateway`; `tools/ai-gateway/package.json` depends on
  `@follow/ai-runtime` (workspace), `@ai-sdk/openai`, `ai` and `zod`, with `esbuild` as a dev
  dependency. The npm `package-lock.json` and its `node_modules` were dropped: the workspace lock
  owns the graph.
- `scripts/build.mjs` bundles `server.mjs` and the TypeScript runtime sources into `dist/server.mjs`
  with esbuild (`platform: node`, `target: node22`, `ai`/`@ai-sdk/*`/`zod` external). `pnpm start`
  builds and runs that artifact, `pnpm build` bundles alone, and `pnpm mock-upstream` / `pnpm check`
  are unchanged.
- Verified: `pnpm build` produces `dist/server.mjs` (47.8 kB) and the mock-upstream check passes
  13/13 against it.

## 5. Test plan (implemented)

| Area             | Tests                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runtime          | moved `summary`/`title`/`translation`/`context`/`reduce` specs; new `provider.test.ts` (temperature 0 + bounds), `config.test.ts` (cache identity/TTL, key never in the reply), `router.test.ts` (400/500/502 mapping, owned paths), translation failure rows                                                                                                                                     |
| store            | `config.test.ts` (generation bump/abort, no bump when unchanged, switch-off cancels), `settings.test.ts` (fingerprints for both modes, no token), `client.test.ts` (in-flight request cancelled by a runtime switch), `summary/store.test.ts` (LRU keeps entry ids, failing reset rejects)                                                                                                        |
| desktop main     | `network-guard.test.ts` (IP ranges, blocked names, scheme, DNS answers, fail-closed resolution), `article-fetch.test.ts` (pinning per hop, rebinding, redirect validation, hop cap, real socket through the pinned address, abort), `article-text.test.ts` (zero budget, blocked destinations), `streams.test.ts` (decoder flush), `routes.test.ts`, `notes-cache.test.ts`, `credentials.test.ts` |
| desktop renderer | `local-ai-cache-invalidation.test.ts` (gateway and direct changes drop cached text, reset failures reported and contained), `local-ai-direct-fetch.test.ts` (stream lifecycle, abort-listener cleanup), `local-ai-gateway.test.ts` (wiring)                                                                                                                                                       |
| mobile           | `secure-store.test.ts` (strict mode refused, default fallback kept), `atoms/settings/internal/helper.test.ts` (state written before the event), `local-ai.test.ts` (key from the keychain only, no plaintext write, toggle keeps the mode, endpoint change cancels requests)                                                                                                                      |
| gateway          | `test/check.mjs` against the built artifact                                                                                                                                                                                                                                                                                                                                                       |
