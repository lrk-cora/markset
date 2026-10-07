import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { marksetApi } from '../server/plugin.js'
import { generateImage } from '../src/api.js'
import { createImageJobStore } from '../server/image-jobs.js'
import { MODEL_CLIENT_TIMEOUT_MS, modelRequestPolicy } from '../src/request-policy.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

async function fixture(env, provider, task) {
  let middleware
  marksetApi({ MARKSET_ALLOW_MODEL_CALLS: '1', ...env }, {imageJobs:createImageJobStore()}).configureServer({ middlewares: { use(fn) { middleware = fn } } })
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const nativeFetch = globalThis.fetch
  const nativeWarn = console.warn
  globalThis.fetch = (url, init) => String(url).startsWith('https://') ? provider(url, init) : nativeFetch(url, init)
  console.warn = () => {}
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (route, payload, requestId) => nativeFetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(requestId ? { 'Idempotency-Key': requestId } : {}) }, body: JSON.stringify(payload) })
  try { await task({ post, base, nativeFetch }) }
  finally { globalThis.fetch = nativeFetch; console.warn = nativeWarn; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
}

test('the actual brush endpoint enables recovery after two HTTP failures', async () => {
  let calls = 0
  await fixture({ MARKSET_MODEL_BASE_URL: 'https://model.test/v1', MARKSET_MODEL_API_KEY: 'fake-key' }, async () => {
    calls++
    return calls < 3 ? new Response('', { status: 503 }) : Response.json({ choices: [{ message: { content: JSON.stringify({ intentType: 'color', color: '#ff0000', targetIds: ['title'], confidence: 0.95, suggestion: '将标题改为红色',rationale:'用户明确要求红色',strategy:'只调整标题前景色',impact:{scope:'标题',riskLevel:'low'} }) } }] })
  }, async ({ post }) => {
    const response = await post('/api/brush-intent', { targets: [{ webId: 'title', kind: 'text', text: 'Heading' }], userInstruction: '改成红色' })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).intent.type, 'color')
    assert.equal(calls, 3)
  })
})

test('a legacy execution-repair request is rejected before any transport or paid model call',async()=>{
  let calls=0
  await fixture({MARKSET_MODEL_BASE_URL:'https://model.test/v1',MARKSET_MODEL_API_KEY:'fake-key'},async()=>{
    calls++;return new Response('',{status:503})
  },async({post})=>{
    const result=await post('/api/brush-intent',{targets:[],retryBudget:0,repairFeedback:{issues:[{code:'overflow'}]}})
    assert.equal(result.status,422);assert.equal(calls,0)
    const data=await result.json()
    assert.equal(data.retriesUsed,0);assert.equal(data.repairsUsed,0)
    assert.equal(data.reason,'automatic-repair-disabled')
  })
})

test('actual endpoint reports provider 504 and each attempt, not a generic local timer or provider body',async()=>{
  await fixture({MARKSET_MODEL_BASE_URL:'https://model.test/v1',MARKSET_MODEL_API_KEY:'fake-key'},async()=>new Response('PRIVATE_BODY',{status:504}),
    async({post})=>{
      const response=await post('/api/brush-intent',{targets:[],retryBudget:0})
      const data=await response.json()
      assert.equal(response.status,504);assert.equal(data.code,'model_gateway_timeout')
      assert.equal(data.timeoutSource,'upstream');assert.equal(data.timeoutStage,'provider')
      assert.equal(data.timings.attempts.length,1);assert.equal(data.timings.attempts[0].status,504)
      assert.equal(data.timings.attempts[0].request,1);assert.equal(data.timings.attempts[0].timeoutSource,'upstream')
      assert.doesNotMatch(JSON.stringify(data),/PRIVATE_BODY|fake-key|messages|tool_calls/)
    })
})

test('actual endpoint stops on malformed output after one call and exposes only a safe format error',async()=>{
  let calls=0
  await fixture({MARKSET_MODEL_BASE_URL:'https://model.test/v1',MARKSET_MODEL_API_KEY:'fake-key'},async()=>{
    calls++;return Response.json({choices:[{message:{role:'assistant',content:'invalid-private-output'}}]})
  },async({post})=>{
    const response=await post('/api/brush-intent',{targets:[]})
    assert.equal(response.status,422);assert.equal(calls,1)
    const data=await response.json()
    assert.equal(data.repairsUsed,0);assert.equal(data.reason,'invalid-plan-json')
    assert.match(data.error,/格式不完整/);assert.doesNotMatch(JSON.stringify(data),/invalid-private-output|fake-key|已自动修复/)
  })
})

test('image middleware deduplicates pending/completed jobs and rejects parameter changes', async () => {
  let calls = 0
  await fixture({ MARKSET_IMAGE_BASE_URL: 'https://image.test/v1', MARKSET_IMAGE_API_KEY: 'fake-key' }, async (_url, init) => {
    calls++
    assert.equal(init.headers['Idempotency-Key'], 'same-operation')
    await new Promise((resolve) => setTimeout(resolve, 15))
    return Response.json({ data: [{ b64_json: png }] })
  }, async ({ post }) => {
    const responses = await Promise.all([post('/api/generate-image', { prompt: 'mug' }, 'same-operation'), post('/api/generate-image', { prompt: 'mug' }, 'same-operation')])
    assert.deepEqual(responses.map((response) => response.status), [200, 200])
    const values = await Promise.all(responses.map((response) => response.json()))
    assert.deepEqual(values[0], values[1])
    assert.equal(values[0].requestId, 'same-operation')
    assert.equal(calls, 1)
    const replay = await post('/api/generate-image', { prompt: 'mug' }, 'same-operation')
    assert.equal(replay.status, 200)
    assert.equal(calls, 1)
    const conflict = await post('/api/generate-image', { prompt: 'cat' }, 'same-operation')
    assert.equal(conflict.status, 409)
    assert.equal((await conflict.json()).code, 'image_request_conflict')
    assert.equal(calls, 1)
  })
})

