import test from 'node:test'
import assert from 'node:assert/strict'
import { runPlanningAgent,readPlanningTool } from '../server/planning-agent.js'
import { normalizeBrushPlan,brushResponseFormat } from '../server/brush-plan.js'
import { planningSystem } from '../server/planning-agent.js'
import { planningTargets,checkNodeSpecs,checkStyleDeclarations } from '../src/edit-capabilities.js'
import { validateIntentPlan } from '../src/intent-plan.js'
import { clarificationChoices } from '../src/proposal-choices.js'
import { requestModelChat } from '../server/model-chat.js'
import { sampleStrokePoints } from '../src/planning-evidence.js'

const selected=[{webId:'heading',kind:'text',text:'研究主题',selected:true}]
const observation={modules:[{webId:'module',text:'科研内容'}],nodes:[{webId:'module',kind:'container',moduleId:'module'},{webId:'description',kind:'text',moduleId:'module',text:'保留这段说明'}]}
const targets=planningTargets(selected,observation)
const raw={intentType:'insert',confidence:.8,goal:'在说明下方补图并保留原文',suggestion:'在说明下添加科研配图，保留原内容',rationale:'补充直观表达',strategy:'在说明后插入图片',impact:{scope:'当前模块',riskLevel:'low'},targetIds:['heading'],contentKind:'image',imagePrompt:'克制的科研插画',insertion:{anchorId:'description',placement:'after'}}

test('fast plan schema omits prebuilt candidate executions but keeps compound tools and safety fields',()=>{
  const schema=brushResponseFormat.json_schema.schema
  assert.equal(schema.properties.candidatePlans,undefined)
  assert.deepEqual(schema.required,['intentType','suggestion','rationale','strategy','targetIds'])
  for(const key of ['steps','nodes','styles','bounds','targetRanges','scopeExpansion','alternatives','imagePrompt','imageMode']) assert.ok(schema.properties[key])
  assert.match(planningSystem,/不提前生成每个选项的执行参数/u)
})

test('compact actionable plans and lightweight clarification labels each complete in one model call',async()=>{
  for(const proposal of [
    {intentType:'color',suggestion:'标题改红，保留原文',rationale:'明确要求',strategy:'仅改颜色',targetIds:['heading'],color:'red'},
    {intentType:'note',suggestion:'这段标题希望更精简还是更突出？',rationale:'仅圈选尚无具体要求',strategy:'由用户选择效果',targetIds:['heading'],needsClarification:true,clarifyingQuestion:'精简标题，还是强化层级？',alternatives:['精简为一句科研学习导语','保留原文并缩小字号突出重点']},
  ]) {
    let calls=0
    const result=await runPlanningAgent({targets,observation,messages:[],chat:async()=>{calls++;return{role:'assistant',content:JSON.stringify(proposal)}}})
    assert.equal(calls,1);assert.equal(result.repairsUsed,0);assert.equal(result.intent.candidatePlans,undefined)
    assert.equal(result.intent.type,proposal.intentType)
    if(proposal.intentType==='note')assert.equal(clarificationChoices(result.intent).length,2)
  }
})

test('explicit image bounds are not silently converted into insertion after the selected module',()=>{
  const bounds={x:900,y:200,w:280,h:400}
  const plan=normalizeBrushPlan({...raw,insertion:undefined,bounds},targets)
  assert.deepEqual(plan.insertion,{anchorId:'',placement:'position'})
  assert.deepEqual(plan.parameters.bounds,bounds)
  assert.equal(plan.targets[0].webId,'heading')
  assert.equal(validateIntentPlan(plan,targets,'加一张相关图片').ok,true)
  const flow=normalizeBrushPlan({...raw,bounds},targets)
  assert.deepEqual(flow.insertion,raw.insertion,'an explicit flow placement is still respected')
  const contextual=normalizeBrushPlan({...raw,insertion:undefined},targets,{parameters:{bounds}})
  assert.equal(contextual.insertion.placement,'after','context-only bounds are not a model-selected image slot')
  const invalid=normalizeBrushPlan({...raw,insertion:{anchorId:'heading',placement:'position'}},targets)
  assert.equal(validateIntentPlan(invalid,targets).reason,'invalid-insertion-bounds','a selected anchor must not bypass position validation')
})

