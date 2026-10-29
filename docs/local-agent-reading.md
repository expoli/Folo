# Local agent reading (MCP)

Folo Desktop can expose the unread entries of the signed-in account over a loopback-only MCP
endpoint, so a local agent can read them and write its own summary. The endpoint is off by default,
is read-only, and exists only while Folo is running and signed in. Fetching an article's **public
page** is a second, independent permission that is also off by default.

This page is the operator's view: what to switch on, how to connect an agent, what the agent sees,
and which limits are deliberate. The verification section below distinguishes packaged-app checks
from live-account checks; partial coverage must not be treated as an exhaustive unread snapshot.

## Switch it on

1. Start Folo Desktop and sign in.
2. **Settings → Integration → Local agent reading (MCP)**.
3. Turn the switch on. Folo mints a dedicated token and starts listening on
   `http://127.0.0.1:41610/mcp`.
4. **Reveal** the token, then **Copy** the endpoint and the token.
5. **Article page fetching** is a second switch below it and is **off by default**. Leave it off and
   agents read only what the account already holds; turn it on to allow `source_page` reads. It is
   a separate choice from the endpoint switch: the endpoint keeps serving (cached and detail reads)
   whether it is on or off.

The switch is stored on the device, so the endpoint comes back on the next start — but only if the
token could be stored in the OS keyring. Without a keyring the token is kept in memory for this
session only: after a restart the switch is still on while the endpoint is not listening, the
settings section says so, and **Reset token** mints a new one.

The article page permission is stored on the device too and, unlike the token, is not tied to the
keyring: it stays as the user set it. A profile that predates the switch reads as **off**.

The section also shows whether the socket is listening, whether a token exists, where the token is
stored, and the reason the port could not be bound. The port is fixed on purpose: an agent is
configured with a URL that must not move. If something else already holds `41610`, the feature
reports the listen error and stays off instead of picking another port.

## The same four tools inside the app

The chat panel's local AI calls these tools itself, so it can read unread entries instead of only
working with what the client attached to the message. Two differences from the endpoint:

- The endpoint switch and the token are not involved. The panel talks to the service in-process, so
  it reads the account without the user exposing a port; **Article page fetching** still gates the
  `source_page` mode exactly as it does for an agent.
- Reading stays read-only. There is no tool that marks anything read, for either caller.

A chat spends at most six model round trips on tools, and the timeline-summary shortcut uses none
(its pre-pass already reads every matched article). An endpoint that rejects tool calling is
detected on its first refusal, and later chats in the same run go out without tools.

### The user's own MCP services

The same loop also offers tools from the MCP services configured under **Settings → AI → MCP**, so
one answer can combine the user's notes with what they read. What applies:

- **Read-only, explicitly.** Only a tool whose server marks it `readOnlyHint` is offered. A server
  that annotates nothing contributes nothing; write tools need an approval flow the app does not
  have yet.
- **Per request.** Connections open when a chat starts and close when its answer is finished;
  nothing is cached between chats, so a service the user just disabled or re-authenticated is read
  as it is now. A service that cannot be reached is skipped and the answer goes on without it.