test('uncertain image failure is replayed without an automatic provider switch', async () => {
  let calls = 0
  await fixture({ MARKSET_IMAGE_BASE_URL: 'https://image.test/v1', MARKSET_IMAGE_API_KEY: 'fake-key', DASHSCOPE_API_KEY: 'second-fake-key' }, async () => {
    calls++
    return new Response('private upstream text', { status: 504 })
  }, async ({ post }) => {
    for (let i = 0; i < 2; i++) {
      const response = await post('/api/generate-image', { prompt: 'mug' }, 'unknown-operation')
      assert.equal(response.status, 504)
      const data = await response.json()
      assert.equal(data.ambiguous, true)
      assert.equal(data.code, 'image_timeout')
      assert.doesNotMatch(data.error, /private upstream text/)
    }
    assert.equal(calls, 1)
  })
})

test('health publishes retry limits and the client outlives all model budgets', async () => {
  await fixture({}, async () => { throw new Error('Unexpected provider call') }, async ({ nativeFetch, base }) => {
    const health = await nativeFetch(`${base}/api/health`).then((response) => response.json())
    assert.equal(health.retryPolicy.analysis.retries, 2)
    assert.equal(health.retryPolicy.analysis.planRepairs, 0)
    assert.equal(health.retryPolicy.analysis.firstOutputTimeoutMs,30_000)
    assert.equal(health.retryPolicy.analysis.idleTimeoutMs,15_000)
    assert.equal(health.retryPolicy.analysis.timeoutMs,60_000)
    assert.equal(health.retryPolicy.image.retries, 1)
    assert.equal(health.retryPolicy.image.providerIdempotency, false)
  })
  for (const env of [{}, { MARKSET_MODEL_TIMEOUT_MS: 900000, MARKSET_MODEL_TOTAL_TIMEOUT_MS: 900000 }]) {
    assert.ok(MODEL_CLIENT_TIMEOUT_MS >= modelRequestPolicy(env).timeoutMs + 8000)
  }
})

test('client concurrent generation calls share work; later explicit calls get a new identity', async () => {
  const nativeFetch = globalThis.fetch
  let release, calls = 0
  const ids = []
  globalThis.fetch = async (_url, init) => {
    calls++
    ids.push(init.headers['Idempotency-Key'])
    return new Promise((resolve) => { release = () => resolve(Response.json({ imageUrl: 'data:image/png;base64,test' })) })
  }
  try {
    const first = generateImage({ prompt: 'mug' })
    const second = generateImage({ prompt: 'mug' })
    assert.equal(first, second)
    assert.equal(calls, 1)
    release()
    await first
    const fresh = generateImage({ prompt: 'mug' })
    assert.equal(calls, 2)
    assert.notEqual(ids[0], ids[1])
    release()
    await fresh
  } finally { globalThis.fetch = nativeFetch }
})

test('model status endpoint detects each configured service without generating an image', async () => {
  const calls = []
  await fixture({ MARKSET_MODEL_BASE_URL: 'https://model.test/v1', MARKSET_MODEL_API_KEY: 'fake-model-key',
    MARKSET_BRUSH_MODEL: 'analysis-model', MARKSET_IMAGE_BASE_URL: 'https://image.test/v1', MARKSET_IMAGE_API_KEY: 'fake-image-key', MARKSET_IMAGE_MODEL: 'image-model' },
  async (url) => {
    calls.push(url)
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'image-model' }] })
    return Response.json({ choices: [{ message: { content: 'OK' } }] })
  }, async ({ post }) => {
    const response = await post('/api/model-status', { target: 'all' })
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.deepEqual(data.results.map((item) => item.state), ['available', 'available'])
    assert.equal(data.results[1].generationVerified, false)
    assert.equal(calls.length, 2)
    assert.ok(calls.every((url) => !url.includes('/images/')))
    assert.doesNotMatch(JSON.stringify(data), /fake-model-key|fake-image-key/u)
    const invalid = await post('/api/model-status', { target: 'other' })
    assert.equal(invalid.status, 400)
  })
})

test('official legacy edit endpoint deduplicates and does not silently ignore hard masks',async()=>{
  let posts=0
  const env={MARKSET_PROVIDER:'bailian',MARKSET_BAILIAN_REGION:'cn-beijing',MARKSET_BAILIAN_API_KEY:'fake-key'}
  await fixture(env,async(_url,init)=>{
    if(init.method==='POST') {
      posts++
      assert.equal(JSON.parse(init.body).input.messages[0].content[0].image,`data:image/png;base64,${png}`)
      return Response.json({output:{task_id:'original-edit-job'}})
    }
    return Response.json({output:{task_status:'FAILED',code:'TestFailure'}})
  },async({post})=>{
    const body={prompt:'只改变颜色',imageDataUrl:`data:image/png;base64,${png}`}
    for(let i=0;i<2;i++) {
      const r=await post('/api/inpaint',body,'same-edit')
      assert.equal(r.status,502)
      assert.equal((await r.json()).taskId,'original-edit-job')
    }
    assert.equal(posts,1)
    const masked=await post('/api/inpaint',{...body,maskDataUrl:body.imageDataUrl},'masked-edit')
    assert.equal(masked.status,400)
    assert.equal((await masked.json()).code,'image_mask_unsupported')
    assert.equal(posts,1)
  })
})
