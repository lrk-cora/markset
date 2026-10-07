/** View-only SSE, never raw provider deltas, tool arguments or reasoning. */
export function startAnalysisStream(res) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  const emit = (event, data) => {
    if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n') }, 10_000)
  const stop = () => clearInterval(heartbeat)
  res.once('close', stop); res.once('finish', stop)
  res.analysisStream = { finish(status, data) { stop(); emit(status >= 400 ? 'error' : 'result', status >= 400 ? { ...data, status } : data); res.end() } }
  return emit
}
