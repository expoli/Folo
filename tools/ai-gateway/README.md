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

| Feature                                                                             | Where it runs with this gateway                       |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| AI summary (article card, `AISummaryCard`)                                          | **your model**                                        |
| AI translation (entry list + reading pane)                                          | **your model**                                        |
| AI chat (sidebar panel, "Ask AI" about an article)                                  | **your model**                                        |
| Model picker (`Settings → AI`)                                                      | model list from the gateway                           |
| AI tasks / daily digest, TTS (read aloud), MCP services, chat memory & history sync | still Folo's server (needs its closed-source backend) |
| Feeds, subscriptions, sync, login                                                   | still Folo's server                                   |

## 1. Run the gateway

```bash
cd tools/ai-gateway
npm install                 # ai@7.0.109 + @ai-sdk/openai@4.0.9 (pinned to the client's AI SDK)
cp .env.example .env        # then edit AI_BASE_URL / AI_API_KEY / AI_MODEL
set -a && . ./.env && set +a
npm start                   # http://127.0.0.1:8788
```

`GET /health` reports the configured upstream and models. Point `AI_BASE_URL` at a local runtime
to keep content on your machine:

| Runtime   | `AI_BASE_URL`               | Notes                                          |
| --------- | --------------------------- | ---------------------------------------------- |
| Ollama    | `http://127.0.0.1:11434/v1` | `AI_MODEL=qwen3:8b`; any value in `AI_API_KEY` |
| LM Studio | `http://127.0.0.1:1234/v1`  | enable the local server first                  |
| vLLM      | `http://127.0.0.1:8000/v1`  | `--served-model-name` decides `AI_MODEL`       |
| OpenAI    | `https://api.openai.com/v1` | needs a real `AI_API_KEY`                      |

Long articles and summaries need a decent context window; 32k+ is comfortable, small models will
truncate.

## 2. Point the client at the gateway

Desktop (Electron / web renderer) — `apps/desktop/.env`:

```bash
VITE_LOCAL_AI_GATEWAY_URL=http://127.0.0.1:8788
# VITE_LOCAL_AI_TOKEN=change-me        # only if GATEWAY_TOKEN is set
```

Mobile (Expo) — `apps/mobile/.env` (or the shell that starts Metro):

```bash
EXPO_PUBLIC_LOCAL_AI_GATEWAY_URL=http://192.168.1.20:8788   # LAN address of the machine running the gateway
# EXPO_PUBLIC_LOCAL_AI_TOKEN=change-me
```

Then start the app normally (`pnpm --filter Folo run dev:electron` for the desktop app, or
`pnpm --filter @follow/mobile run android` / `ios`). When `*_LOCAL_AI_GATEWAY_URL` is empty the
build behaves exactly like upstream Folo: every AI request goes back to `api.folo.is`, so you can
keep both paths in one binary.

Restart is required after changing the env: the config is read at app bootstrap.

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

| Method | Path                    | Request                                                                                          | Response                                                                      |
| ------ | ----------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `POST` | `/ai/chat`              | AI SDK UI request: `{ id, messages, trigger, model?, scene?, localAIContext? }`                  | AI SDK UI message stream (`text/event-stream`)                                |
| `GET`  | `/ai/chat/:id/stream`   | –                                                                                                | always `204` (no server-side chat history to resume)                          |
| `GET`  | `/ai/chat/config`       | –                                                                                                | `{ defaultModel, availableModels, availableModelsMenu, usage, rateLimit, … }` |
| `POST` | `/ai/summary`           | `{ entryId, language, target, title, content }`                                                  | `{ code: 0, data: string \| null }`                                           |
| `POST` | `/ai/translation/batch` | `{ entries: [{ id, title, description, content, readabilityContent }], language, fields, mode }` | NDJSON, one `{ id, data }` line per entry                                     |
| `GET`  | `/health`               | –                                                                                                | `{ ok, upstream, defaultModel, models }`                                      |

All POST bodies are JSON; `Content-Type` of the chat response must stay `text/event-stream` — the
client's `HttpChatTransport` parses it as a UI message stream.

## Client changes in this fork

| File                                                                             | Change                                                                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/internal/store/src/modules/ai-local/config.ts`                         | gateway config registry (`configureLocalAI`, `isLocalAIEnabled`)                                |
| `packages/internal/store/src/modules/ai-local/client.ts`                         | summary / translation / chat-config calls against the gateway                                   |
| `packages/internal/store/src/modules/summary/store.ts`                           | summary goes through the gateway when enabled                                                   |
| `packages/internal/store/src/modules/translation/store.ts`                       | translation batch goes through the gateway; the free-plan block no longer applies locally       |
| `apps/desktop/…/ai-chat/store/transport.ts`                                      | chat transport (`api` + `credentials`) switches to the gateway                                  |
| `apps/desktop/…/ai-chat/hooks/useAIConfiguration.ts`                             | model picker reads the gateway model list                                                       |
| `apps/desktop/…/ai-chat/utils/local-ai-context.ts` + `chat-core/chat-actions.ts` | resolves the chat context blocks to entry text, because the gateway cannot read Folo's database |
| `apps/desktop/…/entry-column/item.tsx`, `entry-content/hooks.tsx`                | translation prefetch is not gated on the paid plan when the gateway is used                     |
| `apps/desktop/layer/renderer/src/main.tsx`, `apps/mobile/src/main.tsx`           | wire the env vars into `configureLocalAI`                                                       |

## Limits & caveats

- **The Folo account is still required** for feeds/content: the backend is closed source, so this
  only replaces the AI half of the service.
- **No server-side tools**: Folo's AI can search your feeds, connect MCP servers and remember past
  chats. Those tools live on Folo's servers; the gateway answers from the chat history plus the
  entries the client attaches to the request.
- **Auto-generated chat titles** arrive as a `data-generated-title` chunk from Folo's server and are
  not implemented here — chats keep their default/edited title.
- **Stream resumption** is a no-op (`204`): restarting the app mid-answer cannot continue the
  answer, it just stops.
- Both the plan gate for BYOK and AI quota live on Folo's servers; the local path bypasses them for
  the three endpoints above. Review your own situation before using this with a Folo account you
  care about — see the project README and Folo's Terms of Service.
- License: this fork stays **AGPL-3.0** (plus the `icons/mgc` exception). Distributing a modified
  build means publishing the source; personal builds have no such obligation.
