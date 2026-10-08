import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { marksetApi, brushIntent } from '../server/plugin.js'
import { buildBrushRegions } from '../src/brush-regions.js'

test('brush API failures carry a request id, stable code and sanitized diagnostics', async () => {
  const nativeFetch = globalThis.fetch
  const nativeWarn = console.warn
  const logs = []
  const env = { MARKSET_MODEL_BASE_URL: 'https://gateway.test/v1', MARKSET_MODEL_API_KEY: 'private-test-key', MARKSET_ALLOW_MODEL_CALLS: '1', MARKSET_BRUSH_MODEL: 'test' }
  let middleware, providerStatus = 502
  marksetApi(env).configureServer({ middlewares: { use(fn) { middleware = fn } } })
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://gateway.test/')) {
      const body = JSON.parse(init.body)
      assert.ok(body.messages.length >= 2)
      assert.ok(!body.messages[1].content[0].text.includes('你是 Markset 的网页修改规划器'), 'system rules must not be duplicated in user context')
      return providerStatus === 200
        ? Response.json({ choices: [{ message: { content: 'not a JSON plan' } }] })
        : new Response('<html>private-test-key and internal details</html>', { status: providerStatus })
    }
    return nativeFetch(url, init)
  }
  console.warn = (...args) => logs.push(args.join(' '))
  try {
    for (const [status, code, returnedStatus] of [[502, 'model_gateway_upstream', 502], [401, 'model_gateway_auth', 401], [400, 'model_gateway_request', 400], [200, 'agent_plan_invalid', 422]]) {
      providerStatus = status
      const res = await nativeFetch(`http://127.0.0.1:${server.address().port}/api/brush-intent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets: [], userInstruction: 'PRIVATE_REQUEST_TEXT' }),
      })
      const body = await res.json()
      assert.equal(res.status, returnedStatus)
      assert.equal(body.code, code)
      assert.equal(body.model, 'test')
      assert.equal(body.retriesUsed, status === 502 ? 2 : 0)
      assert.equal(body.routing.model, body.model)
      assert.ok(body.elapsedMs >= 0)
      assert.match(body.requestId, /^[\w-]{36}$/u)
      assert.equal(res.headers.get('X-Request-Id'), body.requestId)
      assert.ok(logs.at(-1).includes(body.requestId))
      assert.doesNotMatch(JSON.stringify(body) + logs.join('\n'), /private-test-key|PRIVATE_REQUEST_TEXT|internal details/)
    }
  } finally {
    globalThis.fetch = nativeFetch
    console.warn = nativeWarn
    await new Promise((resolve) => server.close(resolve))
  }
})

test('the actual backend forwards matching UI region numbers to the planner and keeps real execution IDs', async () => {
  const nativeFetch = globalThis.fetch
  const targets = [{ webId: 'left', kind: 'text', text: '左标题', documentRect: { x: 10, y: 20, w: 160, h: 70 } }, { webId: 'right', kind: 'text', text: '右标题', documentRect: { x: 300, y: 20, w: 160, h: 70 } }]
  const strokes = [{ id: 'blank', closed: true, shape: 'box', points: [{ x: 490, y: 20 }, { x: 610, y: 20 }, { x: 610, y: 160 }, { x: 490, y: 160 }] }]
  const regions = buildBrushRegions({ targets: targets.toReversed(), strokes })
  let context
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init.body)
    assert.match(body.messages[0].content, /regions.*区域序号映射/u)
    context = JSON.parse(body.messages[1].content[0].text.replace(/^上下文 JSON：/u, ''))
    return Response.json({ choices: [{ message: { content: JSON.stringify({ intentType: 'color', targetIds: ['right'], confidence: 0.9, color: '#ff0000', goal: '仅将区域2改红', rationale: '用户明确指定', strategy: '保留区域1与3', impact: { scope: '区域2', riskLevel: 'low' }, suggestion: '将区域 2 改为红色，其他区域保持不变。' }) } }] })
  }
  try {
    const result = await brushIntent({ MARKSET_MODEL_BASE_URL: 'https://gateway.test/v1', MARKSET_MODEL_API_KEY: 'test-only', MARKSET_ALLOW_MODEL_CALLS: '1', MARKSET_BRUSH_MODEL: 'test' }, { targets: targets.toReversed(), strokes, regions, userInstruction: '区域2改为红色，其他不变' })
    assert.deepEqual(context.regions, regions)
    assert.deepEqual(context.targets.map(t => [t.webId, t.regionNumber]), [['right', 2], ['left', 1]])
    assert.deepEqual(result.intent.targets.map(t => t.webId), ['right'])
    assert.match(context.imageNotes, /角标.*序号/u)
  } finally { globalThis.fetch = nativeFetch }
})

test('invalid correction objects are rejected before any upstream call',async()=>{
  const nativeFetch=globalThis.fetch
  let calls=0
  globalThis.fetch=async()=>{calls++;throw new Error('No network allowed')}
  try {
    await assert.rejects(brushIntent({MARKSET_MODEL_BASE_URL:'https://gateway.test/v1',MARKSET_MODEL_API_KEY:'dummy-not-a-secret',MARKSET_ALLOW_MODEL_CALLS:'1',MARKSET_BRUSH_MODEL:'test'},{targets:[],regions:[],bindingCorrections:{version:1,revision:1,bindings:[{regionId:'fabricated',role:'change',targetIds:['foreign']}],relations:[]}}),error=>{assert.equal(error.status,422);return true})
    assert.equal(calls,0)
  } finally {globalThis.fetch=nativeFetch}
})
