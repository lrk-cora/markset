import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelStatusProbe } from '../server/model-status.js'

const config = { baseUrl: 'https://gateway.test/v1', apiKey: 'secret-test-key', model: 'test-model' }
const make = (options = {}) => createModelStatusProbe({ analysis: config, image: config, allowCalls: true, ...options })
const completion = () => Response.json({ choices: [{ message: { content: 'OK' } }] })

test('status probes use a tiny completion and authenticated model list; never generate an image', async () => {
  const calls = []
  const probe = make({ fetchImpl: async (url, init) => {
    calls.push({ url, init })
    assert.equal(init.headers.Authorization, 'Bearer secret-test-key')
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'test-model' }] })
    const body = JSON.parse(init.body)
    assert.equal(body.max_tokens, 8)
    assert.equal(body.messages.length, 1)
    assert.equal(body.messages[0].content, 'Reply OK.')
    return completion()
  } })
  const first = await probe()
  assert.deepEqual(first.results.map((item) => item.state), ['available', 'available'])
  assert.equal(first.results[1].generationVerified, false)
  assert.equal(first.results[1].modelListed, true)
  assert.doesNotMatch(JSON.stringify(first), /secret-test-key|https:\/\//u)
  assert.deepEqual(calls.map((call) => call.url).sort(), ['https://gateway.test/v1/chat/completions', 'https://gateway.test/v1/models'])
  const cached = await probe()
  assert.ok(cached.results.every((item) => item.cached))
  assert.equal(calls.length, 2)
})

test('in-flight probes are shared and cooldown expires', async () => {
  let clock = 1000, calls = 0
  let release
  const probe = make({ now: () => clock, fetchImpl: () => { calls++; return new Promise((resolve) => { release = () => resolve(completion()) }) } })
  const first = probe('analysis'), second = probe('analysis')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  release()
  assert.deepEqual(await first, await second)
  clock += 6000
  const third = probe('analysis')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 2)
  release(); await third
})

test('missing keys and disabled calls never contact providers', async () => {
  const fetchImpl = () => { throw new Error('must not contact provider') }
  assert.ok((await make({ allowCalls: false, fetchImpl })()).results.every((item) => item.state === 'disabled'))
  assert.ok((await make({ analysis: { ...config, apiKey: '' }, image: { ...config, apiKey: '' }, fetchImpl })()).results.every((item) => item.state === 'unconfigured'))
})

test('each probe is bounded, including a hung image response body, with no retries', async () => {
  let calls = 0
  const probe = make({ timeoutMs: 25, fetchImpl: async (url) => {
    calls++
    if (url.endsWith('/models')) return { ok: true, json: () => new Promise(() => {}) }
    return new Promise(() => {})
  } })
  const start = Date.now()
  const data = await probe()
  assert.ok(Date.now() - start < 1000)
  assert.ok(data.results.every((item) => item.state === 'timeout'))
  assert.equal(calls, 2)
})

test('auth, quota, unsupported lists and unlisted models are honestly distinguished', async () => {
  for (const [status, expected] of [[401, 'auth-error'], [403, 'auth-error'], [429, 'busy'], [502, 'error'], [404, 'unverified'], [405, 'unverified']]) {
    const data = await make({ fetchImpl: async () => new Response('secret-test-key private-error', { status }) })('image')
    assert.equal(data.results[0].state, expected)
    assert.doesNotMatch(JSON.stringify(data), /secret-test-key|private-error/u)
  }
  const data = await make({ fetchImpl: async () => Response.json({ data: [{ id: 'different-model' }] }) })('image')
  assert.equal(data.results[0].state, 'unverified')
  assert.equal(data.results[0].modelListed, false)
  assert.equal(data.results[0].generationVerified, false)
})

test('provider exceptions and malformed responses do not leak credentials or report success', async () => {
  for (const provider of [async () => { throw new Error('secret-test-key') }, async () => new Response('not JSON'), async () => Response.json({ models: [] })]) {
    const data = await make({ fetchImpl: provider })('image')
    assert.notEqual(data.results[0].state, 'available')
    assert.doesNotMatch(JSON.stringify(data), /secret-test-key/u)
  }
  await assert.rejects(make()('evil'), (error) => error.status === 400)
})

test('an empty completion is a reachable but unverified model, not a disconnected service', async () => {
  const data = await make({ fetchImpl: async () => Response.json({ choices: [{ message: { content: '' } }] }) })('analysis')
  assert.equal(data.results[0].state, 'unverified')
  assert.match(data.results[0].message, /网关已响应/u)
})
