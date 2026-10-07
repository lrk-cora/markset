import test from 'node:test'
import assert from 'node:assert/strict'
import { requestModelChat } from '../server/model-chat.js'
import { modelRequestPolicy } from '../src/request-policy.js'
import { brushIntent } from '../server/plugin.js'

const packet = delta => `data: ${JSON.stringify({choices:[{index:0,delta}]})}\n\n`
const tool = (args, first = false) => packet({tool_calls:[{index:0,...(first ? {id:'plan'} : {}),
  function:{...(first ? {name:'propose_edit'} : {}),arguments:args}}]})
const ending = `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`
const flush = () => new Promise(resolve => setImmediate(resolve))
const options = {baseUrl:'https://offline.test/v1',apiKey:'PRIVATE_KEY',model:'test',messages:[],
  stream:true,returnMessage:true,...modelRequestPolicy(),retries:0}

function streamFixture(t, overrides = {}) {
  t.mock.timers.enable({apis:['setTimeout','Date']})
  let writer, signal, cancelled = false, calls = 0
  const attempts = [], retries = [], deltas = []
  const fetchImpl = async (_url, init) => {
    calls++; signal = init.signal
    return new Response(new ReadableStream({start(controller) { writer = controller },cancel() { cancelled = true }}),
      {headers:{'Content-Type':'text/event-stream'}})
  }
  const promise = requestModelChat({...options,onAttempt:attempt => attempts.push(attempt),
    onRetry:value => retries.push(value),onDelta:value => deltas.push(value),fetchImpl,...overrides})
  // Attach immediately, including in deliberately failing clock-driven cases.
  const outcome = promise.then(value => ({value}),error => ({error}))
  return {attempts,retries,deltas,outcome,send(text) {writer.enqueue(new TextEncoder().encode(text))},
    close() {writer.close()},get signal() {return signal},get cancelled() {return cancelled},get calls() {return calls}}
}

test('a 35-second healthy native-tool stream finishes once instead of aborting/restarting at 30 seconds',async t => {
  const fixture = streamFixture(t,{retries:2})
  await flush()
  t.mock.timers.tick(23_000); fixture.send(tool('{"suggestion":"保留文字',true)); await flush()
  for (const text of ['，添加','配图','"}']) {t.mock.timers.tick(4_000);fixture.send(tool(text));await flush()}
  fixture.send(ending);fixture.close()
  const {value,error} = await fixture.outcome
  assert.equal(error,undefined)
  assert.equal(JSON.parse(value.tool_calls[0].function.arguments).suggestion,'保留文字，添加配图')
  assert.equal(fixture.calls,1);assert.equal(fixture.retries.length,0)
  assert.equal(fixture.attempts.length,1)
  assert.deepEqual([fixture.attempts[0].firstOutputMs,fixture.attempts[0].lastProgressMs,fixture.attempts[0].elapsedMs],[23_000,35_000,35_000])
  assert.equal(fixture.attempts[0].succeeded,true)
  t.mock.timers.tick(120_000);assert.equal(fixture.signal.aborted,false,'all watchdogs cleaned up on success')
})

test('heartbeats, empty deltas, usage and reasoning-only chunks do not extend the first-output deadline',async t => {
  const fixture = streamFixture(t)
  await flush()
  for (let i=0;i<5;i++) {
    t.mock.timers.tick(5_000)
    fixture.send(': heartbeat\n\n'+packet({content:'',reasoning_content:'PRIVATE_REASONING'})+'data: {"choices":[],"usage":{"total_tokens":1}}\n\n')
    await flush()
  }
  t.mock.timers.tick(5_000);await flush()
  const {error} = await fixture.outcome
  assert.equal(error.code,'model_first_output_timeout');assert.equal(error.timeoutStage,'first-output')
  assert.equal(error.timeoutSource,'local');assert.equal(error.timeoutMs,30_000)
  assert.equal(fixture.cancelled,true);assert.equal(fixture.attempts[0].status,200)
  assert.equal(fixture.attempts[0].firstOutputMs,null)
  assert.doesNotMatch(JSON.stringify(fixture.attempts)+JSON.stringify(fixture.deltas),/PRIVATE_REASONING|PRIVATE_KEY/)
})

test('a real stalled stream cancels its reader and identifies inactivity rather than upstream 504',async t => {
  const fixture = streamFixture(t)
  await flush();t.mock.timers.tick(2_000);fixture.send(tool('{"suggestion":"草案',true));await flush()
  t.mock.timers.tick(14_000);fixture.send(': still alive\n\n');await flush()
  t.mock.timers.tick(1_000);await flush()
  const {error} = await fixture.outcome
  assert.equal(error.code,'model_stream_idle_timeout');assert.equal(error.timeoutStage,'idle')
  assert.equal(error.timeoutSource,'local');assert.equal(error.upstreamStatus,undefined)
  assert.equal(fixture.cancelled,true);assert.equal(fixture.attempts[0].elapsedMs,17_000)
  assert.equal(fixture.attempts[0].lastProgressMs,2_000)
})

