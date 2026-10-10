# Local AI gateway (route A)

Drop Folo's own AI out of the loop and run summaries, translations and the AI chat on **your**
model endpoint, without touching Folo's account/subscription model for anything else.

The gateway speaks the subset of Folo's `/ai/*` API that the patched client calls, and forwards
the actual inference to any **OpenAI-compatible** endpoint (`/chat/completions`): OpenAI, vLLM,
LM Studio, Ollama, LiteLLM, an internal model gateway, …

```
┌──────────────────────┐        ┌───────────────────────┐        ┌──────────────────────┐
│ Folo (patched fork)  │  /ai/* │  tools/ai-gateway     │ /v1/…  │ your model endpoint  │
│ desktop + mobile     │ ─────► │  (this directory)     │ ─────► │ OpenAI-compatible    │
└──────────────────────┘        └───────────────────────┘        └──────────────────────┘
        ▲ Folo account + feeds still come from api.folo.is (unchanged, closed source backend)
```

## What runs locally, what does not

| Feature                                                                             | Where it runs with this gateway                                  |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| AI summary (article card, `AISummaryCard`)                                          | **your model**                                                   |
| AI translation (entry list + reading pane)                                          | **your model**                                                   |
| AI chat (sidebar panel, "Ask AI" about an article)                                  | **your model**                                                   |
| Built-in shortcuts ("Summarize timeline", "Recommend feeds")                        | **your model** — the client gathers the entries / feed catalogue |
| Model picker (`Settings → AI`)                                                      | model list from the gateway                                      |
| AI tasks / daily digest, TTS (read aloud), MCP services, chat memory & history sync | still Folo's server (needs its closed-source backend)            |
| Feeds, subscriptions, sync, login                                                   | still Folo's server                                              |

## 1. Run the gateway

```bash
cd tools/ai-gateway
npm install                 # ai@7.0.109 + @ai-sdk/openai@4.0.9 (pinned to the client's AI SDK)
cp .env.example .env        # then edit AI_BASE_URL / AI_API_KEY / AI_MODEL
npm start                   # http://127.0.0.1:8788
```

`.env` is loaded by `server.mjs` itself (`process.loadEnvFile`), so there is no `source` / `export`
step — it behaves the same in bash, zsh and fish. Real environment variables still take precedence
over the file, which is how the verify step at the bottom injects the mock upstream.

`GET /health` reports the configured upstream and models. Point `AI_BASE_URL` at a local runtime
to keep content on your machine:

| Runtime   | `AI_BASE_URL`               | Notes                                          |
| --------- | --------------------------- | ---------------------------------------------- |
| Ollama    | `http://127.0.0.1:11434/v1` | `AI_MODEL=qwen3:8b`; any value in `AI_API_KEY` |
| LM Studio | `http://127.0.0.1:1234/v1`  | enable the local server first                  |
| vLLM      | `http://127.0.0.1:8000/v1`  | `--served-model-name` decides `AI_MODEL`       |
| OpenAI    | `https://api.openai.com/v1` | needs a real `AI_API_KEY`                      |

Long articles and summaries need a decent context window; 32k+ is comfortable, small models will
truncate. The gateway never cuts content silently:

- summaries of more than `AI_SUMMARY_CHUNK_CHARS` (default `12000`) characters are written part by
  part and then merged into one summary; the result carries a `_Summarized the full article in N
parts …_` note so a merged summary is not mistaken for a partial one;
- translation fields longer than `AI_TRANSLATION_CHUNK_CHARS` (default `8000`) characters are split
  at paragraph boundaries, translated chunk by chunk, and rejoined per field (same NDJSON
  `{ id, data }` protocol);
- the client only ships as much article text as `AI_CONTEXT_*` allows, and marks every cut it has
  to make inside the text (`…[truncated N chars]`).

## 2. Point the client at the gateway

**Desktop / web renderer — Settings → AI → Local AI Gateway.** Switch it on, paste the address
(and the token when `GATEWAY_TOKEN` is set) and use **Test connection** before saving. A saved
change applies to the next AI request — summary, translation or chat — without restarting the
app. The address and the token are device-local: they are never synced to your account.

`apps/desktop/.env` only seeds the first run, i.e. the values a fresh install starts with. Once
the gateway section has been saved, the saved settings win:

```bash
VITE_LOCAL_AI_GATEWAY_URL=http://127.0.0.1:8788
# VITE_LOCAL_AI_TOKEN=change-me        # only if GATEWAY_TOKEN is set
```

Mobile (Expo) — `apps/mobile/.env` (or the shell that starts Metro). Mobile has no settings UI
for the gateway yet, so the env is still the only way there:

```bash
EXPO_PUBLIC_LOCAL_AI_GATEWAY_URL=http://192.168.1.20:8788   # LAN address of the machine running the gateway
# EXPO_PUBLIC_LOCAL_AI_TOKEN=change-me
```

Then start the app normally (`pnpm --filter Folo run dev:electron` for the desktop app, or
`pnpm --filter @follow/mobile run android` / `ios`). When the gateway is off — no address, or the
switch is disabled — the build behaves exactly like upstream Folo: every AI request goes back to
`api.folo.is`, so you can keep both paths in one binary.

