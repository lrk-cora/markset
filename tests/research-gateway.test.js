import test from 'node:test'
import assert from 'node:assert/strict'
import { brushIntent } from '../server/plugin.js'
const env={MARKSET_MODEL_BASE_URL:'https://fixture.test/v1',MARKSET_MODEL_API_KEY:'test-only',MARKSET_ALLOW_MODEL_CALLS:'1',MARKSET_BRUSH_MODEL:'fixture'}
const target={webId:'a',kind:'text',text:'目标',context:{tag:'h1',parentId:'m'},selected:true}
const observation={selectedIds:['a'],modules:[{webId:'m'}],nodes:[{...target,moduleId:'m',children:[]},{webId:'m',kind:'container',text:'模块',context:{tag:'section'}}],strokeEndpoints:[{id:'ink',start:{x:0,y:0}}]}
test('backend ablation really removes enriched relationships from initial evidence and read tools, preserving IDs and safety',async()=>{
  const previous=globalThis.fetch;let turn=0
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(init.body)
    if(turn++===0){
      const context=JSON.parse(body.messages[1].content[0].text.replace('上下文 JSON：',''))
      assert.deepEqual(context.moduleCatalog,[]);assert.deepEqual(context.strokeEndpoints,[]);assert.equal(context.targets[0].context.parentId,undefined)
      assert.deepEqual(context.preferences,[]);assert.equal(context.behaviorMemory,null)
      return Response.json({choices:[{message:{role:'assistant',tool_calls:[{id:'read',type:'function',function:{name:'inspect_node',arguments:JSON.stringify({webId:'a'})}}]}}]})
    }
    const result=JSON.parse(body.messages.at(-1).content)
    assert.equal(result.node.context.parentId,undefined);assert.equal(result.node.moduleId,undefined);assert.equal(result.parent,undefined)
    return Response.json({choices:[{message:{content:JSON.stringify({intentType:'color',targetIds:['a'],color:'#2266ff',suggestion:'将标题改为蓝色',rationale:'用户要求',strategy:'仅改前景色'})}}]})
  }
  try{const result=await brushIntent(env,{researchCondition:'ink-flat-evidence',targets:[target],observation,preferences:['private'],behaviorMemory:{profile:{}}});assert.equal(result.intent.type,'color');assert.equal(result.repairsUsed,0)}
  finally{globalThis.fetch=previous}
})
test('correction-disabled conditions reject injected corrections before any network call',async()=>{
  const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('network forbidden')}
  try{await assert.rejects(brushIntent(env,{researchCondition:'selection-text',bindingCorrections:{revision:1},targets:[target],observation}),e=>e.code==='study-correction-disabled');assert.equal(calls,0)}
  finally{globalThis.fetch=previous}
})
test('text-only backend ignores selected targets/ink even if a client sends them; frozen T1 gets explicit fixed resource',async()=>{
  const previous=globalThis.fetch;let calls=0
  globalThis.fetch=async(_url,init)=>{
    calls++;const body=JSON.parse(init.body),context=JSON.parse(body.messages[1].content[0].text.replace('上下文 JSON：',''))
    assert.equal(context.inputModality,'text');assert.deepEqual(context.targets,[]);assert.deepEqual(context.regions,[]);assert.deepEqual(context.strokes,[])
    assert.equal(context.fixedImageResource.url.startsWith('data:image/'),true)
    return Response.json({choices:[{message:{content:JSON.stringify({intentType:'color',targetIds:['a'],scopeExpansion:['a'],color:'#2266ff',suggestion:'改色',rationale:'文字目标',strategy:'仅修改颜色'})}}]})
  }
  try { await brushIntent(env,{researchCondition:'text-only',studyTaskId:'T1A',targets:[target],strokes:[{id:'ink'}],observation,userInstruction:'修改目标颜色'});assert.equal(calls,1) }
  finally{globalThis.fetch=previous}
})
test('conventional selection keeps validated target regions at the backend without fake ink',async()=>{
  const previous=globalThis.fetch
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(init.body),context=JSON.parse(body.messages[1].content[0].text.replace('上下文 JSON：',''))
    assert.equal(context.regions.length,1);assert.equal(context.regions[0].source,'selection');assert.deepEqual(context.strokes,[])
    return Response.json({choices:[{message:{content:JSON.stringify({intentType:'color',targetIds:['a'],color:'#2266ff',suggestion:'改色',rationale:'指定目标',strategy:'只改颜色'})}}]})
  }
  const selection={id:'s',targetIds:['a'],points:[{x:0,y:0},{x:100,y:0},{x:100,y:50},{x:0,y:50}]}
  try { await brushIntent(env,{researchCondition:'selection-text',targets:[target],observation,selections:[selection],regions:[{id:'selection:s',source:'selection',selectionId:'s',number:1,kind:'target',rect:{x:0,y:0,w:100,h:50},targetIds:['a']}]}) }
  finally{globalThis.fetch=previous}
})
