/** Splits long text at paragraph boundaries, falling back to hard cuts for huge paragraphs. */
export const splitIntoChunks = (text: string, maxChars: number): string[] => {
  const chunks: string[] = []
  let current = ""

  const flush = () => {
    if (current.trim()) chunks.push(current.trim())
    current = ""
  }

  for (const block of text.split(/\n{2,}/)) {
    if (block.length > maxChars) {
      flush()
      for (let index = 0; index < block.length; index += maxChars) {
        chunks.push(block.slice(index, index + maxChars))
      }
      continue
    }

    if (current && current.length + block.length + 2 > maxChars) flush()
    current = current ? `${current}\n\n${block}` : block
  }
  flush()

  return chunks.length > 0 ? chunks : [text]
}
