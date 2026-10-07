import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { inferCompleteActionPlan } from '../src/intent-plan.js'
import { measurePlanDocument,auditPlanResult } from '../src/plan-verification.js'

// Real document mutations, ranges and undo snapshots, without browser layout
// or network. This is DOM integration coverage, not a browser E2E claim.
const dom = new JSDOM('<main class="page"><div id="start-guide"></div><div id="editor"></div><div id="web-doc-host"><iframe id="web-doc-frame" sandbox="allow-same-origin"></iframe></div></main>', { url: 'https://markset.test/' })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, DOMParser: dom.window.DOMParser,
  NodeFilter: dom.window.NodeFilter, requestAnimationFrame: () => 0,
  CSS: { escape: (value) => { assert.match(String(value), /^[\w-]+$/u); return String(value) } },
})
const web = await import('../src/web-doc.js')
const fixture = '<!doctype html><html><head><style>main{display:grid;gap:20px}</style></head><body data-markset-id="root"><main data-markset-id="list"><section id="module" data-markset-id="module"><h1 id="heading" data-markset-id="heading">从一个<span data-markset-id="word">问题</span>到一篇可投稿论文</h1><p data-markset-id="description">模块内的说明</p><button data-markset-id="action">模块内的按钮</button></section><section id="other" data-markset-id="other"><p>不要改动相邻模块</p></section></main></body></html>'
const doc = () => document.getElementById('web-doc-frame').contentDocument
globalThis.getComputedStyle = (el) => el.ownerDocument.defaultView.getComputedStyle(el)
const target = (id, kind = 'text') => ({ webId: id, kind, text: doc().querySelector(`[data-markset-id="${id}"]`)?.textContent || '' })
beforeEach(() => { web.unmountWebDoc(); assert.equal(web.mountWebDoc(fixture), true) })
after(() => dom.window.close())

test('selected module permits adding an image internally, preserving original content; one undo restores the full DOM', () => {
  const original = doc().body.innerHTML
  const module = target('module','container')
  const result = web.applyBrushInsert([module], { contentKind:'image',replacementText:'data:image/png;base64,iVBORw0KGgo=',insertion:{anchorId:'module',placement:'inside-end'} })
  assert.equal(result.ok,true)
  assert.equal(doc().getElementById('module').querySelectorAll('img').length,1)
  assert.match(doc().getElementById('heading').textContent,/从一个/)
  const id=web.listWebEdits()[0].id
  web.undoWebEditsSince(); assert.equal(doc().body.innerHTML,original)
  web.redoWebEdit(id); assert.equal(doc().getElementById('module').querySelectorAll('img').length,1)
})

test('a selected heading does not override the image slot; the whole image fits and undo/redo retains its placement',()=>{
  const original=doc().body.innerHTML
  const result=web.applyBrushInsert([target('heading')],{contentKind:'image',replacementText:'data:image/png;base64,iVBORw0KGgo=',parameters:{bounds:{x:700,y:100,w:240,h:320},coordinateSpace:'web-document'}})
  assert.equal(result.ok,true)
  const image=doc().querySelector('[data-markset-insert="image"]')
  assert.equal(image.parentElement,doc().body)
  for(const [key,value] of Object.entries({position:'absolute',left:'700px',top:'100px',width:'240px',height:'320px',margin:'0px',objectFit:'contain',boxSizing:'border-box'})) assert.equal(image.style[key],value,key)
  assert.deepEqual(result.insertions,[{stepIndex:0,webId:image.getAttribute('data-markset-id')}])
  const id=web.listWebEdits()[0].id
  web.undoWebEditsSince();assert.equal(doc().body.innerHTML,original)
  web.redoWebEdit(id);assert.equal(doc().querySelector('[data-markset-insert="image"]').style.height,'320px')
})

test('positioned or scaled document origins compensate the image node without modifying the page',()=>{
  const prototype=doc().defaultView.Element.prototype,measure=prototype.getBoundingClientRect
  const scale=.8,offset={x:22,y:36}
  prototype.getBoundingClientRect=function(){
    if(this.hasAttribute('data-markset-insert')) {
      const left=Number.parseFloat(this.style.left)*scale+offset.x,top=Number.parseFloat(this.style.top)*scale+offset.y
      const width=Number.parseFloat(this.style.width)*scale,height=Number.parseFloat(this.style.height)*scale
      return {left,top,x:left,y:top,width,height,right:left+width,bottom:top+height}
    }
    return measure.call(this)
  }
  try {
    const original=doc().body.innerHTML,bounds={x:700,y:100,w:240,h:320}
    const result=web.applyBrushInsert([target('heading')],{contentKind:'image',replacementText:'data:image/png;base64,iVBORw0KGgo=',insertion:{anchorId:'heading',placement:'position'},parameters:{bounds}})
    assert.equal(result.ok,true)
    const actual=doc().querySelector('[data-markset-insert]').getBoundingClientRect()
    for(const [key,value] of Object.entries({x:700,y:100,width:240,height:320})) assert.ok(Math.abs(actual[key]-value)<.01,key)
    assert.equal(doc().body.hasAttribute('style'),false,'never fix image placement by moving the whole page')
    web.undoWebEditsSince();assert.equal(doc().body.innerHTML,original)
  } finally {prototype.getBoundingClientRect=measure}
})