Restart is required after changing the env: the config is read at app bootstrap.

A model with a large context (deepseek-flash and friends: 128k) can take a lot more article text
than the defaults. The gateway tells the client how much to send, so the budget lives with the
model:

```bash
AI_CONTEXT_MAX_ENTRIES=20          # max articles attached to one chat request
AI_CONTEXT_MAX_CHARS_PER_ENTRY=20000  # per article, when several are attached
AI_CONTEXT_MAX_TOTAL_CHARS=60000   # whole request; a single referenced article may use all of it
AI_REDUCE_BATCH_ENTRIES=8          # articles per summarizing call of the reduce pre-pass
AI_REDUCE_BATCH_CHARS=16000        # text per call
AI_REDUCE_CONCURRENCY=3            # summarizing calls at the same time (defaults to the translation one)
AI_REDUCE_MAX_ENTRIES=200          # articles the pre-pass reads per request
AI_REDUCE_NOTE_CHARS=600           # longest note attached per article
AI_REDUCE_NOTES_TOTAL_CHARS=30000  # all notes of one request together
AI_REDUCE_CACHE=1                  # 0 keeps the notes in memory instead of on disk
AI_REDUCE_CACHE_FILE=~/.cache/folo-ai-gateway/notes.json
AI_REDUCE_SYSTEM_PROMPT=...        # prompt of the pre-pass
```

These values are served by `GET /ai/chat/config` (`localAIContext`). A client build that predates
the field — or a gateway that predates it — falls back to 20 articles x 1500 characters.

Within that budget the client sends article texts, and every entry the selection matched beyond
them by its metadata alone (title, link, date — up to 200 rows, with a listing allowance equal to
`AI_CONTEXT_MAX_TOTAL_CHARS`). The request also carries `coverage: { matched, window? }`, which the
gateway renders as a `Coverage: …` note before the entries: a summary of "today" should hear that
it saw 20 of 137 articles, and entries marked `(no text attached)` must not be summarised as if
their content had been read.

**Both modes close that gap** with a `reduce` pre-pass: a timeline summary sends the text of the
articles the prompt cannot carry as `body`, the receiving side summarizes them in batches (8
articles or 16 000 characters per call, three at a time, notes reused per article/model/language)
and attaches the notes to the prompt. The coverage note then reads `… 20 with text, 78 summarised
from their text …`, and those articles count as read instead of listed by title. The gateway keeps
its copy in `server.mjs` (tuned by the `AI_REDUCE_*` variables above), the app keeps its own in
`apps/desktop/layer/main/src/local-ai/reduce.ts` (tuned in Settings → AI → Advanced).

## 3. Verify

```bash
cd tools/ai-gateway
node test/mock-openai.mjs &                                   # deterministic fake upstream :8799
AI_BASE_URL=http://127.0.0.1:8799/v1 AI_API_KEY=mock node server.mjs &
npm run check                                                 # exercises every endpoint
```

`npm run check` parses the chat stream with the AI SDK's `uiMessageChunkSchema` — the same parser
`HttpChatTransport` uses in the app — so a green run means the desktop/mobile client can consume
the gateway.

## Endpoints

| Method | Path                    | Request                                                                                          | Response                                                                    |
| ------ | ----------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `POST` | `/ai/chat`              | AI SDK UI request: `{ id, messages, trigger, model?, scene?, localAIContext? }`                  | AI SDK UI message stream (`text/event-stream`)                              |
| `GET`  | `/ai/chat/:id/stream`   | –                                                                                                | always `204` (no server-side chat history to resume)                        |
| `GET`  | `/ai/chat/config`       | –                                                                                                | `{ defaultModel, availableModels, availableModelsMenu, localAIContext, … }` |
| `POST` | `/ai/summary`           | `{ entryId, language, target, title, content }`                                                  | `{ code: 0, data: string \| null }`                                         |
| `POST` | `/ai/translation/batch` | `{ entries: [{ id, title, description, content, readabilityContent }], language, fields, mode }` | NDJSON, one `{ id, data }` line per entry                                   |
| `GET`  | `/health`               | `?probe=1` to also call the model once                                                           | `{ ok, upstream, defaultModel, models, probe? }`                            |

All POST bodies are JSON; `Content-Type` of the chat response must stay `text/event-stream` — the
client's `HttpChatTransport` parses it as a UI message stream.

