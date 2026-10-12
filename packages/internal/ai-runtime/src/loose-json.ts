/**
 * Parsing of the JSON a model replies with. Models wrap it in a fence, add a sentence before it,
 * or both, so every caller in this directory reads it through here.
 */

/** Strips a ```json … ``` fence without a backtracking-prone regex. */
export const stripCodeFence = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed.startsWith("```")) return trimmed

  const firstNewline = trimmed.indexOf("\n")
  const body = firstNewline === -1 ? trimmed.slice(3) : trimmed.slice(firstNewline + 1)
  const closing = body.lastIndexOf("```")

  return (closing === -1 ? body : body.slice(0, closing)).trim()
}

export const parseJsonLoose = (text?: string | null): unknown => {
  if (!text) return null

  const candidate = stripCodeFence(text)

  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf("{")
    const end = candidate.lastIndexOf("}")
    if (start === -1 || end <= start) return null

    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      return null
    }
  }
}