- **Bounded.** Up to 8 services and 26 tools per request (Folo's four come on top), 16 000
  characters per tool result, 15 seconds per call, and headers come from the service configuration
  (a personal access token, a bearer key). There is no OAuth flow: a service that only supports
  OAuth cannot be used from the loop yet.
- **Names carry the service**: `mcp__<service>__<tool>`, so an answer can be traced back to where a
  fact came from.

Tool results are remote text and reach the model as-is. The loop cannot do anything with them beyond
reading, but an answer built from an untrusted service is only as trustworthy as that service.

## Connect an agent

Any MCP client that speaks Streamable HTTP can connect; only the endpoint and the token are needed:

```json
{
  "mcpServers": {
    "folo": {
      "type": "http",
      "url": "http://127.0.0.1:41610/mcp",
      "headers": { "Authorization": "Bearer <the token Folo revealed>" }
    }
  }
}
```

The usual flow is: `folo_get_status` → `folo_begin_unread_scan` → `folo_list_scan_entries`
(repeatedly, following `cursor`) → `folo_get_entry_contents` for the entries the agent wants to
read.

### The four tools

| Tool                      | Purpose                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folo_get_status`         | Contract version, endpoint, whether the endpoint is on and listening, whether article page fetching is allowed (`sourcePageEnabled`), whether the app is signed in and ready, the account id, the sources that can be enumerated, the views, the scopes that are _not_ supported, and the batch limits. Never a credential. |
| `folo_begin_unread_scan`  | Starts a bounded enumeration of the unread entries of the account, optionally narrowed by `scope` (views, feed ids, inbox ids, a published time range). Returns the scan summary: whether enumeration completed, what was dropped, how many candidates were pinned.                                                         |
| `folo_list_scan_entries`  | Pages through the pinned candidate list. Each entry carries id, title, url, feed id, publish time, `readState` and whether text is cached locally.                                                                                                                                                                          |
| `folo_get_entry_contents` | Returns the text of named entries (or continues a long one). `mode` is `cached` (what the app already stored), `detail` (may ask the account for the article) or `source_page` (may additionally fetch the article's public page — only while the article page permission is on).                                           |

There is deliberately **no** tool that marks anything read, changes subscriptions, or writes to the
account. See "Read-only" below.

## What the endpoint promises, and what it does not

**Coverage is stated, not implied.** A scan reports `enumerationComplete` and one status per source
(`view`, `inbox`, `feed`): `complete`, `partial`, `failed` or `unsupported`. A source that could not
be read is reported as failed with the error; it is never omitted, and it never turns into "no
unread entries". Search results, archived/uncollected entries and entries the account API no longer
returns are listed in `unsupportedScopes` of `folo_get_status`.

**Selection is `best_effort`, not a snapshot.** Pagination walks the account newest-first using the
same cursor convention as the timeline, one page of at most 100 rows at a time. The account's
cursor carries a publish time and nothing finer, so a page that ended because it was full is a cut
whose coverage cannot be checked: entries published at exactly that instant may fall between the
two pages, and that cannot be ruled out from the page itself. A source that filled a page therefore
ends `partial` — even when the next page is empty, and even when no second entry of the page shows
that time — and `enumerationComplete` is false for the scan. The reason is reported per source in
the scan's `errors`: `timestamp_tie_boundary` when a sibling of the cut entry is visible in the
page, `page_boundary_unverified` when the cut time appears only once. (The scan summary repeats
those notes with the code `source_failed`, so an agent can see why the scan is not complete.) A
source that was never paged — a short source, an empty one, or a page that ends below the requested
`publishedAfter` — stays `complete`; the walk itself still runs best-effort to the end of every
source, so nothing is truncated. The pinned candidate list keeps a scan stable against later read
changes, but it is not an atomic snapshot of "the account at T0". Making the cut lossless would
need server evidence (a compound cursor or a verified inclusive boundary), which the client does
not have — and it is not faked by over-fetching.

**Unknown read state is not unread.** What the account returns and what the app has not applied yet
are merged per entry; an entry whose read state cannot be observed is sent as `unknown`, counted, and
never served as unread. A pending local mark-read wins over the snapshot.

**Text is labelled by source.** `contentSource` is `readability` (the app's extracted article text),
`rss` (the feed's own content), `description` (a summary) or `source_page` (fetched by Folo from the
article's public page). `completeness` is `partial` for a description and `unknown` for the others:
neither length nor a successful fetch proves that a page was complete, so nothing is called the full
article without evidence. Long text is chunked at 6000 characters and continued with the `nextCursor`
returned with each item; the continuation re-reads the text, so a text that changed in between shifts
the offsets.

**Failures are per entry.** One unreadable entry keeps the rest of the batch: each item may carry an
`error` code (`no_content`, `entry_not_found`, `not_in_scan`, `unsupported_media`,
`blocked_destination`, `fetch_failed`, `paywall_or_too_short`, `timeout`) and calls report
`counts` (requested / returned / failed / continued). Exceeding the scan limits (`2000` candidates,
`60 s` enumeration, `4` concurrent scans, `15 min` per scan) ends the scan as `partial` with an
explicit reason and a way to continue — never as a silent first-N "success".

**Source pages are optional and guarded.** `mode: "source_page"` makes the main process fetch
`entry.url` through the same guarded fetcher the app's reader uses: public `http(s)` only, every
redirect hop resolved and checked, no private or loopback destination, no credentials from Folo
forwarded, no agent-supplied URL anywhere in the API. The fetch only happens while the **article
page permission** in the settings is on: with it off the call is refused after account identity and
scan validation, but before content resolution or any request to the article site, with
`SOURCE_PAGE_DISABLED` and the message "Article page fetching is turned off in Folo's settings; use
the cached or detail mode". The permission is checked on the mode a call actually reads in, so a
continuation cursor that carries `source_page` is refused the same way as an explicit `mode`.
Turning the permission off aborts the page reads that are still running and discards their answer:
the stored text is then returned with a `source_page_unavailable` warning (and no further page is
requested). If a page cannot be read while the permission is on, the stored text is returned with
the same warning, or the failure is reported per entry when there is no stored text.

## Read-only, and why that is enforced in more than one place

The endpoint cannot change what the user has read:

- no tool marks anything read, and the tool list is asserted to stay that way;
- the renderer half reads local rows and calls account read endpoints directly; it deliberately does
  not use the app's own detail fetch, which would store the entry with `read: false`;
- a source-level test fails if the adapter grows a call to the mark-read paths, the reader, or a
  navigation action.

Reading an entry through the agent therefore does not affect the unread badge, the timeline or the
sync queue.

## Privacy

- The endpoint listens on `127.0.0.1` only, on a fixed port, and requires the dedicated token on
  every request. Requests with an `Origin` header are refused, and the `Host` header must be the
  loopback authority, so a web page in a browser cannot call it.
- The token is a separate secret. It is never the login session, is never sent to the account API,
  and is not shown to an agent by any tool. **Reset token** invalidates the previous one; **Revoke**
  keeps the socket open but refuses every request; switching off closes the socket and drops scans.
- Sign-out, an account switch, a token change and switching the feature off all invalidate
  outstanding scans _and_ in-flight calls. A scan belongs to the account it was started under; an
  answer produced for a different account is refused.
- The agent reaches account data indirectly: the main process asks the app's renderer through a
  narrow bridge. No login cookie, session token or password is ever handed to the agent, and error
  texts the agent sees carry no request headers.
- **A local endpoint is not a local model.** Folo does not choose the model. If the agent sends what
  it read to a cloud model, the article text leaves the machine. Treat article text as untrusted
  input too: Folo does not act on instructions found in it.

## Limits worth knowing

| Limit                                      | Value                                        |
| ------------------------------------------ | -------------------------------------------- |
| Candidates per scan                        | 2000                                         |
| Enumeration budget                         | 60 s per scan                                |
| Concurrent scans                           | 4 (oldest evicted), 15 min TTL               |
| Page size of `folo_list_scan_entries`      | 50 by default, 100 at most                   |
| Account rows requested per page            | 100 at most (the account API's own cap)      |
| Entries per `folo_get_entry_contents` call | 10 at most                                   |
| Text per item                              | 6000 characters, continued with `nextCursor` |
| Requests per minute                        | 120                                          |
| Concurrent tool calls                      | 2                                            |
| Request body                               | 256 KiB                                      |

## Verifying the shipped build

`apps/desktop/e2e/tests/electron/local-agent-reading.spec.ts` starts the built desktop app with a
throwaway profile and drives the endpoint with the official MCP client: guards, tool surface,
status, refusals, token rotation, revoke and shutdown — and, for the two switches, that article page
fetching starts off and that the agent-facing status follows the permission the settings window
sets.

The packaged artifact can be checked the same way after a build (the app must be unpacked first,
which `pnpm run verify:package` does):

```bash
cd apps/desktop
pnpm run build:electron
pnpm run verify:package -- out/make/Folo-<version>-linux-x64.AppImage \
  "folo-local-agent-reading" "folo_begin_unread_scan"
node e2e/scripts/check-packaged-local-agent-reading.mjs out/verify/appimage/squashfs-root
```

Both checks use a throwaway profile (`FOLO_E2E_USER_DATA_DIR`), so they never touch the machine's
Folo profile, and both are signed out by construction: they verify the transport, the guards, the
permission settings and the honest refusals, **not** reading a real account. The packaged check
starts the app twice: the second run asserts that the switch, the endpoint, the token and the
article page permission survive a restart (which is also the only thing that exercises the start-up
path in the main process).

Reading a signed-in account is a manual acceptance step — sign in on a machine you own, enable the
endpoint, connect an agent, and compare the unread list and read state before and after.
