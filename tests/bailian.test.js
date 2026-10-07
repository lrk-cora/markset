import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bailianConfig, publicBailianConfig } from '../server/bailian-config.js'
import { routeAnalysis, routeImage } from '../server/model-routing.js'
import { normalizeBrushPlan } from '../server/brush-plan.js'
import { requestBailianImage } from '../server/bailian-image.js'
import { createImageJobStore } from '../server/image-jobs.js'
import { validateIntentPlan } from '../src/intent-plan.js'
import { createModelStatusProbe } from '../server/model-status.js'
import { brushIntent } from '../server/plugin.js'

const config = bailianConfig({ MARKSET_PROVIDER:'bailian', MARKSET_BAILIAN_REGION:'cn-beijing', MARKSET_BAILIAN_API_KEY:'test-key' })
const target = {webId:'module',kind:'container'}
const raw = { intentType:'insert',confidence:.4,goal:'模块内新增配图',rationale:'补充图示帮助理解',strategy:'保留文字，在模块末尾插图',impact:{scope:'模块内',riskLevel:'low'},targetIds:['module'],contentKind:'image',imagePrompt:'科研示意图',insertion:{anchorId:'module',placement:'inside-end'} }

test('first request carries real layout/anchor evidence; preferences do not rewrite the stable system prefix', async () => {
  const oldFetch = globalThis.fetch, seen = []
  const observation = { selectedIds: ['module'], modules: [{ webId: 'module', children: ['caption'], nearbyBlank: [{ afterId: 'caption' }] }],
    nodes: [{ webId: 'module', kind: 'container', moduleId: 'module', styles: { display: 'grid' }, context: {} },
      { webId: 'caption', kind: 'text', moduleId: 'module', text: '保留说明', context: { parentId: 'module' }, styles: { color: '#123456' } }] }
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); seen.push(body)
    const context = JSON.parse(body.messages[1].content[0].text.replace('上下文 JSON：', ''))
    assert.equal(context.initialEvidence.nodes.find(node => node.webId === 'caption').styles.color, '#123456')
    return Response.json({ choices: [{ message: { content: JSON.stringify({ ...raw, insertion: { anchorId: 'caption', placement: 'after' } }) } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })
  }
  try {
    const env = { MARKSET_PROVIDER: 'bailian', MARKSET_BAILIAN_REGION: 'cn-beijing', MARKSET_BAILIAN_API_KEY: 'test-key' }
    for (const preferences of [['喜欢冷色'], ['喜欢暖色']]) {
      const result = await brushIntent(env, { targets: [target], observation, preferences, userInstruction: '模块内加图', imageDataUrls: ['screenshot'] })
      assert.equal(result.timings.modelRequests, 1); assert.equal(result.timings.modelAttempts, 1)
      assert.equal(result.timings.readToolCalls, 0); assert.equal(result.intent.insertion.anchorId, 'caption')
      assert.equal(result.model, 'qwen3.8-flash')
    }
    assert.equal(seen[0].messages[0].content, seen[1].messages[0].content)
  } finally { globalThis.fetch = oldFetch }
})

