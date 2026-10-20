/**
 * Cancellation of a bridge call.
 *
 * The main process stops waiting when a tool call times out or is aborted, and asks the renderer to
 * stop working on it. `executeJavaScript` cannot abort a running call, so this registry is what
 * makes the request stop at the next account request instead of continuing for nobody.
 */
const controllers = new Map<string, AbortController>()

export const cancelActiveRequest = (requestId: string) => {
  controllers.get(requestId)?.abort()
}

/** Run a bridge call with a signal the main process can abort. */
export const runCancellable = async <T>(
  requestId: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController()
  controllers.set(requestId, controller)
  try {
    return await run(controller.signal)
  } finally {
    if (controllers.get(requestId) === controller) {
      controllers.delete(requestId)
    }
  }
}

/** Test helper: how many calls are in flight. */
export const activeRequestCount = () => controllers.size
