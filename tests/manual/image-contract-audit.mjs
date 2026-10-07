// Offline fault injection against production middleware. No provider charges.
import { createServer } from 'node:http'
import { setTimeout as nativeSetTimeout } from 'node:timers'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { marksetApi } from '../../server/plugin.js'

const outputDir = path.resolve(process.argv[2] || 'test-results/image-contract-audit')
await mkdir(outputDir, { recursive: true })
const nativeFetch = globalThis.fetch
const nativeGlobalTimer = globalThis.setTimeout
let middleware, mode = '', outgoing, releaseBody
const env = { MARKSET_IMAGE_BASE_URL: 'https://image.test/v1', MARKSET_IMAGE_API_KEY: 'synthetic-test-key', MARKSET_IMAGE_MODEL: 'image-test-model', MARKSET_ALLOW_MODEL_CALLS: '1', MARKSET_IMAGE_TIMEOUT_MS: '30000' }
marksetApi(env).configureServer({ middlewares: { use(fn) { middleware = fn } } })
const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end() }))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}/api/generate-image`
const results = []
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://image.test/')) return nativeFetch(url, init)
  const body = JSON.parse(init.body)
  outgoing = { path: new URL(url).pathname, model: body.model, size: body.size, hasReferenceImage: Object.keys(body).some((name) => /image|reference/i.test(name)), fields: Object.keys(body) }
  if (mode === 'upstream-504') return Response.json({ error: { message: 'Upstream timed out' } }, { status: 504 })
  if (mode === 'upstream-auth') return Response.json({ error: { message: 'Invalid synthetic-test-key' } }, { status: 401 })
  if (mode === 'empty-result') return Response.json({ data: [] })
  if (mode === 'invalid-json') return new Response('<html>Bad Gateway</html>', { status: 200 })
  if (mode === 'body-deadline') return {
    status: 200, ok: true,
    json: () => new Promise((resolve, reject) => {
      releaseBody = () => resolve({ data: [] })
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    }),
  }
  return Response.json({ data: [{ b64_json: 'synthetic-base64-image' }] })
}
const post = async (payload, signal) => {
  const response = await nativeFetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal })
  const body = await response.json()
  return { status: response.status, code: body.code || '', error: body.error || '', containsTestKey: JSON.stringify(body).includes(env.MARKSET_IMAGE_API_KEY) }
}
try {
  for (const id of ['missing-prompt', 'empty-result', 'invalid-json', 'upstream-504', 'upstream-auth', 'replacement-reference']) {
    mode = id
    outgoing = null
    const payload = id === 'missing-prompt' ? { prompt: '' } : id === 'replacement-reference'
      ? { prompt: 'Make the original mug red and preserve all other image content', replaceExisting: true, imageDataUrl: 'data:image/png;base64,synthetic-reference', width: 600, height: 600 }
      : { prompt: 'A simple coffee mug', width: 600, height: 600 }
    const response = await post(payload)
    results.push({ id, ...response, outgoing })
  }
  mode = 'body-deadline'
  // Accelerate only the production gateway's >=30s timer to 15ms.
  // A separate native watchdog proves whether it covers response-body reads.
  globalThis.setTimeout = (callback, milliseconds, ...args) => nativeGlobalTimer(callback, milliseconds >= 30_000 ? 15 : milliseconds, ...args)
  const controller = new AbortController()
  let watchdog
  const observed = await Promise.race([
    post({ prompt: 'A coffee mug' }, controller.signal).then((result) => ({ completedWithinDeadline: true, ...result })),
    new Promise((resolve) => { watchdog = nativeSetTimeout(() => resolve({ completedWithinDeadline: false, observedMilliseconds: 200, acceleratedGatewayDeadlineMs: 15 }), 200) }),
  ])
  clearTimeout(watchdog)
  results.push({ id: mode, ...observed })
  releaseBody?.()
  controller.abort()
} finally {
  globalThis.fetch = nativeFetch
  globalThis.setTimeout = nativeGlobalTimer
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  const reportPath = path.join(outputDir, 'contract-audit.json')
  await writeFile(reportPath, JSON.stringify({ scope: 'Mocked faults, no live AI requests', results }, null, 2))
  console.log(JSON.stringify({ reportPath, results }))
}
