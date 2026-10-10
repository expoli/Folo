/**
 * Pre-flight check for a packaged build: every bare import of the main bundle, and of the packages
 * the direct mode keeps for the runtime, has to resolve from the extracted `app.asar`.
 *
 * It exists because a missing runtime dependency does not fail the build: electron-forge packages
 * the app, and the import blows up only when the user presses the feature that needs it. It caught
 * `zod` being a peer dependency of the AI SDK without being packaged (`keepModules` in
 * `forge.config.cts`), and `@ai-sdk/provider-utils` reading `zod/v4` at runtime.
 *
 * Usage:
 *   pnpm run verify:package            # extracts the AppImage and checks it (see verify-package.ts)
 *   tsx scripts/check-asar-externals.ts <extracted-asar-dir>
 */
import fs from "node:fs"
import { createRequire } from "node:module"

import path from "pathe"

const root = process.argv[2]
if (!root) {
  console.error("usage: tsx scripts/check-asar-externals.ts <extracted-asar-dir>")
  process.exit(2)
}

const MAIN = path.join(root, "dist/main/index.js")
if (!fs.existsSync(MAIN)) {
  console.error(
    `main bundle not found at ${MAIN}\n` +
      "an empty app.asar means the packaging step produced nothing: check the build log, the " +
      "TMPDIR of the build (it must not be a small tmpfs) and the electron download cache.",
  )
  process.exit(2)
}

/** Only real package names count: the bundle is full of code strings that look like specifiers. */
const isPackageName = (spec: string) =>
  /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(spec) && !spec.startsWith("node:")

const bareImportsOf = (file: string) => {
  const code = fs.readFileSync(file, "utf8")
  const specs = new Set<string>()
  // Only real module references: the bundle body is full of strings that look like specifiers.
  for (const match of code.matchAll(/^import[^;]*from "([^"]+)"/gm)) specs.add(match[1]!)
  for (const match of code.matchAll(/\brequire\("([^"]+)"\)/g)) specs.add(match[1]!)

  return [...specs].filter((spec) => isPackageName(spec) && spec !== "electron")
}

const resolved = createRequire(path.join(root, "package.json"))
let failed = 0

const check = (spec: string, source?: string) => {
  try {
    resolved.resolve(spec)
    console.log(`  ok       ${spec}${source ? ` (from ${source})` : ""}`)
  } catch {
    failed += 1
    console.log(`  MISSING  ${spec}${source ? ` (from ${source})` : ""}`)
  }
}

console.log("main bundle externals:")
for (const spec of bareImportsOf(MAIN)) check(spec)

// The packages the direct mode loads at runtime, including their own bare imports (e.g. zod/v4).
const runtime = ["@ai-sdk/openai-compatible", "@ai-sdk/provider-utils", "@ai-sdk/provider"]
console.log("\nruntime packages of the direct mode:")
for (const name of runtime) {
  let entry: string
  try {
    entry = resolved.resolve(name)
  } catch {
    failed += 1
    console.log(`  MISSING  ${name}`)
    continue
  }

  console.log(`  ok       ${name}`)
  for (const spec of bareImportsOf(entry)) {
    if (spec === name) continue

    try {
      resolved.resolve(spec)
    } catch {
      failed += 1
      console.log(`  MISSING  ${spec} (from ${name})`)
    }
  }
}

console.log(failed === 0 ? "\nRESULT: all externals resolve" : `\nRESULT: ${failed} missing`)
process.exit(failed === 0 ? 0 : 1)