test('Agent designs a module-internal insertion with a related anchor; selection is not replacement',async()=>{
  let calls=0
  const result=await runPlanningAgent({targets,observation,instruction:'加一张相关图片',chat:async()=>{calls++;return{role:'assistant',content:JSON.stringify(raw)}},messages:[]})
  assert.equal(calls,1); assert.equal(result.intent.type,'insert'); assert.equal(result.intent.insertion.anchorId,'description')
  assert.equal(result.intent.requiresConfirmation,true); assert.equal(result.toolCalls,0)
})

test('native read tool returns real module data, not arbitrary filesystem/network access',async()=>{
  const histories=[]
  const result=await runPlanningAgent({targets,observation,instruction:'加一张相关图片',messages:[],chat:async(history)=>{
    histories.push(structuredClone(history))
    return histories.length===1 ? {role:'assistant',content:null,tool_calls:[{id:'read-1',type:'function',function:{name:'inspect_module',arguments:'{"moduleId":"module"}'}}]} : {role:'assistant',content:JSON.stringify(raw)}
  }})
  assert.equal(result.toolCalls,1)
  assert.equal(histories[1][1].role,'tool')
  assert.match(histories[1][1].content,/保留这段说明/)
  assert.deepEqual(readPlanningTool('inspect_module',{moduleId:'elsewhere'},observation),{error:'unknown-or-out-of-scope-module'})
  assert.deepEqual(readPlanningTool('shell',{command:'rm'},observation),{error:'unsupported-read-tool'})
})

test('invalid anchor stops after the first proposal with its concrete error and original summary',async()=>{
  let calls=0;const progress=[]
  await assert.rejects(runPlanningAgent({targets,observation,instruction:'加配图',messages:[],onProgress:value=>progress.push(...value),chat:async()=>{
    calls++;return{role:'assistant',content:JSON.stringify({...raw,insertion:{anchorId:'unknown',placement:'after'}})}
  }}),error=>error.code==='agent_plan_invalid' && error.reason==='unknown-insertion-anchor' && error.repairsUsed===0 && error.proposalSummary===raw.suggestion)
  assert.equal(calls,1);assert.ok(progress.every(item=>item.stage!=='repair'))
})

test('malformed output is checked once, never corrected by another model call',async()=>{
  for(const output of ['invalid-private-output',JSON.stringify({...raw,intentType:'invented-tool'})]) {
    let calls=0
    await assert.rejects(runPlanningAgent({targets,observation,messages:[],chat:async()=>{calls++;return{role:'assistant',content:output}}}),{code:'agent_plan_invalid',reason:'invalid-plan-json',repairsUsed:0})
    assert.equal(calls,1)
  }
})

test('legacy repair feedback is rejected before any paid call regardless of its claimed budget',async()=>{
  for(const used of [0,1,2,999]) {
    let calls=0
    await assert.rejects(runPlanningAgent({targets,observation,messages:[],repairsUsed:used,repairFeedback:{issues:[{code:'overflow'}]},chat:async()=>{calls++;return{role:'assistant',content:JSON.stringify(raw)}}}),{code:'agent_plan_invalid',reason:'automatic-repair-disabled',repairsUsed:0})
    assert.equal(calls,0)
  }
})