test('continuous valid output cannot bypass the 60-second whole-request budget or start another attempt',async t => {
  const fixture = streamFixture(t,{retries:2})
  await flush();fixture.send(tool('{"suggestion":"',true));await flush()
  for (let i=0;i<11;i++) {t.mock.timers.tick(5_000);fixture.send(tool('继续'));await flush()}
  t.mock.timers.tick(5_000);await flush()
  const {error} = await fixture.outcome
  assert.equal(error.code,'model_total_timeout');assert.equal(error.timeoutStage,'total')
  assert.equal(fixture.calls,1);assert.equal(fixture.retries.length,0);assert.equal(fixture.cancelled,true)
  assert.equal(fixture.attempts[0].status,200);assert.equal(fixture.attempts[0].timeoutStage,'total')
})

test('connection and non-streaming hung JSON bodies remain bounded and have accurate timeout stages',async t => {
  t.mock.timers.enable({apis:['setTimeout','Date']})
  for (const stage of ['connect','first-output']) {
    let signal
    const promise = requestModelChat({...options,stream:false,fetchImpl:async(_url,init) => {
      signal=init.signal
      return stage==='connect' ? new Promise(()=>{}) : {ok:true,status:200,json:()=>new Promise(()=>{})}
    }}).then(value=>({value}),error=>({error}))
    await flush();t.mock.timers.tick(30_000);await flush()
    const {error}=await promise
    assert.equal(error.code,'model_first_output_timeout');assert.equal(error.timeoutStage,stage)
    assert.equal(signal.aborted,true)
  }
})

test('a safely retried idle timeout gets a fresh buffer, once, within the shared total deadline',async t => {
  let calls=0, firstWriter, cancelled=false
  const attempts=[]
  const fixture=streamFixture(t,{retries:1,baseDelayMs:1,onAttempt:value=>attempts.push(value),fetchImpl:async()=>{
    if(++calls===1) return new Response(new ReadableStream({start(writer){firstWriter=writer},cancel(){cancelled=true}}),{headers:{'Content-Type':'text/event-stream'}})
    return new Response(tool('{"suggestion":"新方案"}',true)+ending,{headers:{'Content-Type':'text/event-stream'}})
  }})
  await flush();firstWriter.enqueue(new TextEncoder().encode(tool('{"suggestion":"旧草案',true)));await flush()
  t.mock.timers.tick(15_000);await flush();t.mock.timers.tick(1);await flush()
  const {value,error}=await fixture.outcome
  assert.equal(error,undefined);assert.equal(calls,2);assert.equal(cancelled,true)
  assert.equal(value.tool_calls[0].function.arguments,'{"suggestion":"新方案"}')
  assert.equal(attempts[0].timeoutStage,'idle');assert.equal(attempts[1].succeeded,true)
})

test('upstream 504 is identified separately from local timers and bounded retries',async()=>{
  const attempts=[]
  await assert.rejects(requestModelChat({...options,onAttempt:value=>attempts.push(value),fetchImpl:async()=>new Response('PRIVATE_BODY',{status:504})}),
    {code:'model_gateway_timeout',upstreamStatus:504,timeoutSource:'upstream',timeoutStage:'provider'})
  assert.equal(attempts[0].timeoutSource,'upstream');assert.equal(attempts[0].status,504)
  assert.doesNotMatch(JSON.stringify(attempts),/PRIVATE_BODY|PRIVATE_KEY/)
})

test('parent cancellation is not reclassified as timeout and prevents stream retries',async t => {
  const controller=new AbortController(),reason=new DOMException('cancelled','AbortError')
  const fixture=streamFixture(t,{signal:controller.signal,retries:2})
  await flush();fixture.send(tool('{"suggestion":"',true));await flush();controller.abort(reason)
  const {error}=await fixture.outcome
  assert.equal(error,reason);assert.equal(fixture.calls,1);assert.equal(fixture.cancelled,true)
  assert.equal(fixture.attempts[0].timeoutSource,undefined)
})