test('invalid positional bounds and missing flow anchors reject without changing the document or history',()=>{
  for(const insertion of [{anchorId:'heading',placement:'position'},{anchorId:'heading',placement:'invalid'},{placement:'inside-end'}]) {
    const original=doc().body.innerHTML
    const result=web.applyBrushInsert([target('heading')],{replacementText:'不要放错地方',insertion})
    assert.equal(result.ok,false)
    assert.equal(doc().body.innerHTML,original)
    assert.equal(web.listWebEdits().length,0)
  }
})

test('compound insertions report their executor step IDs, not their final DOM reading order',()=>{
  const result=web.applyBrushPlan({type:'batch',steps:[
    {type:'color',targets:[target('heading')],parameters:{color:'#ff0000'}},
    {type:'insert',targets:[target('module','container')],replacementText:'下方',insertion:{anchorId:'module',placement:'inside-end'}},
    {type:'insert',targets:[target('module','container')],replacementText:'上方',insertion:{anchorId:'module',placement:'inside-start'}},
  ]})
  assert.equal(result.ok,true)
  assert.deepEqual(result.insertions.map(item=>item.stepIndex),[1,2])
  assert.deepEqual(result.insertions.map(item=>doc().querySelector(`[data-markset-id="${item.webId}"]`).textContent),['下方','上方'])
  assert.equal(web.listWebEdits().length,1)
})

test('a missing image rejects all replacements rather than silently changing a partial selection',()=>{
  const image=doc().createElement('img');image.setAttribute('data-markset-id','picture');image.src='https://example.com/original.png';doc().getElementById('module').append(image)
  const original=doc().body.innerHTML
  const result=web.applyBrushImageReplacement([target('picture','image'),{webId:'missing',kind:'image'}],'https://example.com/new.png')
  assert.equal(result.ok,false)
  assert.equal(doc().body.innerHTML,original)
  assert.equal(web.listWebEdits().length,0)
})
test('marking a heading can anchor an insertion in its enclosing local module, but cannot insert outside selection', () => {
  assert.equal(web.applyBrushInsert([target('heading')],{replacementText:'新的说明',insertion:{anchorId:'heading',placement:'inside-end'}}).ok,true)
  assert.match(doc().getElementById('module').textContent,/新的说明/)
  const result=web.applyBrushInsert([target('heading')],{replacementText:'越界',insertion:{anchorId:'other',placement:'inside-end'}})
  assert.equal(result.ok,false)
  assert.doesNotMatch(doc().getElementById('other').textContent,/越界/)
})
test('multi-operation plan is one history item; all DOM/CSS edits undo and redo together', () => {
  const original=doc().body.innerHTML
  const result=web.applyBrushPlan({type:'batch',goal:'着色并添加内容',steps:[{type:'color',targets:[target('heading')],parameters:{color:'#ff0000'}},{type:'insert',targets:[target('module','container')],replacementText:'补充内容',insertion:{anchorId:'module',placement:'inside-end'}}]})
  assert.equal(result.ok,true)
  assert.equal(web.listWebEdits().length,1)
  assert.equal(doc().getElementById('heading').style.color,'rgb(255, 0, 0)')
  const id=web.listWebEdits()[0].id
  web.undoWebEditsSince(); assert.equal(doc().body.innerHTML,original)
  web.redoWebEdit(id); assert.match(doc().getElementById('module').textContent,/补充内容/)
})
test('failed second step restores first-step CSS and leaves no partial history', () => {
  const original=doc().body.innerHTML
  const result=web.applyBrushPlan({type:'batch',steps:[{type:'color',targets:[target('heading')],parameters:{color:'#ff0000'}},{type:'insert',targets:[target('module','container')],replacementText:'越界',insertion:{anchorId:'other',placement:'inside-end'}}]})
  assert.equal(result.ok,false)
  assert.equal(doc().body.innerHTML,original)
  assert.equal(web.listWebEdits().length,0)
})
test('reordering has exact DOM undo, including absence of the original style attributes', () => {
  const original=doc().body.innerHTML
  const result=web.applyBrushLayoutReorder([target('module','container'),target('other','container')],[],'vertical','reverse',['other','module'])
  assert.equal(result.ok,true)
  assert.equal(doc().getElementById('other').style.order,'1')
  web.undoWebEditsSince()
  assert.equal(doc().body.innerHTML,original)
})

