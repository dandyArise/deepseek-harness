/** Let the stream watchdog bound LM Studio prompt evaluation and token gaps. */
export const fetchLmStudioStream: typeof fetch = async (input, init) => {
  const { getGlobalDispatcher } = await import('undici')
  // Retain the process proxy policy and connection pool.
  const dispatcher = getGlobalDispatcher().compose(dispatch => (opts, handler) =>
    dispatch({ ...opts, headersTimeout: 0, bodyTimeout: 0 }, handler))
  return fetch(input, { ...init, dispatcher } as RequestInit)
}
