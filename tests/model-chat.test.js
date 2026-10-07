import test from 'node:test'
import assert from 'node:assert/strict'
import { requestModelChat } from '../server/model-chat.js'
import { analysisIssue } from '../src/analysis-errors.js'

const options = { baseUrl: 'https://gateway.test/v1', apiKey: 'private-test-key', model: 'test', messages: [], retries: 0, timeoutMs: 1000 }

test('attempt timing includes failed attempts and full body reads without recording prompts or keys', async () => {
  const attempts = []
  let calls = 0
  await requestModelChat({ ...options, retries: 1, baseDelayMs: 1, onAttempt: value => attempts.push(value), fetchImpl: async () => {
    if (++calls === 1) return new Response('', { status: 502 })
    return Response.json({ choices: [{ message: { content: 'ok' } }] })
  } })
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0].succeeded, false); assert.equal(attempts[1].succeeded, true)
  assert.ok(attempts.every(attempt => attempt.elapsedMs >= 0 && attempt.headersMs >= 0))
  assert.doesNotMatch(JSON.stringify(attempts), /private-test-key|messages|content/)
  const hung = []
  await assert.rejects(requestModelChat({ ...options, timeoutMs: 20, onAttempt: value => hung.push(value), fetchImpl: () => new Promise(() => {}) }), { code: 'model_total_timeout', timeoutSource: 'local', timeoutStage: 'total' })
  assert.equal(hung.length, 1); assert.equal(hung[0].aborted, true)
})

test('gateway distinguishes status errors without exposing provider bodies', async () => {
  for (const [status, code] of [[502, 'model_gateway_upstream'], [504, 'model_gateway_timeout'], [401, 'model_gateway_auth'], [429, 'model_gateway_rate_limit']]) {
    await assert.rejects(requestModelChat({ ...options, fetchImpl: async () => new Response('private-test-key / <html>internal details</html>', { status }) }), (error) => {
      assert.equal(error.code, code)
      assert.equal(error.status, status)
      assert.equal(error.upstreamStatus, status)
      assert.doesNotMatch(error.message, /private-test-key|internal details/)
      assert.match(analysisIssue(error).message, new RegExp(String(status)))
      return true
    })
  }
})

test('empty, malformed and valid gateway responses are distinct', async () => {
  for (const [body, code] of [['<html>not JSON</html>', 'model_gateway_invalid_response'], ['{}', 'model_gateway_empty'], ['null', 'model_gateway_empty']]) {
    await assert.rejects(requestModelChat({ ...options, fetchImpl: async () => new Response(body) }), { code })
  }
  assert.equal(await requestModelChat({ ...options, fetchImpl: async () => Response.json({ choices: [{ message: { content: [{ type: 'text', text: 'ok' }] } }] }) }), 'ok')
})

test('deadline includes a hung response body, not just fetching response headers', async () => {
  let signal
  await assert.rejects(requestModelChat({ ...options, timeoutMs: 15, fetchImpl: async (_url, init) => {
    signal = init.signal
    return { ok: true, status: 200, json: () => new Promise(() => {}) }
  } }), { status: 504, code: 'model_total_timeout' })
  assert.equal(signal.aborted, true)
})

test('deadline releases a hung connection and bounded retries never hide transport failure', async () => {
  await assert.rejects(requestModelChat({ ...options, timeoutMs: 15, fetchImpl: () => new Promise(() => {}) }), { code: 'model_total_timeout' })
  let calls = 0
  await assert.rejects(requestModelChat({ ...options, retries: 1, fetchImpl: async () => {
    calls++
    throw Object.assign(new TypeError('private-test-key'), { cause: { code: 'ECONNRESET' } })
  } }), { status: 502, code: 'model_gateway_unreachable', causeCode: 'ECONNRESET' })
  assert.equal(calls, 2)
})

test('UI messages never echo raw server details and only accept bounded request ids', () => {
  const issue = analysisIssue({ status: 502, message: '<script>private key</script>', requestId: 'probe-123' })
  assert.match(issue.message, /AI 网关.*502/)
  assert.equal(issue.requestId, 'probe-123')
  assert.doesNotMatch(issue.message, /script|private/)
  assert.equal(analysisIssue({ requestId: '<unsafe>' }).requestId, '')
  assert.match(analysisIssue({ name: 'TimeoutError' }).message, /超时/)
})

test('two transient HTTP failures recover on the third and final attempt', async () => {
  let calls = 0
  const result = await requestModelChat({ ...options, retries: 2, baseDelayMs: 1, fetchImpl: async () => {
    calls++
    return calls < 3 ? new Response('', { status: calls === 1 ? 502 : 503 }) : Response.json({ choices: [{ message: { content: 'recovered' } }] })
  } })
  assert.equal(result, 'recovered')
  assert.equal(calls, 3)
})

test('persistent transient failure is capped at three calls', async () => {
  let calls = 0
  await assert.rejects(requestModelChat({ ...options, retries: 99, baseDelayMs: 1, fetchImpl: async () => {
    calls++
    return new Response('', { status: 504 })
  } }), { code: 'model_gateway_timeout' })
  assert.equal(calls, 3)
})

test('authentication, invalid parameters, quota, and TLS errors are not retried', async () => {
  for (const status of [400, 401, 403, 404, 422, 429]) {
    let calls = 0
    await assert.rejects(requestModelChat({ ...options, retries: 2, baseDelayMs: 1, fetchImpl: async () => {
      calls++
      return new Response('', { status })
    } }))
    assert.equal(calls, 1)
  }
  let calls = 0
  await assert.rejects(requestModelChat({ ...options, retries: 2, fetchImpl: async () => {
    calls++
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } })
  } }))
  assert.equal(calls, 1)
})

test('a timed-out first attempt can recover within the total deadline', async () => {
  let calls = 0, firstSignal
  const result = await requestModelChat({ ...options, retries: 2, timeoutMs: 1000, attemptTimeoutMs: 20, baseDelayMs: 1, fetchImpl: async (_url, init) => {
    calls++
    if (calls === 1) { firstSignal = init.signal; return new Promise(() => {}) }
    return Response.json({ choices: [{ message: { content: 'recovered' } }] })
  } })
  assert.equal(result, 'recovered')
  assert.equal(calls, 2)
  assert.equal(firstSignal.aborted, true)
})

test('cancelling during backoff prevents all later attempts', async () => {
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(requestModelChat({ ...options, signal: controller.signal, retries: 2,
    onRetry: () => controller.abort(), fetchImpl: async () => { calls++; return new Response('', { status: 502 }) },
  }), { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('Retry-After longer than the total budget prevents an early retry', async () => {
  let calls = 0
  await assert.rejects(requestModelChat({ ...options, retries: 2, fetchImpl: async () => {
    calls++
    return new Response('', { status: 503, headers: { 'Retry-After': '120' } })
  } }), { code: 'model_gateway_upstream' })
  assert.equal(calls, 1)
})
