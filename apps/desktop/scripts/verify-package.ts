/**
 * Verifies a packaged build end to end, in one command: extracts the AppImage, extracts the app
 * bundle out of it, checks that every runtime dependency of the main process resolves (the check
 * that caught `zod` and `@ai-sdk/provider-utils`), reports how big the bundle is — an empty one
 * means the packaging step produced nothing — and prints the sha256 of every artifact.
 *
 * Everything happens under `out/verify/`, on the repository's own disk: extracting into `/tmp` has
 * produced zero-byte files on a full tmpfs and made a good build look broken.
 *
 * Usage:
 *   pnpm run verify:package                                  # newest AppImage in out/make
 *   pnpm run verify:package -- <path/to.AppImage>
 *   pnpm run verify:package -- "data-reduce-progress" "reduce_fetching"   # strings to find inside
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"

import path from "pathe"

// `pnpm run x -- a b` hands the arguments over as written, separator included.
const args = process.argv.slice(2).filter((argument) => argument !== "--")
const requested = args.find((argument) => argument.endsWith(".AppImage"))
const markers = args.filter((argument) => !argument.endsWith(".AppImage"))

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
const desktopDir = path.join(repoRoot, "apps/desktop")
const makeDir = path.join(desktopDir, "out/make")

const findAppImage = () => {
  if (requested) return path.resolve(process.cwd(), requested)

  const candidates = fs
    .readdirSync(makeDir)
    .filter((name) => name.endsWith(".AppImage"))
    .map((name) => path.join(makeDir, name))
  if (candidates.length === 0) {
    console.error(`no AppImage in ${makeDir}: run \`pnpm run build:electron\` first`)
    process.exit(2)
  }

  // The newest one, which is what a just-finished build produced.
  return candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]!
}

const appImage = findAppImage()
if (!fs.existsSync(appImage)) {
  console.error(`no such file: ${appImage}`)
  process.exit(2)
}

const verifyDir = path.join(desktopDir, "out/verify")
const appDir = path.join(verifyDir, "appimage")
const asarDir = path.join(verifyDir, "asar")
fs.rmSync(verifyDir, { recursive: true, force: true })
fs.mkdirSync(appDir, { recursive: true })

console.log(`appimage: ${appImage}`)
fs.chmodSync(appImage, 0o755)
execFileSync(appImage, ["--appimage-extract"], { cwd: appDir, stdio: "inherit" })

const appResources = path.join(appDir, "squashfs-root/resources")
const appAsar = path.join(appResources, "app.asar")
if (!fs.existsSync(appAsar)) {
  console.error(`the AppImage has no ${appAsar}`)
  process.exit(1)
}

const asarSize = fs.statSync(appAsar).size
console.log(`app.asar: ${asarSize} bytes`)
if (asarSize === 0) {
  console.error("app.asar is empty: the packaging step failed (check the build log and its TMPDIR)")
  process.exit(1)
}

const asarBin = path.join(repoRoot, "node_modules/.bin/asar")
execFileSync(asarBin, ["extract", appAsar, asarDir], { stdio: "inherit" })

console.log("")
execFileSync(
  path.join(repoRoot, "node_modules/.bin/tsx"),
  ["scripts/check-asar-externals.ts", asarDir],
  {
    cwd: desktopDir,
    stdio: "inherit",
  },
)

if (markers.length > 0) {
  console.log("\nmarkers inside the bundle:")
  const bundle = fs.readFileSync(appAsar)
  let missing = 0
  for (const marker of markers) {
    const hits = bundle.toString("latin1").split(marker).length - 1
    if (hits === 0) missing += 1
    console.log(`  ${hits > 0 ? "found  " : "MISSING"}  ${marker} (${hits})`)
  }

  if (missing > 0) process.exit(1)
}

const debDir = path.join(makeDir, "deb/x64")
const artifacts = [
  appImage,
  ...(fs.existsSync(debDir)
    ? fs
        .readdirSync(debDir)
        .filter((name) => name.endsWith(".deb"))
        .map((name) => path.join(debDir, name))
    : []),
]

console.log("\nartifacts:")
for (const artifact of [...new Set(artifacts)]) {
  const digest = createHash("sha256").update(fs.readFileSync(artifact)).digest("hex")
  console.log(`  sha256 ${digest}  ${path.relative(repoRoot, artifact)}`)
}

console.log("\nRESULT: package verified")
