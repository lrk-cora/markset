import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { initDiagnosticsPanel } from '../src/diagnostics-panel.js'
import { createAgentJournal } from '../src/agent-journal.js'

async function fixture(task, provider = async (body) => ({ results: [{ kind: body.target, state: 'available', model: 'test-model',
  checkedAt: Date.now(), elapsedMs: 100, message: body.target === 'image' ? '模型已列出；未实际生图' : '模型已响应极短请求' }] }), imageProvider) {
  const dom = new JSDOM(readFileSync(new URL('../index.html', import.meta.url), 'utf8'))
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch, previousWindow = globalThis.window
  globalThis.document = dom.window.document
  globalThis.window = dom.window
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (url === '/api/health') return Response.json({ modelGateway: true, imageGateway: true, allowCalls: true, brushModel: 'analysis-test', imageModel: 'image-test' })
    if (url === '/api/generate-image' && imageProvider) return imageProvider(init)
    assert.equal(url, '/api/model-status')
    return Response.json(await provider(JSON.parse(init.body)))
  }
  const journal = createAgentJournal()
  try {
    initDiagnosticsPanel({ journal })
    await new Promise((resolve) => setImmediate(resolve))
    await task({ document: dom.window.document, journal, calls })
  } finally { globalThis.document = previousDocument; globalThis.fetch = previousFetch; globalThis.window = previousWindow; dom.window.close() }
}

test('configuration is not presented as a successful connection and initialization sends no probe', async () => {
  await fixture(({ document, calls }) => {
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/api/health')
    const card = document.getElementById('model-card-analysis')
    assert.equal(card.dataset.state, 'unchecked')
    assert.equal(card.querySelector('.model-name').textContent, 'analysis-test')
    assert.match(card.querySelector('.model-message').textContent, /需要检测/u)
  })
})

test('journal phase timing and cache diagnostics are visible only in details and never sent to an API', async () => {
  await fixture(({ document, journal, calls }) => {
    const id = journal.begin({ id: 'g', targets: [], strokes: [] })
    journal.finish(id, { intent: { goal: '新增配图' }, timings: { pauseMs: 1200, observationMs: 12, captureMs: 100, baseWaitMs: 0,
      baseCacheHit: true, planMs: 3000, verifyMs: 100, repairMs: 0, modelRequests: 1, readToolCalls: 0, totalMs: 4412, imageCount: 2 } })
    const details = document.querySelector('.agent-details')
    assert.equal(details.open, false)
    assert.match(details.textContent, /截图准备 0.1 秒/)
    assert.match(details.textContent, /缓存命中/)
    assert.match(details.textContent, /模型规划 1 次/)
    assert.match(details.textContent, /本地校验 0.1 秒/)
    assert.equal(calls.length, 1, 'only initial configuration, not a model request')
  })
})

test('local timeout source is visible in journal details without a new model probe',async()=>{
  await fixture(({document,journal,calls})=>{
    const id=journal.begin({id:'g',targets:[],strokes:[]})
    journal.finish(id,{issue:{code:'verification_timeout',message:'方案执行检查超时',timeoutPhase:'verify',timeoutMs:4000},source:'fallback'})
    assert.match(document.querySelector('.agent-details').textContent,/超时来源：本地执行检查 · 上限 4.0 秒/u)
    assert.equal(calls.length,1)
  })
})

test('details distinguish locally aborted HTTP 200 streams from provider 504 without paid probes',async()=>{
  await fixture(({document,journal,calls})=>{
    for (const [source,stage,status,message] of [['local','idle',200,'流式输出停滞'],['upstream','provider',504,'上游接口返回 504']]) {
      const id=journal.begin({id:source,targets:[],strokes:[]})
      journal.finish(id,{issue:{timeoutSource:source,timeoutStage:stage,timeoutMs:source==='local'?15_000:0,message:'超时'},source:'fallback',
        timings:{attempts:[{request:1,attempt:1,status,elapsedMs:35_000,headersMs:100,firstOutputMs:23_000,lastProgressMs:24_000,
          succeeded:false,aborted:source==='local',timeoutSource:source,timeoutStage:stage}]}})
    }
    const details=[...document.querySelectorAll('.agent-details')]
    assert.match(details[0].textContent,/流式输出停滞/);assert.match(details[0].textContent,/HTTP 200/)
    assert.match(details[0].textContent,/首次有效输出 23.0 秒/);assert.match(details[0].textContent,/末次有效输出 24.0 秒/)
    assert.match(details[1].textContent,/上游接口返回 504/);assert.match(details[1].textContent,/HTTP 504/)
    assert.equal(calls.length,1)
  })
})