test('style and move can be composed; related writes must disclose expansion and insert nodes cannot run code',()=>{
  const base={...raw,intentType:'style',styles:[{property:'font-size',value:'36px'}]}
  assert.equal(validateIntentPlan(normalizeBrushPlan(base,targets),targets,'更简洁').ok,true)
  assert.equal(validateIntentPlan(normalizeBrushPlan({...base,targetIds:['description']},targets),targets).reason,'scope-expansion-not-disclosed')
  assert.equal(validateIntentPlan(normalizeBrushPlan({...base,targetIds:['description'],scopeExpansion:['description']},targets),targets).ok,true)
  assert.match(checkStyleDeclarations({'background':'url(https://outside.test)'}),/unsafe-style/)
  assert.equal(checkNodeSpecs([{tag:'script',text:'alert(1)'}]),'invalid-node-tag-or-size')
  assert.equal(checkNodeSpecs([{tag:'button',attributes:{onclick:'alert(1)'}}]),'unsafe-node-attribute')
  assert.equal(checkNodeSpecs([{tag:'figure',children:[{tag:'figcaption',text:'科研配图'}]}]),'')
})

test('a repeated clarification remains the first result without silently requesting a different answer',async()=>{
  let calls=0
  const answer=await runPlanningAgent({targets,messages:[],answered:['要加图还是改布局？'],chat:async()=>{
    calls++;return{role:'assistant',content:JSON.stringify({...raw,intentType:'note',needsClarification:true,clarifyingQuestion:'要加图，还是改布局？'})}
  }})
  assert.equal(calls,1);assert.equal(answer.intent.type,'note');assert.equal(answer.repairsUsed,0)
  assert.deepEqual(clarificationChoices({source:'model',type:'note',needsClarification:true,clarifyingQuestion:'你具体想怎么改？',targets:selected,suggestion:{alternatives:[]}}),[])
})

test('model protocol preserves native tool calls without sending internal reasoning',async()=>{
  const tool_calls=[{id:'call-1',type:'function',function:{name:'inspect_node',arguments:'{"webId":"heading"}'}}]
  const message=await requestModelChat({baseUrl:'https://model.test/v1',apiKey:'test-only',model:'test',messages:[],returnMessage:true,
    fetchImpl:async()=>Response.json({choices:[{message:{content:null,tool_calls,reasoning_content:'never expose'}}]})})
  assert.deepEqual(message,{role:'assistant',content:null,tool_calls})
  assert.doesNotMatch(JSON.stringify(message),/never expose/)
})

test('real candidate plans are concrete executable designs, not tool-category buttons',async()=>{
  const alternative={...raw,suggestion:'在说明下添加概念卡片',contentKind:'text',imagePrompt:'',nodes:[{tag:'p',text:'科研流程分为问题、验证与评审'}]}
  const result=await runPlanningAgent({targets,observation,messages:[],chat:async()=>({role:'assistant',content:JSON.stringify({...raw,intentType:'note',needsClarification:true,clarifyingQuestion:'更喜欢配图还是流程卡片？',candidatePlans:[raw,alternative]})})})
  assert.equal(result.intent.candidatePlans.length,2)
  assert.deepEqual(result.intent.suggestion.alternatives,result.intent.candidatePlans.map(candidate=>candidate.suggestion.text))
  assert.equal(result.intent.candidatePlans[1].nodes[0].tag,'p')
})

test('first-proposal unsafe code and undisclosed writes fail without replacement or repair',async()=>{
  for(const [proposal,reason] of [
    [{...raw,intentType:'style',targetIds:['description'],styles:[{property:'font-size',value:'48px'}]},'scope-expansion-not-disclosed'],
    [{...raw,contentKind:'text',nodes:[{tag:'script',text:'alert(1)'}]},'invalid-node-tag-or-size'],
    [{...raw,targetIds:['unseen']},'unknown-target'],
  ]) {
    let calls=0
    await assert.rejects(runPlanningAgent({targets,observation,messages:[],chat:async()=>{calls++;return{role:'assistant',content:JSON.stringify(proposal)}}}),error=>error.reason===reason && error.repairsUsed===0)
    assert.equal(calls,1)
  }
})

test('a model deletion on legal selected targets is only a proposal and always requires user confirmation',async()=>{
  let calls=0
  const result=await runPlanningAgent({targets,observation,messages:[],fallback:{parameters:{hasRegion:true,textStrike:false}},chat:async()=>{
    calls++;return{role:'assistant',content:JSON.stringify({...raw,intentType:'delete',targetIds:['heading'],suggestion:'移除这个标题，保留说明与按钮'})}
  }})
  assert.equal(calls,1);assert.equal(result.intent.type,'delete');assert.equal(result.intent.requiresConfirmation,true)
  assert.equal(result.repairsUsed,0)
})

