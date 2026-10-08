import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { normalizeBindingCorrections,checkBindingConstraints } from '../src/binding-corrections.js'
import { validateIntentPlan } from '../src/intent-plan.js'

// Deterministic, injected-plan contract evaluation. No LLM, paid images,
// participants, measured model accuracy or claimed interaction-speed gain.
export async function evaluateCorrections() {
  const dom=new JSDOM('<main class="page"><div id="start-guide"></div><div id="editor"></div><div id="web-doc-host"><iframe id="web-doc-frame" sandbox="allow-same-origin"></iframe></div></main>',{url:'https://markset.test/'})
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,DOMParser:dom.window.DOMParser,NodeFilter:dom.window.NodeFilter,requestAnimationFrame:()=>0,CSS:{escape:value=>String(value)}})
  globalThis.getComputedStyle=el=>el.ownerDocument.defaultView.getComputedStyle(el)
  const web=await import('../src/web-doc.js')
  const html='<!doctype html><html><body data-markset-id="root"><main data-markset-id="list"><section id="module" data-markset-id="module"><h1 id="title" data-markset-id="title">保留标题</h1><p id="description" data-markset-id="description">模块说明文字</p><button id="action" data-markset-id="action">按钮</button></section><section id="other" data-markset-id="other">其他模块不可改动</section></main></body></html>'
  const doc=()=>document.getElementById('web-doc-frame').contentDocument
  const nodes=[{webId:'module',kind:'container',text:'保留标题模块说明文字按钮',context:{parentId:'list'}},{webId:'title',kind:'text',text:'保留标题',context:{parentId:'module'}},{webId:'description',kind:'text',text:'模块说明文字',context:{parentId:'module'}},{webId:'action',kind:'text',text:'按钮',context:{parentId:'module'}},{webId:'other',kind:'container',text:'其他模块不可改动',context:{parentId:'list'}}].map(node=>({...node,selected:true}))
  const target=webId=>nodes.find(node=>node.webId===webId)
  const regions=nodes.map((node,index)=>({id:`target:${node.webId}`,number:index+1,kind:'target',targetIds:[node.webId]}))
  const binding=(node,role,extra={})=>({regionId:`target:${node}`,role,targetIds:[node],...extra})
  const relation=(node,anchorId,placement)=>({regionId:`target:${node}`,anchorId,placement})
  const base=plan=>({...plan,allowedAnchorIds:nodes.map(node=>node.webId),goal:'故障注入测试目标',rationale:'预先固定的执行合约',strategy:'受控的局部步骤',impact:{scope:'当前模块',riskLevel:'low'},source:'model',requiresConfirmation:true})
  const insert=anchorId=>base({type:'insert',regionId:'target:module',targets:[target('module')],contentKind:'image',replacementText:'data:image/png;base64,iVBORw0KGgo=',insertion:{anchorId,placement:'after'}})
  const move=anchorId=>base({type:'move',regionId:'target:title',targets:[target('title')],insertion:{anchorId,placement:'before'}})
  const color=webId=>base({type:'color',targets:[target(webId)],parameters:{color:'#2266ff'}})
  const deletion=(webId,extra={})=>base({type:'delete',targets:[target(webId)],...extra})
  const range={targetId:'description',start:0,end:2,expectedText:'模块'}
  const make=(name,plan,bindings,relations=[],reason=null,oracle=()=>{})=>({name,plan,bindings,relations,reason,oracle})
  const cases=[
    make('module-image-correct',insert('description'),[binding('module','preserve')],[relation('module','description','after')],null,()=>{assert.equal(doc().querySelector('#description').nextElementSibling.tagName,'IMG');assert.equal(doc().querySelector('#title').textContent,'保留标题')}),
    make('module-image-wrong-anchor',insert('other'),[binding('module','preserve')],[relation('module','description','after')],'binding-placement-mismatch'),
    make('module-image-destructive-child',base({type:'batch',steps:[insert('description'),deletion('title')]}),[binding('module','preserve')],[relation('module','description','after')],'binding-preserved-content'),
    make('move-correct',move('action'),[binding('title','change')],[relation('title','action','before')],null,()=>assert.equal(doc().querySelector('#title').nextElementSibling.id,'action')),
    make('move-wrong-anchor',move('description'),[binding('title','change')],[relation('title','action','before')],'binding-placement-mismatch'),
    make('compound-correct',base({type:'batch',steps:[color('title'),insert('description')]}),[binding('module','preserve')],[relation('module','description','after')],null,()=>{assert.equal(doc().querySelector('#title').style.color,'rgb(34, 102, 255)');assert.equal(doc().querySelector('#description').nextElementSibling.tagName,'IMG')}),
    make('compound-destructive-parent',base({type:'batch',steps:[color('title'),deletion('module')]}),[binding('title','preserve')],[],'binding-preserved-content'),
    make('range-correct',deletion('description',{targetRanges:[range]}),[binding('description','change',{range})],[],null,()=>assert.equal(doc().querySelector('#description').textContent,'说明文字')),
    make('range-expanded',deletion('description'),[binding('description','change',{range})],[],'binding-range-expanded'),
    make('rebound-correct',color('description'),[binding('title','change',{targetIds:['description']})],[],null,()=>assert.equal(doc().querySelector('#description').style.color,'rgb(34, 102, 255)')),
    make('rebound-old-object',color('title'),[binding('title','change',{targetIds:['description']})],[],'binding-old-target'),
    make('context-write',color('title'),[binding('title','context')],[],'binding-context-write'),
    make('context-descendant-write',color('title'),[binding('module','context')],[],'binding-context-write'),
    make('destination-destructive',deletion('module'),[binding('module','destination')],[],'binding-preserved-content'),
  ]
  const rows=[]
  try {
    for(const item of cases) {
      web.unmountWebDoc();assert.equal(web.mountWebDoc(html),true)
      const before=doc().body.innerHTML
      const normalized=normalizeBindingCorrections({version:1,revision:1,bindings:item.bindings,relations:item.relations},nodes,regions)
      assert.equal(normalized.ok,true,item.name)
      const ordinary=validateIntentPlan(item.plan,nodes,'明确按实验目标修改')
      assert.equal(ordinary.ok,true,`${item.name}: ordinary schema checks`)
      const check=checkBindingConstraints(item.plan,normalized.value,nodes)
      assert.equal(check.reason||null,item.reason,item.name)
      let applied=false,undo=null
      if(check.ok) {
        const result=web.applyBrushPlan(item.plan)
        assert.equal(result.ok,true,`${item.name}: ${result.reason}`);applied=true
        item.oracle();web.undoWebEditsSince();assert.equal(doc().body.innerHTML,before,`${item.name}: complete undo`);undo=true
      } else assert.equal(doc().body.innerHTML,before,`${item.name}: no mutation on rejected plan`)
      rows.push({case:item.name,ordinarySchemaAccepted:ordinary.ok,correctionAccepted:check.ok,reason:check.reason||null,expectedReason:item.reason,applied,undo,pass:true})
    }
    return {evaluation:'deterministic-correction-contracts-v1',paidCalls:0,modelCalls:0,participantCount:0,cases:rows.length,passed:rows.filter(row=>row.pass).length,allowed:rows.filter(row=>row.applied).length,blocked:rows.filter(row=>!row.correctionAccepted).length,scope:'Injected plans, shared schema validation and real DOM executor/undo; NOT an HCI baseline comparison or model benchmark.',rows}
  } finally {web.unmountWebDoc();dom.window.close()}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) console.log(JSON.stringify(await evaluateCorrections(),null,2))