`GET /health?probe=1` performs one minimal model call (`maxOutputTokens=1`) and returns
`{ ok, upstream, defaultModel, probe: { ok, latencyMs, error? } }`, which tells "the gateway is up"
apart from "the model/upstream is broken". `/health` is exempt from `GATEWAY_TOKEN`, so a wrong
gateway token shows up as a 401 on the other endpoints instead (the client reports "gateway token
rejected"). Plain `GET /health` stays instant and never touches the model.

## Client changes in this fork

| File                                                                             | Change                                                                                                                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/internal/store/src/modules/ai-local/config.ts`                         | gateway config registry (`configureLocalAI`, `isLocalAIEnabled`)                                                                                |
| `packages/internal/store/src/modules/ai-local/client.ts`                         | summary / translation / chat-config calls against the gateway                                                                                   |
| `packages/internal/store/src/modules/summary/store.ts`                           | summary goes through the gateway when enabled                                                                                                   |
| `packages/internal/store/src/modules/translation/store.ts`                       | translation batch goes through the gateway; the free-plan block no longer applies locally                                                       |
| `apps/desktop/…/ai-chat/store/transport.ts`                                      | chat transport (`api` + `credentials` + gateway bearer token) switches to the gateway                                                           |
| `apps/desktop/…/ai-chat/hooks/useAIConfiguration.ts`                             | model picker reads the gateway model list                                                                                                       |
| `apps/desktop/…/ai-chat/utils/local-ai-context.ts` + `chat-core/chat-actions.ts` | resolves the context blocks to entry text, gathers the timeline a date mention points at, and attaches the feed catalogue for "Recommend feeds" |
| `apps/desktop/…/ai-chat-session/*`, `…/ai-chat/services/index.ts`                | local sessions stay local: no sync, unread query, or remote delete                                                                              |
| `apps/desktop/…/entry-column/item.tsx`, `entry-content/hooks.tsx`                | translation prefetch is not gated on the paid plan when the gateway is used                                                                     |
| `apps/desktop/layer/renderer/src/main.tsx`, `apps/mobile/src/main.tsx`           | wire the env vars into `configureLocalAI`                                                                                                       |

## Relationship to the app's built-in direct mode

The client also ships a **direct** mode (`Settings → AI → Connection mode → Direct connection`). It
speaks the very same `/ai/*` contract, but the provider adapter runs inside the Electron main
process instead of this Node gateway: the model prompts, the chunking limits and the
`localAIContext` budget in `apps/desktop/layer/main/src/local-ai/` are copied from `server.mjs` on
purpose, so the two paths can be compared line by line.

|                                                                                   | this gateway                                                   | built-in direct mode                                                                                      |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Where it runs                                                                     | separate Node process (also usable from the mobile app)        | Electron main process                                                                                     |
| Configuration                                                                     | `.env` + `GATEWAY_TOKEN`                                       | `Settings → AI` (address and model list stay on the device, the API key is encrypted with the OS keyring) |
| Endpoint                                                                          | `AI_BASE_URL`                                                  | one OpenAI-compatible endpoint per install                                                                |
| Extra tuning (`AI_SUMMARY_CHUNK_CHARS`, `AI_HEADERS`, translation concurrency, …) | yes                                                            | no: the defaults are compiled in                                                                          |
| Wide selections (a summary of a whole day)                                        | summarized into notes first (`reduce` pre-pass)                | same pre-pass, with the knobs in Settings → AI → Advanced                                                 |
| Translation delivery                                                              | NDJSON streamed line by line, so entries appear as they finish | buffered: IPC answers a batch in one piece, so the translations appear together                           |
| System proxy                                                                      | follows `HTTP(S)_PROXY` of its shell                           | follows the same proxy as the rest of the app (Chromium's `net.fetch`)                                    |

Keep `server.mjs` as the reference: it stays the more configurable of the two, and a behaviour
change there has to be mirrored in the direct mode (and vice versa) to keep them interchangeable.

## Limits & caveats

- **The Folo account is still required** for feeds/content: the backend is closed source, so this
  only replaces the AI half of the service.
- **No server-side tools**: Folo's AI can search your feeds, connect MCP servers and remember past
  chats. Those tools live on Folo's servers, so the gateway answers from the entries the client
  attaches. Folo's built-in shortcuts expect server-side data as well: the client now supplies the
  timeline entries a `<mention-date>` window points at and the trending feed catalogue for
  "Recommend feeds", but anything else that needs server-side tools (feed search, MCP, memory)
  still cannot work locally.
- **Auto-generated chat titles** arrive as a `data-generated-title` chunk from Folo's server and are
  not implemented here — chats keep their default/edited title.
- **Stream resumption** is a no-op (`204`): restarting the app mid-answer cannot continue the
  answer, it just stops.
- **Chat history stays local**: sessions started against the gateway are never marked as synced and
  are not sent to Folo (`markSessionSynced`, the session sync, the unread query and session deletion
  all skip the backend). Task sessions / `Settings → AI` task lists still come from Folo.
- **A wide summary runs a pre-pass**: the first "summarize today" over ~100 matched
  articles answers a few articles per call before the answer starts, so the first tokens take
  noticeably longer (the log prints `reduce: …` when it finishes, and the panel shows how far it
  is). The notes are cached per article, model and language — in memory and, both here and in the
  app, in a file — so summarizing the same day again, even after a restart, is immediate. Closing
  the chat window stops the work; the Stop button takes effect once the answer stream has opened.
- Both the plan gate for BYOK and AI quota live on Folo's servers; the local path bypasses them for
  the three endpoints above. Review your own situation before using this with a Folo account you
  care about — see the project README and Folo's Terms of Service.
- License: this fork stays **AGPL-3.0** (plus the `icons/mgc` exception). Distributing a modified
  build means publishing the source; personal builds have no such obligation.