test('legacy cached HTML is cleaned at both mount and restore without granting script permission', () => {
  const legacy = '<html><head><style>h1{color:red}</style><script src="/legacy.js"></script></head><body onload="test()"><h1 id="title" onclick="test()">旧缓存网页</h1><a id="unsafe" href="java&#x73;cript:test()">链接</a><img id="image" src="data:image/png;base64,AAAA" onerror="test()"></body></html>'
  for (const install of [web.mountWebDoc, web.restoreWebHtml]) {
    assert.equal(install(legacy), true)
    assert.equal(doc().querySelector('script'), null)
    assert.equal(doc().body.hasAttribute('onload'), false)
    assert.equal(doc().getElementById('title').hasAttribute('onclick'), false)
    assert.equal(doc().getElementById('unsafe').hasAttribute('href'), false)
    assert.equal(doc().getElementById('image').hasAttribute('onerror'), false)
    assert.equal(doc().getElementById('title').textContent, '旧缓存网页')
    assert.equal(doc().getElementById('image').getAttribute('src'), 'data:image/png;base64,AAAA')
    assert.equal(document.getElementById('web-doc-frame').getAttribute('sandbox'), 'allow-same-origin')
    const original = doc().body.innerHTML
    const title = doc().getElementById('title')
    assert.equal(web.applyBrushDelete([{ webId: title.getAttribute('data-markset-id'), kind: 'text' }]).ok, true)
    web.undoWebEditsSince()
    assert.equal(doc().body.innerHTML, original)
  }
})

test('whole module request deletes its actual DOM content, preserves neighbors, and undoes/redoes as one edit', () => {
  const original = doc().body.innerHTML
  const module = target('module', 'container')
  const plan = inferCompleteActionPlan('去掉这块内容', [module], { type: 'delete', targetRanges: [{ targetId: 'heading', start: 3, end: 5 }] })
  assert.deepEqual(plan.targetRanges, [])
  const result = web.applyBrushDelete(plan.targets)
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.equal(doc().getElementById('module'), null)
  assert.equal(doc().getElementById('heading'), null)
  assert.match(doc().getElementById('other').textContent, /不要改动/)
  const placeholder = doc().querySelector('[data-markset-tombstone]')
  assert.equal(placeholder.hidden, true)
  assert.equal(placeholder.style.display, 'none')
  assert.equal(placeholder.style.getPropertyPriority('display'), 'important')
  assert.equal(web.listWebEdits().length, 1)
  const edit = web.listWebEdits()[0]
  web.undoWebEditsSince()
  assert.equal(doc().body.innerHTML, original)
  assert.equal(web.redoWebEdit(edit.id), true)
  assert.equal(doc().getElementById('module'), null)
  assert.equal(doc().querySelector('[data-markset-tombstone]').style.display, 'none')
  web.undoWebEditsSince()
  assert.equal(doc().body.innerHTML, original)
})

test('selecting just the heading removes it, not the unselected enclosing module', () => {
  const plan = inferCompleteActionPlan('去掉这块内容', [target('heading')])
  assert.equal(web.applyBrushDelete(plan.targets).ok, true)
  assert.equal(doc().getElementById('heading'), null)
  assert.ok(doc().getElementById('module'))
  assert.match(doc().getElementById('module').textContent, /模块内的说明/)
})

test('parent/child/duplicate selections yield one root snapshot and no duplicate or missing nodes after undo', () => {
  for (const ids of [['module', 'heading', 'word', 'module'], ['word', 'heading', 'module']]) {
    const original = doc().body.innerHTML
    const result = web.applyBrushDelete(ids.map((id) => target(id)))
    assert.equal(result.count, 1)
    assert.equal(doc().querySelectorAll('[data-markset-tombstone]').length, 1)
    web.undoWebEditsSince()
    assert.equal(doc().body.innerHTML, original)
    assert.equal(doc().querySelectorAll('#heading').length, 1)
  }
})

test('invalid or root targets reject the whole group without deleting any valid sibling', () => {
  for (const id of ['missing', 'root']) {
    const original = doc().body.innerHTML
    const result = web.applyBrushDelete([target('module'), { webId: id }])
    assert.equal(result.ok, false)
    assert.equal(doc().body.innerHTML, original)
    assert.deepEqual(web.listWebEdits(), [])
  }
})