test('the real Max planning path accepts a slow healthy plan with one call and safe attempt diagnostics',async t => {
  t.mock.timers.enable({apis:['setTimeout','Date']})
  const nativeFetch=globalThis.fetch,events=[]
  let writer,calls=0
  globalThis.fetch=async(_url,init)=>{
    calls++
    const request=JSON.parse(init.body)
    assert.equal(request.model,'qwen3.8-max');assert.equal(request.stream,true)
    return new Response(new ReadableStream({start(controller){writer=controller}}),{headers:{'Content-Type':'text/event-stream'}})
  }
  try {
    const plan={suggestion:'标题改为蓝色，保留原文',intentType:'color',color:'blue',targetIds:['h'],confidence:.9,
      goal:'标题改蓝',rationale:'用户要求',strategy:'仅修改颜色',impact:{scope:'标题',riskLevel:'low'}}
    const serialized=JSON.stringify(plan),parts=[serialized.slice(0,24),serialized.slice(24,80),serialized.slice(80,150),serialized.slice(150)]
    const outcome=brushIntent({MARKSET_PROVIDER:'bailian',MARKSET_BAILIAN_REGION:'cn-beijing',MARKSET_BAILIAN_API_KEY:'PRIVATE_KEY'},
      {targets:[{webId:'h',kind:'text',text:'标题'}],userInstruction:'颜色改蓝',imageDataUrls:['data:image/png;base64,offline']},
      {onProgress:value=>events.push(value)}).then(value=>({value}),error=>({error}))
    await flush()
    for(let i=0;i<parts.length;i++) {
      t.mock.timers.tick(i===0?23_000:4_000);writer.enqueue(new TextEncoder().encode(tool(parts[i],i===0)));await flush()
    }
    writer.enqueue(new TextEncoder().encode(ending));writer.close()
    const {value,error}=await outcome
    assert.equal(error,undefined);assert.equal(value.intent.type,'color');assert.equal(value.intent.requiresConfirmation,true)
    assert.equal(value.model,'qwen3.8-max');assert.equal(calls,1);assert.equal(value.retriesUsed,0)
    assert.equal(value.timings.attempts[0].request,1);assert.equal(value.timings.attempts[0].firstOutputMs,23_000)
    assert.equal(value.timings.attempts[0].elapsedMs,35_000)
    assert.doesNotMatch(JSON.stringify(value.timings),/PRIVATE_KEY|rationale|messages|tool_calls/)
    assert.ok(events.some(event=>event.stage==='draft'))
  }finally{globalThis.fetch=nativeFetch}
})

test('the outer planner hard deadline records its own source even with an actively streaming HTTP 200',async t => {
  t.mock.timers.enable({apis:['setTimeout','Date']})
  const nativeFetch=globalThis.fetch
  let writer,calls=0,cancelled=false
  globalThis.fetch=async()=>{
    calls++;return new Response(new ReadableStream({start(controller){writer=controller},cancel(){cancelled=true}}),{headers:{'Content-Type':'text/event-stream'}})
  }
  try {
    const outcome=brushIntent({MARKSET_MODEL_BASE_URL:'https://offline.test/v1',MARKSET_MODEL_API_KEY:'PRIVATE_KEY'},
      {targets:[],retryBudget:2},{onProgress:()=>{}}).then(value=>({value}),error=>({error}))
    await flush();writer.enqueue(new TextEncoder().encode(tool('{"suggestion":"',true)));await flush()
    for(let i=0;i<11;i++){t.mock.timers.tick(5_000);writer.enqueue(new TextEncoder().encode(tool('继续')));await flush()}
    t.mock.timers.tick(5_000);await flush()
    const {error}=await outcome
    assert.equal(error.code,'model_total_timeout');assert.equal(error.timeoutSource,'local');assert.equal(error.timeoutStage,'total')
    assert.equal(error.timings.attempts[0].status,200);assert.equal(error.timings.attempts[0].timeoutStage,'total')
    assert.equal(calls,1);assert.equal(error.retriesUsed,0);assert.equal(cancelled,true)
  }finally{globalThis.fetch=nativeFetch}
})

test('policy bounds inactivity/first-output waits independently and preserves the hard total maximum',()=>{
  for(const env of [{},{MARKSET_MODEL_TIMEOUT_MS:999_999,MARKSET_MODEL_IDLE_TIMEOUT_MS:999_999,MARKSET_MODEL_TOTAL_TIMEOUT_MS:999_999},
    {MARKSET_MODEL_TIMEOUT_MS:1,MARKSET_MODEL_IDLE_TIMEOUT_MS:1,MARKSET_MODEL_TOTAL_TIMEOUT_MS:1}]) {
    const policy=modelRequestPolicy(env)
    assert.equal(policy.retries,2);assert.equal(policy.firstOutputTimeoutMs,policy.attemptTimeoutMs)
    assert.ok(policy.idleTimeoutMs>=5_000 && policy.idleTimeoutMs<=30_000)
    assert.ok(policy.timeoutMs>=policy.firstOutputTimeoutMs && policy.timeoutMs<=60_000)
  }
})
