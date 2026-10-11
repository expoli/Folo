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

## Releases and updates

The app updates itself from this fork's own GitHub releases, not from Folo's OTA service:
`electron-updater` runs with the built-in GitHub provider and reads owner/repo from
`apps/desktop/layer/main/src/constants/app.ts`. The renderer hot update and its `/manifest` +
`/policy` endpoints are not part of this fork any more, and the feed is the plain
`latest*.yml` channel file that `electron-forge make` writes next to the installers.

`.github/workflows/release-desktop.yml` builds Linux, macOS and Windows and publishes them as one
release. Run it from the Actions tab (the fork needs its workflows enabled once — Actions tab,
“I understand my workflows, go ahead and enable them”; upstream's `build-*` workflows can be
disabled there too, they need secrets this fork does not have):

1. Bump `version` in `apps/desktop/package.json`. An installed build only offers an update when the
   release version is _higher_, so keep the versions increasing: `releases/latest` is the entry point
   of the feed, and the workflow refuses a version whose tag already exists (as a release or as a
   leftover draft).
2. Optionally add `apps/desktop/changelog/<version>.md`; it becomes the release notes.
3. Run “🚀 Release Desktop”. The tag is `v<version>`, not upstream's `desktop/v<version>`:
   electron-updater matches releases against the `releases.atom` entries with `/\/tag\/(v?[^/]+)$/`,
   which a tag containing a slash never matches, and the prerelease channel path additionally needs a
   semver tag. The version comparison itself reads the `version` inside `latest*.yml`, and the stable
   channel takes the tag from `releases/latest` whatever its shape — so the plain tag is a convention
   the tooling around it relies on, not something `releases/latest` enforces.

An installed build checks every 15 minutes (`checkUpdateInterval`). The AppImage and the Windows
installer download and install the update themselves and then ask for a restart; the `.deb` package
and the unsigned macOS bundle get the notice that opens the release page instead, because neither
can be replaced while running (the `.deb` has no `package-type` marker for electron-updater to pick a
Deb updater with, and Squirrel.Mac requires a signed bundle):

```bash
sudo dpkg -i --reinstall Folo-<version>-linux-x64.deb
```

If the packaging step hangs on a runner the way it does on this machine, the workaround noted above
belongs in the repository as a pnpm patch (`patchedDependencies`), not in `node_modules`.

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
