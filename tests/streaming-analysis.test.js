import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readEventStream } from '../src/event-stream.js'
import { requestModelChat } from '../server/model-chat.js'
import { partialPlanSuggestion } from '../server/model-stream.js'
import { compactPlanningContext } from '../src/planning-evidence.js'
import { marksetApi, brushIntent } from '../server/plugin.js'
import { planBrushIntent } from '../src/api.js'
import { analysisProgressView } from '../src/analysis-progress.js'

const options = { baseUrl:'https://stream.test/v1',apiKey:'private-key',model:'test',messages:[],stream:true,returnMessage:true,retries:0,timeoutMs:1000 }
const packet = (delta,extra={}) => `data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:null}],...extra})}\n\n`
const toolDelta = (arguments_,first=false) => ({tool_calls:[{index:0,...(first?{id:'p',type:'function'}:{}),function:{...(first?{name:'propose_edit'}:{}),arguments:arguments_}}]})
const ending = `${packet({},{choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})}${packet({},{choices:[],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}})}data: [DONE]\n\n`
const response = text => new Response(text,{headers:{'Content-Type':'text/event-stream'}})

test('SSE handles arbitrary UTF-8/CRLF chunk boundaries, heartbeat and multi-line data',async()=>{
  const bytes = new TextEncoder().encode(': alive\r\nevent: progress\r\ndata: 中文\r\ndata: 第二行\r\n\r\n')
  const body = new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));controller.close()}})
  const events=[];await readEventStream(body,event=>events.push(event))
  assert.deepEqual(events,[{event:'progress',data:'中文\n第二行'}])
})

test('SSE bounds oversized unfinished events and cancellation releases a hung body',async()=>{
  await assert.rejects(readEventStream(response('data: '+ 'x'.repeat(30)).body,()=>{}, {maxEventChars:20}),/too-large/)
  const controller=new AbortController();let cancelled=false
  const body=new ReadableStream({cancel(){cancelled=true}})
  const read=readEventStream(body,()=>{}, {signal:controller.signal});controller.abort()
  await assert.rejects(read,{name:'AbortError'});assert.equal(cancelled,true)
})

test('native streamed tool arguments assemble correctly; reasoning is never emitted',async()=>{
  const deltas=[],reports=[]
  const result=await requestModelChat({...options,onDelta:value=>deltas.push(structuredClone(value)),onResponse:value=>reports.push(value),fetchImpl:async(_url,init)=>{
    const request=JSON.parse(init.body);assert.equal(request.stream,true);assert.equal(request.stream_options.include_usage,true)
    return response(packet({...toolDelta('{"suggestion":"将标题',true),reasoning_content:'PRIVATE_REASONING'})+packet(toolDelta('改红","intentType":"color"}'))+ending)
  }})
  assert.equal(result.tool_calls[0].id,'p')
  assert.deepEqual(JSON.parse(result.tool_calls[0].function.arguments),{suggestion:'将标题改红',intentType:'color'})
  assert.equal(partialPlanSuggestion(deltas[0].toolCalls[0].function.arguments),'将标题')
  assert.doesNotMatch(JSON.stringify(deltas),/PRIVATE_REASONING/)
  assert.equal(reports[0].usage.total_tokens,30)
})

test('summary extraction only reads the top-level suggestion including escapes, not nested/rationale strings',()=>{
  assert.equal(partialPlanSuggestion('{"rationale":"SECRET","nodes":[{"suggestion":"wrong"}],"suggestion":"保留\\u6807题\\n改色'),'保留标题 改色')
  assert.equal(partialPlanSuggestion('{"nodes":[{"suggestion":"wrong"}]}'),'')
  assert.equal(partialPlanSuggestion('{"suggestion":"abc\\u4'),'abc')
  assert.equal(partialPlanSuggestion('{"suggestion":"引号\\\"测试\\'),'引号"测试')
})

