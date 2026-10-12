/**
 * Bundles the gateway into `dist/server.mjs`.
 *
 * `server.mjs` and the `@follow/ai-runtime` sources it imports are TypeScript-agnostic to Node only
 * after this step: the runtime package ships its sources (like every other internal package, so the
 * apps can typecheck against them directly), and bundling them here produces the one artifact Node
 * 22 runs without a loader.
 *
 * The AI SDK packages stay external: they are dependencies of this package and are resolved from
 * `node_modules` at run time, exactly like any other dependency.
 */
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

const directory = fileURLToPath(new URL("..", import.meta.url))

await build({
  entryPoints: [`${directory}server.mjs`],
  outfile: `${directory}dist/server.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["ai", "@ai-sdk/*", "zod"],
  logLevel: "info",
})