test('Agent metrics and usage sum all read/plan rounds, rather than just the last response', async () => {
  const oldFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => Response.json({ usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 }, choices: [{ message: ++calls === 1
    ? { content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'inspect_module', arguments: '{"moduleId":"module"}' } }] }
    : { content: JSON.stringify(raw) } }] })
  try {
    const result = await brushIntent({ MARKSET_PROVIDER: 'bailian', MARKSET_BAILIAN_REGION: 'cn-beijing', MARKSET_BAILIAN_API_KEY: 'test-key' },
      { targets: [target], observation: { modules: [{ webId: 'module' }], nodes: [{ webId: 'module', kind: 'container', moduleId: 'module' }] } })
    assert.equal(result.timings.modelRequests, 2); assert.equal(result.timings.modelAttempts, 2)
    assert.equal(result.timings.readToolCalls, 1)
    assert.deepEqual(result.usage, { prompt_tokens: 200, completion_tokens: 60, total_tokens: 260 })
  } finally { globalThis.fetch = oldFetch }
})
test('official region is explicit; public config cannot contain the key or key file', () => {
  assert.throws(()=>bailianConfig({MARKSET_PROVIDER:'bailian'}),/地域/)
  assert.equal(config.origin,'https://dashscope.aliyuncs.com')
  assert.doesNotMatch(JSON.stringify(publicBailianConfig(config)),/test-key|apiKey|KEY_FILE/)
})
test('user-selected Flash remains Flash for screenshots, image plans and complex marks without hidden Max escalation',()=>{
  for (const payload of [
    {userInstruction:'改成红色',targets:[target]},
    {imageDataUrls:['screenshot'],targets:[target]},
    {userInstruction:'先重排卡片，然后在每个模块内插图',targets:[target]},
    {strokes:[{shape:'circle'},{shape:'line'},{shape:'arrow'},{shape:'cross'}]},
    {userInstruction:'高质量复杂整体布局',targets:Array(8).fill(target)},
  ]) {
    const routing=routeAnalysis(payload,config)
    assert.equal(routing.tier,'flash');assert.equal(routing.model,'qwen3.8-flash')
    assert.match(routing.reason,/用户指定.*不自动升级/u)
  }
  assert.equal(routeImage({prompt:'普通配图'},config).tier,'standard')
  assert.equal(routeImage({prompt:'精确文字海报'},config).tier,'pro')
})
test('selected module permits inside insertion and image prompt without a replacement URL',()=>{
  const plan=normalizeBrushPlan(raw,[target])
  assert.equal(plan.type,'insert')
  assert.equal(validateIntentPlan(plan,[target],'在模块内添加配图').actionable,true)
  assert.equal(plan.needsInput,false)
})
test('illegal insertion anchor and invented target are rejected rather than rewritten to text replacement',()=>{
  const plan=normalizeBrushPlan({...raw,insertion:{anchorId:'outside',placement:'inside-end'}},[target])
  assert.equal(validateIntentPlan(plan,[target]).reason,'unknown-insertion-anchor')
  const invalid=normalizeBrushPlan({...raw,targetIds:['foreign']},[target])
  assert.equal(validateIntentPlan(invalid,[target]).reason,'unknown-target')
})
test('model action remains legal without a local arrow or explicit action keyword; negations still bind',()=>{
  const plan=normalizeBrushPlan({...raw,intentType:'color',color:'#123456',targetIds:['text']},[{webId:'text',kind:'text'}])
  assert.equal(validateIntentPlan(plan,plan.targets,'视觉更冷静些').actionable,true)
  const replace=normalizeBrushPlan({...raw,intentType:'replace',targetIds:['text'],targetText:'原标题',replacementText:'新标题'},[{webId:'text',kind:'text',text:'原标题'}])
  assert.equal(validateIntentPlan(replace,replace.targets,'不要修改文字').reason,'contradicts-user-instruction')
})
test('batch validates every step and refuses a step that uses a deleted anchor',()=>{
  const deletion=normalizeBrushPlan({...raw,intentType:'delete'},[target])
  const plan={...normalizeBrushPlan({...raw,intentType:'batch'},[target]),steps:[deletion,normalizeBrushPlan(raw,[target])]}
  assert.equal(validateIntentPlan(plan,[target]).reason,'batch-target-deleted')
})

test('official asynchronous editing contains original image; known task is polled, never submitted again',async()=>{
  const calls=[], original='data:image/png;base64,iVBORw0KGgo='
  const fetchImpl=async(url,init)=>{
    calls.push({url,init})
    if(init.method==='POST') return Response.json({output:{task_id:'task-1',task_status:'PENDING'}})
    return Response.json({output:{task_status:'FAILED',code:'TestFailure'}})
  }
  let meta
  await assert.rejects(requestBailianImage({config,payload:{prompt:'改变杯子颜色',mode:'edit',imageDataUrl:original},fetchImpl,onTask:(v)=>{meta=v}}),{code:'image_task_failed',taskId:'task-1'})
  const body=JSON.parse(calls[0].init.body)
  assert.equal(calls[0].url,config.origin+'/api/v1/services/aigc/image-generation/generation')
  assert.equal(calls[0].init.headers['X-DashScope-Async'],'enable')
  assert.equal(body.input.messages[0].content[0].image,original)
  assert.equal(body.parameters.size,'1024*1024')
  assert.equal(meta.taskId,'task-1')
  await assert.rejects(requestBailianImage({config,payload:{prompt:'改变杯子颜色',mode:'edit'},taskId:'task-1',fetchImpl}),{code:'image_task_failed'})
  assert.equal(calls.filter(c=>c.init.method==='POST').length,1)
})
test('editing without a source is refused before any paid request',async()=>{
  let calls=0
  await assert.rejects(requestBailianImage({config,payload:{prompt:'修改图片',mode:'edit'},fetchImpl:()=>{calls++}}),{code:'image_missing_original'})
  assert.equal(calls,0)
})
test('auth/parameter/image unknown-submission failures never retry POST',async()=>{
  for(const status of [400,401,403,502,504]) {
    let calls=0
    await assert.rejects(requestBailianImage({config,payload:{prompt:'配图'},fetchImpl:async()=>{calls++;return Response.json({code:'Error'}, {status})}}))
    assert.equal(calls,1)
  }
})
test('one safe pre-connect retry and a full deadline retain the provider task identity',async()=>{
  let posts=0
  await assert.rejects(requestBailianImage({config,payload:{prompt:'配图'},timeoutMs:600,fetchImpl:async(url,init)=>{
    if(init.method==='POST') {
      posts++
      if(posts===1) throw Object.assign(new TypeError('connect failed'),{cause:{code:'ECONNREFUSED'}})
      return Response.json({output:{task_id:'known-job',task_status:'PENDING'}})
    }
    return new Promise(()=>{})
  }}),{code:'image_timeout',taskId:'known-job'})
  assert.equal(posts,2)
})
test('task ledger recovers after restart without storing key, source or prompt',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'markset-'))
  try {
    const ledgerFile=join(dir,'tasks.json'), payload={prompt:'private-content'}
    const first=createImageJobStore({ledgerFile})
    await assert.rejects(first.run('r1',payload,async({onTask})=>{onTask({taskId:'task-1',model:'qwen-image-3.0',region:'cn-beijing'});throw Object.assign(new Error('timeout'),{code:'image_timeout',taskId:'task-1'})}))
    assert.doesNotMatch(readFileSync(ledgerFile,'utf8'),/private-content|test-key/)
    const restarted=createImageJobStore({ledgerFile})
    const result=await restarted.run('r1',payload,async({taskId,onTask})=>{assert.equal(taskId,'task-1');assert.equal(onTask,undefined);return{imageUrl:'existing-result'}})
    assert.equal(result.imageUrl,'existing-result')
  } finally {rmSync(dir,{recursive:true,force:true})}
})