test('truncated streams never return a plan; safe transport retry starts with a clean accumulator',async()=>{
  let attempts=0,starts=0
  const result=await requestModelChat({...options,retries:1,baseDelayMs:1,onStart:()=>starts++,fetchImpl:async()=>++attempts===1
    ?response(packet(toolDelta('{"suggestion":"旧草案',true)))
    :response(packet(toolDelta('{"suggestion":"新草案"}',true))+ending)})
  assert.equal(starts,2);assert.equal(attempts,2)
  assert.equal(JSON.parse(result.tool_calls[0].function.arguments).suggestion,'新草案')
  for (const text of [packet(toolDelta('{"suggestion":"断流',true)),packet({content:'partial'},{choices:[{index:0,delta:{},finish_reason:'length'}]})+'data: [DONE]\n\n']) {
    await assert.rejects(requestModelChat({...options,fetchImpl:async()=>response(text)}))
  }
})

test('streaming keeps the existing full body deadline and parent abort without later retries',async()=>{
  let cancelled=false
  await assert.rejects(requestModelChat({...options,timeoutMs:20,fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled=true}}),{headers:{'Content-Type':'text/event-stream'}})}),{code:'model_total_timeout'})
  assert.equal(cancelled,true)
  const controller=new AbortController();let calls=0
  await assert.rejects(requestModelChat({...options,signal:controller.signal,retries:2,fetchImpl:async()=>{
    calls++;controller.abort();return response('')
  }}),{name:'AbortError'})
  assert.equal(calls,1)
})

test('evidence compaction preserves precise character indices/relations, nondefault styles and all authorized read data',()=>{
  const original={coordinateSpace:'web-document',strokes:[{points:[{x:1.1234567,y:2.987654}],viewportPoints:[{x:900,y:1}]}],
    targets:[{webId:'h',text:'标题',rect:{x:1.1234567,y:2,w:40,h:30},documentRect:{x:1.1234567,y:2,w:40,h:30},viewportRect:{x:900,y:1},
      charRects:[{index:17,char:'题',rect:{x:10.987654,y:30.1234567,w:10.3333333,h:20.123456}}],markedRanges:[{start:17,end:18,text:'题'}],textFragments:[{start:17,end:18,text:'题'}]}],
    initialEvidence:{complete:true,nodes:[{webId:'h',text:'标题',styles:{color:'#123456',display:'block',padding:'0px',margin:'4px','background-color':'rgba(0, 0, 0, 0)'}}]},
    moduleCatalog:[{webId:'h',text:'标题'}],evidence:{type:'range'},localEvidence:{type:'range'}}
  const snapshot=JSON.stringify(original),result=compactPlanningContext(original)
  assert.equal(JSON.stringify(original),snapshot)
  assert.deepEqual(result.targets[0].charBoxes,[[17,'题',10.99,30.12,10.33,20.12]])
  assert.deepEqual(result.targets[0].markedRanges,original.targets[0].markedRanges)
  assert.equal(result.initialEvidence.nodes[0].textRef,'target:h')
  assert.equal(result.moduleCatalog[0].textRef,'node:h')
  assert.equal(result.initialEvidence.nodes[0].styles.margin,'4px')
  assert.equal(result.initialEvidence.nodes[0].styles.color,'#123456')
  assert.ok(JSON.stringify(result).length<snapshot.length*.8)
})

test('container text is omitted only when every child text is fully provided; mixed/omitted/truncated text is retained',()=>{
  for(const [nodeText,children,expected] of [['a b',['a','b'],true],['a EXTRA b',['a','b'],false],['a b',['a','missing'],false]]) {
    const context={initialEvidence:{nodes:[{webId:'parent',text:nodeText,children}, {webId:'a',text:'a'},{webId:'b',text:'b'}]}}
    const parent=compactPlanningContext(context).initialEvidence.nodes[0]
    assert.equal(Boolean(parent.textFromChildren),expected)
    if(!expected)assert.equal(parent.text,nodeText)
  }
})