test('detect all renders independent model results and never calls generation endpoints', async () => {
  await fixture(async ({ document, calls }) => {
    document.getElementById('btn-check-models').click()
    assert.equal(document.getElementById('btn-check-models').disabled, true)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.length, 3)
    for (const kind of ['analysis', 'image']) {
      const card = document.getElementById(`model-card-${kind}`)
      assert.equal(card.dataset.state, 'available')
      assert.equal(card.getAttribute('aria-busy'), 'false')
    }
    assert.match(document.getElementById('model-card-image').textContent, /未实际生图/u)
    assert.equal(document.getElementById('btn-check-models').disabled, false)
  })
})

test('quick timeout releases buttons and does not claim the model is unavailable', async () => {
  await fixture(async ({ document }) => {
    document.querySelector('[data-check-model="analysis"]').click()
    await new Promise((resolve) => setImmediate(resolve))
    const card = document.getElementById('model-card-analysis')
    assert.equal(card.dataset.state, 'timeout')
    assert.match(card.textContent, /不代表模型一定不可用/u)
    assert.equal(card.querySelector('button').disabled, false)
    assert.equal(document.getElementById('model-card-image').dataset.state, 'unchecked')
  }, async (body) => ({ results: [{ kind: body.target, state: 'timeout', message: '快速检测超时；不代表模型一定不可用', model: 'test' }] }))
})

test('dialogue updates, execution and clear remain local and treat all text as text', async () => {
  await fixture(({ document, journal, calls }) => {
    const id = journal.begin({ id: 'g1', targets: [{ kind: 'text', text: '<img src=x onerror=alert(1)>' }], strokes: [{ shape: 'circle' }] }, { instruction: '改成红色' })
    assert.match(document.getElementById('agent-record-list').textContent, /1 个圈/u)
    assert.match(document.getElementById('agent-record-list').textContent, /改成红色/u)
    journal.finish(id, { source: 'local', intent: { goal: '把标题改成红色' } })
    journal.execution('g1', '已执行：修改颜色')
    const log = document.getElementById('agent-record-list')
    assert.match(log.textContent, /本地判断/u)
    assert.match(log.textContent, /已执行/u)
    assert.equal(log.querySelector('img'), null)
    assert.equal(calls.length, 1)
    document.getElementById('btn-clear-agent-records').click()
    assert.equal(document.getElementById('agent-record-count').textContent, '0')
    assert.deepEqual(journal.getEntries(), [])
    assert.equal(calls.length, 1)
  })
})

test('explicit image verification requires consent and a timeout retry queries the same operation identity',async()=>{
  let calls=0
  const ids=[]
  await fixture(async({document})=>{
    const button=document.querySelector('#model-card-image .model-verify-button')
    window.confirm=()=>false
    button.click(); await new Promise(r=>setImmediate(r)); assert.equal(calls,0)
    const confirmations=[]
    window.confirm=(message)=>{confirmations.push(message);return true}
    button.click(); await new Promise(r=>setImmediate(r))
    assert.match(button.textContent,/查询原图片测试任务/)
    button.click(); await new Promise(r=>setImmediate(r))
    assert.equal(calls,2)
    assert.equal(ids[0],ids[1])
    assert.match(confirmations[1],/不重复生成/)
    assert.match(document.getElementById('model-card-image').textContent,/实际调用成功/)
  },undefined,async(init)=>{
    calls++;ids.push(init.headers['Idempotency-Key'])
    return calls===1 ? Response.json({error:'图片任务等待超时',code:'image_timeout',taskId:'known-test-job'},{status:504})
      : Response.json({model:'qwen-image-3.0',elapsedMs:100,retriesUsed:0})
  })
})