test('expired durable task identities never turn into fresh paid submissions, including after restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'markset-expiry-'))
  try {
    let now=0,calls=0
    const options={ledgerFile:join(dir,'tasks.json'),ttlMs:10,now:()=>now,maxEntries:1}
    const store=createImageJobStore(options)
    await store.run('old',{},async({onTask})=>{calls++;onTask({taskId:'known-old'});return{imageUrl:'completed'}})
    now=11
    await assert.rejects(store.run('old',{},()=>{calls++;return{}}),{code:'image_operation_expired'})
    await store.run('new',{},async()=>({imageUrl:'new'}))
    const restarted=createImageJobStore(options)
    await assert.rejects(restarted.run('old',{},()=>{calls++;return{}}),{code:'image_operation_expired'})
    assert.equal(calls,1)
  } finally {rmSync(dir,{recursive:true,force:true})}
})
test('quick official status does not invoke either analysis or paid generation; tiers and last actual success are separate',async()=>{
  const probe=createModelStatusProbe({analysis:{...config,model:config.brushModel,highModel:config.maxModel},image:{...config,model:config.imageModel},listOnly:true,allowCalls:true,lastCalls:{analysis:{model:config.maxModel,succeededAt:1}},fetchImpl:async(url)=>{assert.ok(url.endsWith('/models'));return Response.json({data:[config.brushModel,config.maxModel,config.imageModel].map(id=>({id}))})}})
  const data=await probe()
  assert.equal(data.results[0].connectionVerified,true)
  assert.equal(data.results[0].invocationVerified,true)
  assert.equal(data.results[1].invocationVerified,false)
})

test('model geometry uses document coordinates after scrolling and labels resized images explicitly',async()=>{
  const oldFetch=globalThis.fetch
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(init.body)
    const ctx=JSON.parse(body.messages[1].content[0].text.replace('上下文 JSON：',''))
    assert.equal(ctx.coordinateSpace,'web-document')
    assert.deepEqual(ctx.strokes[0].points,[{x:50,y:900}])
    assert.equal(ctx.strokes[0].viewportPoints,undefined,'planner uses one consistent document space, not duplicate viewport coordinates')
    assert.equal(ctx.targets[0].rect.y,900)
    assert.match(ctx.imageNotes,/不是缩放后图片像素/)
    assert.equal(body.response_format,undefined,'native tool output must not also force assistant-content JSON mode')
    const submit=body.tools.find(tool=>tool.function.name==='propose_edit')
    assert.equal(submit.function.parameters.type,'object')
    assert.ok(submit.function.parameters.properties.styles)
    assert.equal(body.model,'qwen3.8-flash')
    assert.equal(body.max_tokens,2200)
    assert.equal(body.enable_thinking,false)
    return Response.json({choices:[{message:{content:JSON.stringify({...raw,intentType:'color',color:'red'})}}]})
  }
  try {
    const d=await brushIntent({MARKSET_PROVIDER:'bailian',MARKSET_BAILIAN_REGION:'cn-beijing',MARKSET_BAILIAN_API_KEY:'test-key'},
      {imageDataUrls:['data:image/png;base64,AA=='],strokes:[{points:[{x:60,y:100}],documentPoints:[{x:50,y:900}]}],targets:[{...target,screenRect:{x:60,y:100,w:100,h:50},documentRect:{x:50,y:900,w:100,h:50}}]})
    assert.equal(d.intent.parameters.color,'#ff0000')
  } finally {globalThis.fetch=oldFetch}
})

test('image provider diagnostic code never reflects raw secrets and invalid task IDs do not call network',async()=>{
  await assert.rejects(requestBailianImage({config,payload:{prompt:'配图'},fetchImpl:async()=>Response.json({code:'sk-private-key'}, {status:400})}),
    (e)=>e.providerCode==='' && e.code==='image_gateway_request')
  let calls=0
  await assert.rejects(requestBailianImage({config,taskId:'../../another-api',payload:{prompt:'配图'},fetchImpl:()=>{calls++}}),{code:'image_invalid_task_id'})
  assert.equal(calls,0)
})
