/**
 * Let the stream watchdog bound LM Studio prompt evaluation and token gaps.
 * @param input - request URL or Request.
 * @param init - request options, including caller cancellation.
 * @returns the response using the existing proxy policy and connection pool.
 */
export const fetchLmStudioStream: typeof fetch = async (input, init) => {
  const { getGlobalDispatcher } = await import('undici')
  // Retain the process proxy policy and connection pool.
  const dispatcher = getGlobalDispatcher().compose(dispatch => (opts, handler) =>
    dispatch({ ...opts, headersTimeout: 0, bodyTimeout: 0 }, handler))
  return fetch(input, { ...init, dispatcher } as RequestInit)
}