test('a complete but neutral first result is not regenerated for lack of a preferred action',async()=>{
  let calls=0
  const result=await runPlanningAgent({targets,observation,instruction:'更简洁一点',messages:[],chat:async()=>{
    calls++;return{role:'assistant',content:JSON.stringify({...raw,intentType:'note',needsClarification:false,needsInput:false})}
  }})
  assert.equal(calls,1);assert.equal(result.intent.type,'note');assert.equal(result.repaired,false)
})

test('the native plan submission tool is a schema-bound plan, not an execution command',async()=>{
  let calls=0
  const result=await runPlanningAgent({targets,observation,messages:[],chat:async(_messages,{tools})=>{
    calls++;assert.ok(tools.some(tool=>tool.function.name==='propose_edit'))
    return {role:'assistant',content:null,tool_calls:[{id:'proposal',type:'function',function:{name:'propose_edit',arguments:JSON.stringify(raw)}}]}
  }})
  assert.equal(calls,1);assert.equal(result.intent.type,'insert');assert.equal(result.intent.requiresConfirmation,true)
})

test('invalid native submissions never open a follow-up repair turn',async()=>{
  for(const mixed of [false,true]) {
    let calls=0
    await assert.rejects(runPlanningAgent({targets,observation,messages:[],chat:async()=>{
      calls++;return{role:'assistant',content:null,tool_calls:[
        ...(mixed ? [{id:'read-with-submit',type:'function',function:{name:'inspect_module',arguments:'{"moduleId":"module"}'}}] : []),
        {id:'proposal',type:'function',function:{name:'propose_edit',arguments:JSON.stringify({...raw,insertion:{anchorId:'unknown',placement:'after'}})}},
      ]}
    }}),error=>error.reason===(mixed?'mixed-read-and-submit':'unknown-insertion-anchor') && error.repairsUsed===0)
    assert.equal(calls,1)
  }
})

test('long stroke payloads preserve both endpoints and all quadrants without mutating raw ink',()=>{
  const points=Array.from({length:2001},(_,i)=>({x:100*Math.cos(i*Math.PI/1000),y:100*Math.sin(i*Math.PI/1000)}))
  const sampled=sampleStrokePoints(points)
  assert.equal(sampled.length,180);assert.deepEqual(sampled[0],points[0]);assert.deepEqual(sampled.at(-1),points.at(-1))
  assert.ok(sampled.some(point=>point.x<-90));assert.ok(sampled.some(point=>point.y<-90));assert.equal(points.length,2001)
})

test('tool-stage transport failures retain the completed observations in the diagnostic summary',async()=>{
  let calls=0
  await assert.rejects(runPlanningAgent({targets,observation,messages:[],chat:async()=>{
    if(++calls===1)return {role:'assistant',content:null,tool_calls:[{id:'read',type:'function',function:{name:'inspect_module',arguments:'{"moduleId":"module"}'}}]}
    throw Object.assign(new Error('timeout'),{code:'model_gateway_timeout'})
  }}),error=>error.code==='model_gateway_timeout' && error.trace.some(stage=>stage.stage==='observe'))
})

test('a batch scope disclosure applies to its own child steps and never authorizes unseen targets',()=>{
  const style={...raw,intentType:'style',targetIds:['description'],styles:[{property:'font-size',value:'18px'}]}
  const color={...raw,intentType:'color',color:'#ff0000'}
  const batch=normalizeBrushPlan({...raw,intentType:'batch',scopeExpansion:['description'],steps:[style,color]},targets)
  assert.equal(validateIntentPlan(batch,targets).ok,true)
  batch.steps[0].targets=[{webId:'unseen',kind:'text'}]
  assert.equal(validateIntentPlan(batch,targets).reason,'batch:unknown-target')
})