test('a failure in the second deletion rolls back the first and records no partial history', () => {
  const original = doc().body.innerHTML
  const other = doc().getElementById('other')
  const replace = other.replaceWith.bind(other)
  let fail = true
  other.replaceWith = (...args) => {
    if (fail) { fail = false; throw new Error('simulated DOM failure') }
    return replace(...args)
  }
  assert.equal(web.applyBrushDelete([target('module'), target('other')]).ok, false)
  assert.equal(doc().body.innerHTML, original)
  assert.deepEqual(web.listWebEdits(), [])
})

test('quoted word deletion edits only a text range and can restore the original nested inline structure', () => {
  const original = doc().body.innerHTML
  const heading = target('heading')
  const plan = inferCompleteActionPlan('删除“问题”', [heading])
  assert.equal(plan.parameters.deletionScope, 'text-range')
  assert.equal(web.applyBrushTextDeletion(plan.targets, plan.targetRanges).ok, true)
  assert.equal(doc().getElementById('heading').textContent, '从一个到一篇可投稿论文')
  assert.ok(doc().getElementById('module'))
  web.undoWebEditsSince()
  assert.equal(doc().body.innerHTML, original)
})

test('design primitives compose real style, node insertion and movement as one reversible transaction',()=>{
  const original=doc().body.innerHTML
  const result=web.applyBrushPlan({type:'batch',goal:'简洁模块设计',steps:[
    {type:'style',targets:[target('heading')],styles:{'font-size':'36px','line-height':'1.2'}},
    {type:'move',targets:[target('action')],insertion:{anchorId:'description',placement:'before'}},
    {type:'insert',targets:[target('heading')],allowedAnchorIds:['description'],insertion:{anchorId:'description',placement:'after'},nodes:[{tag:'figure',styles:{'border-radius':'12px'},children:[{tag:'figcaption',text:'新设计的模块内容'}]}]},
  ]})
  assert.equal(result.ok,true)
  assert.equal(doc().getElementById('heading').style.fontSize,'36px')
  assert.equal(doc().querySelector('[data-markset-id="action"]').nextElementSibling.getAttribute('data-markset-id'),'description')
  assert.match(doc().getElementById('module').querySelector('figure').textContent,/新设计/)
  assert.equal(doc().getElementById('other').textContent,'不要改动相邻模块')
  assert.equal(web.listWebEdits().length,1)
  const id=web.listWebEdits()[0].id
  web.undoWebEditsSince();assert.equal(doc().body.innerHTML,original)
  web.redoWebEdit(id);assert.ok(doc().querySelector('figure'))
})

test('failed compound design rolls back all styles and created nodes when moving into a descendant',()=>{
  const original=doc().body.innerHTML
  const result=web.applyBrushPlan({type:'batch',steps:[
    {type:'style',targets:[target('heading')],styles:{color:'#ff0000'}},
    {type:'insert',targets:[target('module','container')],insertion:{anchorId:'module',placement:'inside-end'},nodes:[{tag:'p',text:'不要残留'}]},
    {type:'move',targets:[target('module','container')],insertion:{anchorId:'description',placement:'inside-end'}},
  ]})
  assert.equal(result.ok,false);assert.equal(doc().body.innerHTML,original);assert.equal(web.listWebEdits().length,0)
})

test('new structured nodes reject code attributes and unsupported style without partial mutations',()=>{
  for(const nodes of [[{tag:'button',attributes:{onclick:'alert(1)'}}],[{tag:'p',styles:{position:'fixed'}}]]) {
    const original=doc().body.innerHTML
    assert.equal(web.applyBrushPlan({type:'insert',targets:[target('module','container')],insertion:{anchorId:'module',placement:'inside-end'},nodes}).ok,false)
    assert.equal(doc().body.innerHTML,original);assert.equal(web.listWebEdits().length,0)
  }
})

test('valid CSS on the wrong kind of container is not accepted as a successful layout change',()=>{
  const plan={type:'style',targets:[target('module','container')],styles:{'flex-direction':'column'}}
  const before=measurePlanDocument(doc())
  assert.equal(web.applyBrushPlan(plan).ok,true)
  const report=auditPlanResult(plan,before,measurePlanDocument(doc()))
  assert.equal(report.ok,false)
  assert.ok(report.issues.some(issue=>issue.code==='inactive-layout-style'))
  web.undoWebEditsSince()
  const valid={...plan,styles:{display:'flex','flex-direction':'column'}}
  assert.equal(web.applyBrushPlan(valid).ok,true)
  assert.equal(auditPlanResult(valid,before,measurePlanDocument(doc())).ok,true)
})
