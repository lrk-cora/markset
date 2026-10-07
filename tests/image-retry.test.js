import test from 'node:test'
import assert from 'node:assert/strict'
import { requestGatewayImage } from '../server/image-gateway.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const imageResult = () => Response.json({ data: [{ b64_json: png }] })
const options = { baseUrl: 'https://image.test/v1', apiKey: 'private-test-key', model: 'image-test', prompt: 'A red mug', size: '1024x1024', timeoutMs: 1000, requestId: 'same-image-operation', baseDelayMs: 1 }

test('a known pre-connect failure retries once with the same operation id', async () => {
  const ids = []
  const result = await requestGatewayImage({ ...options, fetchImpl: async (_url, init) => {
    ids.push(init.headers['Idempotency-Key'])
    if (ids.length === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })
    return imageResult()
  } })
  assert.deepEqual(ids, [options.requestId, options.requestId])
  assert.equal(result.retriesUsed, 1)
  assert.equal(result.imageUrl, `data:image/png;base64,${png}`)
})

test('an uncertain disconnect or timeout never resubmits without verified idempotency', async () => {
  let calls = 0
  await assert.rejects(requestGatewayImage({ ...options, fetchImpl: async () => {
    calls++
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
  } }), { code: 'image_gateway_unreachable', ambiguous: true })
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(requestGatewayImage({ ...options, timeoutMs: 25, fetchImpl: () => { calls++; return new Promise(() => {}) } }), { code: 'image_timeout', ambiguous: true })
  assert.equal(calls, 1)
})

test('HTTP 502/503/504 cannot cause duplicate generation on an unverified gateway', async () => {
  for (const status of [502, 503, 504]) {
    let calls = 0
    await assert.rejects(requestGatewayImage({ ...options, fetchImpl: async () => { calls++; return new Response('', { status }) } }), { ambiguous: true })
    assert.equal(calls, 1)
  }
})

test('verified provider idempotency enables at most one retry with an unchanged key', async () => {
  let calls = 0
  const ids = []
  const result = await requestGatewayImage({ ...options, providerIdempotency: true, retries: 99, fetchImpl: async (_url, init) => {
    calls++
    ids.push(init.headers['Idempotency-Key'])
    return calls === 1 ? new Response('', { status: 503 }) : imageResult()
  } })
  assert.equal(result.retriesUsed, 1)
  assert.deepEqual(ids, [options.requestId, options.requestId])
  calls = 0
  await assert.rejects(requestGatewayImage({ ...options, providerIdempotency: true, retries: 99, fetchImpl: async () => { calls++; return new Response('', { status: 502 }) } }))
  assert.equal(calls, 2)
})

test('authentication/parameter/quota failures never retry even with provider idempotency', async () => {
  for (const status of [400, 401, 403, 422, 429]) {
    let calls = 0
    await assert.rejects(requestGatewayImage({ ...options, providerIdempotency: true, fetchImpl: async () => { calls++; return new Response('private-test-key', { status }) } }), (error) => {
      assert.equal(error.status, status)
      assert.doesNotMatch(error.message, /private-test-key/)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('a stalled success body is bounded and is not resubmitted', async () => {
  let signal, calls = 0
  await assert.rejects(requestGatewayImage({ ...options, timeoutMs: 25, fetchImpl: async (_url, init) => {
    signal = init.signal; calls++
    return { ok: true, status: 200, json: () => new Promise(() => {}) }
  } }), { code: 'image_timeout' })
  assert.equal(signal.aborted, true)
  assert.equal(calls, 1)
})

test('download retry fetches the existing URL without another generation POST', async () => {
  let posts = 0, gets = 0
  const result = await requestGatewayImage({ ...options, fetchImpl: async (url, init) => {
    if (init.method === 'POST') { posts++; return Response.json({ data: [{ url: 'https://image.test/result.png' }] }) }
    gets++
    assert.equal(url, 'https://image.test/result.png')
    return gets === 1 ? new Response('', { status: 503 }) : new Response(Buffer.from(png, 'base64'))
  } })
  assert.equal(result.retriesUsed, 1)
  assert.equal(posts, 1)
  assert.equal(gets, 2)
})

test('generation and download share the single retry allowance', async () => {
  let posts = 0, gets = 0
  await assert.rejects(requestGatewayImage({ ...options, fetchImpl: async (_url, init) => {
    if (init.method === 'POST') {
      posts++
      if (posts === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      return Response.json({ data: [{ url: 'https://image.test/result.png' }] })
    }
    gets++
    return new Response('', { status: 503 })
  } }), { code: 'image_download_failed' })
  assert.equal(posts, 2)
  assert.equal(gets, 1)
})

test('a stalled image download is bounded and reports known generation success', async () => {
  let posts = 0, downloadSignal
  await assert.rejects(requestGatewayImage({ ...options, timeoutMs: 30, fetchImpl: async (_url, init) => {
    if (init.method === 'POST') { posts++; return Response.json({ data: [{ url: 'https://image.test/result.png' }] }) }
    downloadSignal = init.signal
    return { ok: true, status: 200, arrayBuffer: () => new Promise(() => {}) }
  } }), { code: 'image_download_timeout', ambiguous: false })
  assert.equal(posts, 1)
  assert.equal(downloadSignal.aborted, true)
})

test('empty, malformed JSON, and non-image data do not start a second generation', async () => {
  for (const response of [() => Response.json({ data: [] }), () => new Response('<html>not JSON</html>'), () => Response.json({ data: [{ b64_json: Buffer.from('<html>not an image</html>').toString('base64') }] })]) {
    let calls = 0
    await assert.rejects(requestGatewayImage({ ...options, providerIdempotency: true, fetchImpl: async () => { calls++; return response() } }))
    assert.equal(calls, 1)
  }
})