test('progress uses measured elapsed time but never displays partial drafts or invented percent completion',()=>{
  const view=analysisProgressView({stage:'draft',startedAt:1000,draftSummary:'保留文字，添加配图'},4500)
  assert.equal(view.kind,'AI 设计方案 · 3 秒');assert.equal(view.headline,'正在生成完整修改建议…')
  assert.match(view.detail,/完整方案.*一次显示/u);assert.doesNotMatch(JSON.stringify(view),/%|保留文字，添加配图/)
  assert.equal(analysisProgressView(null,3000).stage,'preparing')
  assert.equal(analysisProgressView({startedAt:0},3000).kind,'准备证据 · 3 秒')
})

test('malformed streamed output stops after its first draft without a hidden repair or automatic application',async(t)=>{
  const nativeFetch=globalThis.fetch,events=[]
  let clock=0,calls=0
  t.mock.method(Date,'now',()=>clock)
  const plan={suggestion:'标题改蓝并保留原文',intentType:'color',color:'blue',targetIds:['h'],confidence:.9,goal:'标题改蓝',rationale:'明确要求',strategy:'仅改颜色',impact:{scope:'标题',riskLevel:'low'}}
  globalThis.fetch=async()=>{
    clock+=50
    return response(packet(toolDelta(++calls===1?'{"suggestion":"首次公开建议", invalid}':JSON.stringify(plan),true))+ending)
  }
  try {
    await assert.rejects(brushIntent({MARKSET_MODEL_BASE_URL:'https://stream.test/v1',MARKSET_MODEL_API_KEY:'private-key',MARKSET_BRUSH_MODEL:'test'},
      {targets:[{webId:'h',kind:'text',text:'标题'}],userInstruction:'颜色调整'}, {onProgress:value=>events.push(value)}),error=>{
      assert.equal(error.reason,'invalid-plan-json');assert.equal(error.repairsUsed,0)
      assert.equal(error.timings.firstSummaryMs,undefined);return true
    })
    assert.equal(calls,1)
    assert.ok(events.every(event=>event.stage!=='repair'))
    assert.ok(events.every(event=>event.stage!=='draft' && !event.draftSummary))
    assert.equal(events.filter(event=>event.stage==='planning').length,1)
  }finally{globalThis.fetch=nativeFetch}
})

test('browser API delivers safe progress before completion and retains error status/request id; incomplete streams fail',async()=>{
  const nativeFetch=globalThis.fetch
  let body='event: progress\ndata: {"stage":"draft","draftSummary":"建议","reasoning":"SECRET"}\n\nevent: result\ndata: {"intent":{"type":"color"}}\n\n'
  globalThis.fetch=async(_url,init)=>{assert.equal(init.headers.Accept,'text/event-stream');return response(body)}
  try {
    const events=[];const result=await planBrushIntent({}, {onProgress:value=>events.push(value)})
    assert.equal(result.intent.type,'color');assert.equal(events[0].draftSummary,'建议');assert.doesNotMatch(JSON.stringify(events),/SECRET/)
    body='event: error\ndata: {"error":"超时","code":"model_gateway_timeout","status":504,"requestId":"req-1","timings":{"serverMs":33}}\n\n'
    await assert.rejects(planBrushIntent({}, {onProgress:()=>{}}),error=>error.status===504 && error.requestId==='req-1' && error.timings.serverMs===33)
    body='event: error\ndata: {"error":"超时","code":"model_stream_idle_timeout","status":504,"timeoutSource":"local","timeoutStage":"idle","timeoutMs":15000,"timings":{"attempts":[{"status":200,"firstOutputMs":23000}]}}\n\n'
    await assert.rejects(planBrushIntent({}, {onProgress:()=>{}}),error=>error.timeoutSource==='local' && error.timeoutStage==='idle'
      && error.timeoutMs===15_000 && error.timings.attempts[0].status===200)
    body='event: progress\ndata: {"stage":"planning"}\n\n'
    await assert.rejects(planBrushIntent({}, {onProgress:()=>{}}),{code:'model_gateway_unreachable'})
  }finally{globalThis.fetch=nativeFetch}
})

