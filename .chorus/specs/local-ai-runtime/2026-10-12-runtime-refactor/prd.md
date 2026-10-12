# PRD — Local AI runtime refactor

Spec-lite: `.chorus/specs/local-ai-runtime/2026-10-12-runtime-refactor/`

## Problem

Local AI grew across three adapters that each carry their own copy of the same business logic:
the desktop main process (`apps/desktop/layer/main/src/local-ai`), the mobile app
(`apps/mobile/src/lib/local-ai.ts` + the shared store copy under
`packages/internal/store/src/modules/ai-local/direct`), and the standalone gateway
(`tools/ai-gateway/server.mjs`). The gateway is not even part of the pnpm workspace, so the copies
drift, and a fix in one place silently leaves the other two behind.

Alongside the duplication, review found concrete defects in the three copies.

## Goals

1. One environment-neutral `@follow/ai-runtime` package owns the business behaviour (prompts,
   chunking, loose JSON, summary, title, translation, chat context/reduce orchestration, direct
   config/probe helpers, request→`Response` router).
2. The three adapters keep only what is genuinely theirs: key custody, transports, network policy,
   file caches, IPC, process lifecycle, and configuration parsing.
3. `tools/ai-gateway` joins the pnpm workspace with a reproducible build and a Node 22 runnable
   artifact, keeping its simple start/check scripts.
4. Fix the confirmed defects below and add a regression test for each one.
5. Behaviour stays compatible: same `/ai/*` paths, same JSON, same SSE/NDJSON, same env names,
   same Local AI settings shape.

## Non-goals

- No new AI features, no new provider support, no prompt rewording (prompts are copied verbatim).
- No forced merge of `@ai-sdk/openai` (gateway) and `@ai-sdk/openai-compatible` (direct mode).
- No change to Folo's own (closed-source) AI path.

## Confirmed defects to fix

| #   | Defect                                                                                                                                     | Where                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| D1  | Mobile settings dispatch `SETTING_CHANGE_EVENT` before the state is written, so subscribers reread the old value                           | `apps/mobile/src/atoms/settings/internal/helper.ts`                           |
| D2  | Mobile Local AI API keys fall back to plaintext SQLite when SecureStore is unavailable                                                     | `apps/mobile/src/lib/secure-store.ts`, `local-ai.ts`                          |
| D3  | Desktop article fetching reaches loopback / link-local / private / internal / metadata destinations, including DNS and redirects           | `apps/desktop/layer/main/src/local-ai/article-text.ts`                        |
| D4  | Cache invalidation ignores gateway config, resets are fire-and-forget, and a request from the previous config can still persist its answer | desktop renderer + mobile `local-ai*` wiring, `@follow/store/ai-local/config` |
| D5  | Model-list draft probes reuse a rejection across different keys; the cache key holds the raw key                                           | `ai-local/direct/config.ts` → `@follow/ai-runtime/config`                     |
| D6  | Toggling Local AI on mobile rewrites `mode` to `direct`, losing a configured gateway                                                       | `apps/mobile/src/modules/settings/routes/LocalAI.tsx`                         |
| D7  | A zero remaining article budget is treated as "no limit"                                                                                   | desktop main `article-text.ts`                                                |
| D8  | Every provider failure is collapsed into HTTP 400; a translation batch drops failed entries silently                                       | `ai-local/direct/routes.ts`, `translation.ts`                                 |
| D9  | Desktop stream bridge leaks abort listeners and never flushes the final `TextDecoder` state                                                | renderer `local-ai-direct-fetch.ts`, main `streams.ts`                        |
| D10 | Summary LRU pruning deletes `state.data[language]` instead of the least recently used entry                                                | `packages/internal/store/src/modules/summary/store.ts`                        |
| D11 | `temperature: 0` is dropped and token/chunk/concurrency fields accept unsafe values                                                        | `ai-local/direct/provider.ts` → `@follow/ai-runtime/provider`                 |

## Acceptance criteria

- **AC1** `@follow/ai-runtime` exists, is environment-neutral, and is the only home of the shared
  business behaviour; the adapters keep only platform/config/HTTP/cache adaptation.
- **AC2** The existing gateway mock-upstream check passes against the built gateway
  (`tools/ai-gateway/dist/server.mjs`), and `pnpm --filter folo-local-ai-gateway start|check` keep
  working simply.
- **AC3** Every defect D1–D11 is fixed and covered by a focused regression test.
- **AC4** Focused typecheck, lint/format and tests for the touched packages pass; `git diff --check`
  is clean.
- **AC5** No public contract changed: `/ai/*` paths, JSON bodies, SSE and NDJSON behaviour, env
  names and the Local AI settings shape are preserved.

## Out of scope

- `packages/internal/store/src/modules/summary/store.ts` is outside the editing scope agreed for
  this change, but D10 is only fixable there (the summary LRU lives in that file). It is edited as
  the single exception and reported explicitly.
