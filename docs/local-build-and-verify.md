# Building and verifying the desktop app locally

Notes for this fork, collected while packaging the local-AI changes. They assume the repository's
own conventions (`pnpm`, Turbo, electron-forge) and describe what is specific to this machine and
this network.

## Build

```bash
cd apps/desktop
PATH=/usr/bin:$PATH TMPDIR=/home/$USER/tmp-build \
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
  pnpm run build:electron
```

- **Run it in the foreground.** A backgrounded `pnpm run build:electron` has been killed mid-way
  here; the packaging steps then fail with misleading errors.
- **`TMPDIR` must be a real disk.** `/tmp` on this machine is a 16 GB tmpfs and was 81 % full;
  extracting a ~300 MB AppImage into it produced zero-byte files and made a good build look broken.
  Point `TMPDIR` at a directory under `$HOME`.
- **`ELECTRON_MIRROR` is the fix for `Client network socket disconnected before secure TLS
connection was established`.** `@electron/get` fetches `SHASUMS256.txt` from GitHub on every
  packaging run; when GitHub is unreachable from here (it happens), the build dies in
  `Copying files` / `Preparing native dependencies` / `Finalizing package` at once. The mirror is
  fetched instead:

  ```bash
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm run build:electron
  ```

  The mirror also seeds a second entry in `~/.cache/electron` (the cache is keyed by URL), so the
  first build after switching downloads the ~120 MB Electron zip again.

- **After every `pnpm install`, re-apply the `extract-zip` fix** (`node_modules/extract-zip/index.js`
  needs the `processedEntries` / `maybeFinish(resolve)` patch and the promise-based export), or the
  packaging step hangs on the app archive.
- Artifacts land in `apps/desktop/out/make/Folo-<version>-linux-x64.AppImage` and
  `apps/desktop/out/make/deb/x64/Folo-<version>-linux-x64.deb`.

## Verify

```bash
cd apps/desktop
pnpm run verify:package                       # newest AppImage
pnpm run verify:package -- path/to.AppImage   # a specific one
pnpm run verify:package -- "data-reduce-progress" "reduce_fetching"   # + strings that must be inside
```

`scripts/verify-package.ts` extracts the AppImage and its `app.asar` under `out/verify/` (on the
repository's disk, never `/tmp`), reports the size of the bundle (an empty `app.asar` means the
packaging step produced nothing), runs `scripts/check-asar-externals.ts` — the check that caught
`zod` and `@ai-sdk/provider-utils` being imported but not packaged — looks for any markers it was
given, and prints the sha256 of every artifact.

Installing the deb version over an older one needs `--reinstall`:

```bash
sudo dpkg -i --reinstall apps/desktop/out/make/deb/x64/Folo-1.15.0-linux-x64.deb
```

## When the running app looks broken

- `nss_util.cc:377 … NSS error code: -8018` and `auth.fetchWithAuth: net::ERR_TIMED_OUT` are about
  Folo's own services in this network, not about local AI: local AI talks to your endpoint only.
- `Failed to sync session to CLI` / a slow `setting sync` / a failing update check are the same
  network story.
- The AppImage does **not** need `--no-sandbox`: the browser process runs with the user-namespace
  sandbox, and running with the flag only removes it.
- The reduce pre-pass logs what it did — `[local-ai] fetch: 3 of 11 article text(s) read
(8 unreachable) in 2794ms`, `[local-ai] reduce: 47 of 47 entrie(s) summarised in 5 call(s)
(12 cached)` — and the notes cache lives in
  `~/.config/Folo/local-ai-notes.json` (delete it to summarize everything again).