test('actual backend returns one complete proposal without public drafts; JSON callers and disconnect cancellation still work',async()=>{
  const nativeFetch=globalThis.fetch,nativeWarn=console.warn
  const env={MARKSET_MODEL_BASE_URL:'https://stream.test/v1',MARKSET_MODEL_API_KEY:'private-key',MARKSET_BRUSH_MODEL:'test',MARKSET_ALLOW_MODEL_CALLS:'1'}
  let middleware,release,upstreamSignal,upstreamCalls=0
  marksetApi(env).configureServer({middlewares:{use(fn){middleware=fn}}})
  const server=createServer((req,res)=>middleware(req,res,()=>res.end()))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const url=`http://127.0.0.1:${server.address().port}/api/brush-intent`
  const plan={suggestion:'标题改为蓝色，保留文字',intentType:'color',color:'blue',targetIds:['h'],confidence:.9,goal:'标题改蓝',rationale:'用户要求',strategy:'只改颜色',impact:{scope:'标题',riskLevel:'low'}}
  globalThis.fetch=async(url,init)=>{
    if(!String(url).startsWith('https://stream.test/'))return nativeFetch(url,init)
    upstreamCalls++
    upstreamSignal=init.signal
    if(!JSON.parse(init.body).stream)return Response.json({choices:[{message:{content:JSON.stringify(plan)}}]})
    if(upstreamCalls===2)return response(packet(toolDelta(JSON.stringify(plan),true))+ending)
    let released=false
    return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode(packet(toolDelta('{"suggestion":"标题改为蓝色',true))))
      release=()=>{if(released)return;released=true;controller.enqueue(new TextEncoder().encode(packet(toolDelta(JSON.stringify(plan).slice('{"suggestion":"标题改为蓝色'.length)))+ending));controller.close()}
    }}),{headers:{'Content-Type':'text/event-stream'}})
  }
  console.warn=()=>{}
  try {
    const payload={targets:[{webId:'h',kind:'text',text:'标题'}],userInstruction:'蓝色'}
    const res=await nativeFetch(url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify(payload)})
    const events=[]
    const read=readEventStream(res.body,event=>events.push(event))
    for(let i=0;i<30 && !release;i++)await new Promise(resolve=>setTimeout(resolve,5))
    assert.equal(typeof release,'function')
    assert.ok(!events.some(event=>event.event==='result'))
    release()
    await read
    assert.ok(events.filter(event=>event.event==='progress').every(event=>!JSON.parse(event.data).draftSummary && JSON.parse(event.data).stage!=='draft'))
    const result=JSON.parse(events.find(event=>event.event==='result').data)
    assert.equal(result.intent.type,'color');assert.equal(result.timings.modelRequests,1)
    assert.equal(result.timings.firstSummaryMs,undefined)
    assert.equal(result.timings.completedPlanMs,result.timings.serverMs)
    assert.doesNotMatch(JSON.stringify(events),/private-key|tool_calls|function.arguments/)
    const json=await nativeFetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    assert.equal((await json.json()).intent.type,'color')
    const controller=new AbortController()
    upstreamSignal=null
    const pending=await nativeFetch(url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify(payload),signal:controller.signal})
    await pending.body.getReader().read()
    for(let i=0;i<30 && !upstreamSignal;i++)await new Promise(resolve=>setTimeout(resolve,5))
    assert.ok(upstreamSignal);controller.abort()
    for(let i=0;i<30 && !upstreamSignal.aborted;i++)await new Promise(resolve=>setTimeout(resolve,5))
    assert.equal(upstreamSignal.aborted,true)
  }finally{globalThis.fetch=nativeFetch;console.warn=nativeWarn;server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
