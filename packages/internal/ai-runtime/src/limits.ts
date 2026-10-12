/**
 * Numeric defaults and ceilings of one local model call, in a module without any provider import:
 * the gateway reads the same values but brings its own provider.
 */

/**
 * Output cap of one model call, matching `AI_MAX_OUTPUT_TOKENS`' default in the gateway. It has to
 * cover a reasoning model's thinking: a cap that the reasoning consumes leaves an empty answer.
 */
export const MAX_OUTPUT_TOKENS = 8192

/**
 * Ceilings of the settings fields, so a typo ("20000000") cannot send an unusable request.
 * Everything a user may tune stays well inside these; the point is to stop nonsense, not to cap
 * what a model can do.
 */
export const MAX_OUTPUT_TOKENS_LIMIT = 128_000
export const MIN_CHUNK_CHARS = 500
export const MAX_CHUNK_CHARS = 200_000
export const MAX_CONCURRENCY = 16
/** The range every OpenAI-compatible endpoint understands; 0 means "as deterministic as possible". */
export const MAX_TEMPERATURE = 2

/**
 * A positive number inside `[min, max]`. A missing, zero or negative value means "not set" — that is
 * how the settings leave a field empty — and the ceiling is what keeps a typo from reaching the
 * provider.
 */
export const boundedNumber = (
  value: number | null | undefined,
  min: number,
  max: number,
): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : undefined

/** Same as `boundedNumber`, without rounding: a temperature may be fractional. */
export const clampedNumber = (
  value: number | null | undefined,
  min: number,
  max: number,
): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : undefined
