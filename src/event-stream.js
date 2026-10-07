/** Bounded SSE reader shared by browser and server. UTF-8 and CRLF may split
 * anywhere across chunks. Cancellation covers body reads, not only headers. */
export async function readEventStream(body, onEvent, { signal, maxEventChars = 1_000_000 } = {}) {
  if (!body?.getReader) throw new Error('missing-event-stream')
  const reader = body.getReader(), decoder = new TextDecoder()
  let buffer = '', event = 'message', data = [], size = 0, ended = false
  let rejectAbort
  const aborted = new Promise((_, reject) => { rejectAbort = reject })
  const cancel = () => { rejectAbort(signal.reason); void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  const dispatch = () => {
    if (data.length) onEvent({ event, data: data.join('\n') })
    event = 'message'; data = []; size = 0
  }
  const line = (value) => {
    if (!value) return dispatch()
    if (value.startsWith(':')) return
    const colon = value.indexOf(':'), field = colon < 0 ? value : value.slice(0, colon)
    let content = colon < 0 ? '' : value.slice(colon + 1)
    if (content.startsWith(' ')) content = content.slice(1)
    if (field === 'event') event = content
    if (field === 'data') {
      size += content.length
      if (size > maxEventChars) throw new Error('event-stream-too-large')
      data.push(content)
    }
  }
  try {
    signal?.throwIfAborted()
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted])
      signal?.throwIfAborted()
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, newline).replace(/\r$/u, '')); buffer = buffer.slice(newline + 1)
      }
      if (buffer.length + size > maxEventChars) throw new Error('event-stream-too-large')
      if (chunk.done) { if (buffer) line(buffer.replace(/\r$/u, '')); dispatch(); ended = true; break }
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    if (!ended) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
