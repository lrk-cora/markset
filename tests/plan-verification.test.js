import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { auditPlanResult } from '../src/plan-verification.js'

const rect = (x, y, w, h) => ({ x, y, w, h })
function fixture(imageRect, { solidLeaf = false } = {}) {
  const dom = new JSDOM('<main id="main"><h1 id="title">Keep title</h1></main><img id="new">')
  const doc = dom.window.document
  const node = (id, box, parentId, paintRects) => ({ webId: id, el: doc.getElementById(id), parentId, rect: box, paintRects,
    style: '', attrs: '', text: null, overflow: 0, clipped: { horizontal: 0, vertical: 0 } })
  const main = node('main', rect(0, 0, 1000, 600), '__body', [])
  const title = node('title', rect(0, 0, 1000, 100), 'main', [rect(0, 0, 600, 80)])
  const before = { nodes: new Map([['main',main],['title',title]]), overflow: 0 }
  if (solidLeaf) {
    const leaf = doc.createElement('div'); leaf.id = 'panel'; doc.querySelector('main').append(leaf)
    before.nodes.set('panel', node('panel', rect(700, 0, 250, 200), 'main', [rect(700, 0, 250, 200)]))
  }
  const image = node('new', imageRect, '__body', [imageRect])
  const after = { nodes: new Map([...before.nodes, ['new',image]]), overflow: 0 }
  return { dom, before, after }
}

test('an image in a module’s blank space does not overlap its full-width heading/main bounding boxes', () => {
  const { dom, before, after } = fixture(rect(700, 0, 250, 200))
  try { assert.equal(auditPlanResult({ type: 'insert', targets: [] }, before, after).ok, true) }
  finally { dom.window.close() }
})

test('position audit checks the requested slot even if the misplaced image does not overlap anything',()=>{
  const bounds=rect(700,0,250,200)
  const plan={type:'insert',targets:[],contentKind:'image',insertion:{placement:'position'},parameters:{bounds}}
  for(const [actual,code] of [[bounds,null],[rect(700,650,250,200),'insertion-position-mismatch'],[rect(700,0,250,320),'insertion-position-mismatch']]) {
    const {dom,before,after}=fixture(actual)
    try {
      const report=auditPlanResult(plan,before,after,{insertions:[{stepIndex:0,webId:'new'}]})
      assert.equal(report.ok,!code)
      if(code) {
        const issue=report.errors.find(issue=>issue.code===code)
        assert.deepEqual(issue.expected,bounds)
        assert.deepEqual(issue.actual,actual)
      }
    } finally {dom.window.close()}
  }
})

test('position audit uses document coordinates and fails closed if the executor cannot identify the inserted node',()=>{
  const {dom,before,after}=fixture(rect(700,-500,250,200))
  const plan={type:'insert',targets:[],contentKind:'image',parameters:{bounds:rect(700,0,250,200)}}
  try {
    after.scroll={x:0,y:500}
    assert.equal(auditPlanResult(plan,before,after,{insertions:[{stepIndex:0,webId:'new'}]}).ok,true)
    assert.ok(auditPlanResult(plan,before,after).errors.some(issue=>issue.code==='insertion-position-unverified'))
    assert.ok(auditPlanResult({...plan,type:'batch',steps:[{type:'color',targets:[]},plan]},before,after,{insertions:[{stepIndex:0,webId:'new'}]}).errors.some(issue=>issue.code==='insertion-position-unverified'))
    assert.equal(auditPlanResult({type:'batch',steps:[{type:'color',targets:[]},plan]},before,after,{insertions:[{stepIndex:1,webId:'new'}]}).ok,true)
  } finally {dom.window.close()}
})

test('actual glyph/image overlap is still rejected even when the image is a body sibling of the containing main', () => {
  const { dom, before, after } = fixture(rect(100, 0, 250, 200))
  try { assert.ok(auditPlanResult({ type: 'insert', targets: [] }, before, after).issues.some(issue => issue.code === 'new-content-overlap')) }
  finally { dom.window.close() }
})

test('blank colored leaves are painted objects, not available whitespace', () => {
  const { dom, before, after } = fixture(rect(700, 0, 250, 200), { solidLeaf: true })
  try { assert.ok(auditPlanResult({ type: 'insert', targets: [] }, before, after).issues.some(issue => issue.code === 'new-content-overlap')) }
  finally { dom.window.close() }
})

test('existing overlaps are not newly introduced by a color-only change', () => {
  const { dom, before, after } = fixture(rect(100, 0, 250, 200))
  try {
    before.nodes.set('new', { ...after.nodes.get('new') })
    assert.equal(auditPlanResult({ type: 'color', targets: [{ webId: 'title' }] }, before, after).ok, true)
  } finally { dom.window.close() }
})

test('real audit permits small new page overhang as a warning, but still blocks material overflow',()=>{
  const {dom,before,after}=fixture(rect(700,0,250,200))
  try {
    after.overflow=10
    let report=auditPlanResult({type:'insert',targets:[]},before,after)
    assert.equal(report.ok,true);assert.equal(report.warnings[0].increasePixels,10)
    after.overflow=120
    report=auditPlanResult({type:'insert',targets:[]},before,after)
    assert.equal(report.ok,false);assert.equal(report.errors[0].code,'page-horizontal-overflow')
  } finally {dom.window.close()}
})

test('minor overflow does not excuse a lost non-target node or clipped text',()=>{
  const {dom,before,after}=fixture(rect(700,0,250,200))
  try {
    after.overflow=8;after.nodes.delete('title')
    let report=auditPlanResult({type:'insert',targets:[]},before,after)
    assert.equal(report.ok,false);assert.ok(report.errors.some(issue=>issue.code==='non-target-removed'))
    after.nodes.set('title',{...before.nodes.get('title'),clipped:{horizontal:6,vertical:0}})
    report=auditPlanResult({type:'insert',targets:[]},before,after)
    assert.equal(report.ok,false);assert.ok(report.errors.some(issue=>issue.code==='new-content-clipped'))
  } finally {dom.window.close()}
})
