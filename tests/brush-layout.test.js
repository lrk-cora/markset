import test from 'node:test'
import assert from 'node:assert/strict'
import { anchorBrushStroke, reflowBrushGroup, verifyReflowedBrushPlan } from '../src/brush-layout.js'

const wide = { x: 100, y: 200, w: 800, h: 100 }
const narrow = { x: 40, y: 300, w: 500, h: 240 }
const stroke = () => anchorBrushStroke({ id: 'ink', revision: 3, closed: true, shape: 'circle', points: [{ x: 90, y: 190 }, { x: 910, y: 310 }] }, { kind: 'objects', objects: [{ webId: 'heading' }] }, wide)
const group = () => ({ id: 'group', revision: 3, coordinateSpace: 'web-document', strokes: [stroke()], targets: [{ webId: 'heading', markedRanges: [{ start: 3, end: 5 }] }], excludedTargetIds: ['other'], status: 'suggested', feedbackDraft: '保留这个输入', selectedAlternative: '调整颜色' })

test('ink follows both object movement and responsive width/height without changing stroke identity', () => {
  const original = group()
  const next = reflowBrushGroup(original, () => narrow)
  assert.deepEqual(next.strokes[0].points, [{ x: 33.75, y: 276 }, { x: 546.25, y: 564 }])
  assert.equal(next.strokes[0].id, 'ink')
  assert.equal(next.strokes[0].revision, 3)
  assert.equal(next.strokes[0].closed, true)
  assert.deepEqual(original.strokes[0].points, [{ x: 90, y: 190 }, { x: 910, y: 310 }])
})

test('100 sidebar round trips reproject immutable raw points and return exactly to the original ink', () => {
  const original = group()
  let next = original
  for (let i = 0; i < 100; i++) {
    next = reflowBrushGroup(next, () => narrow)
    next = reflowBrushGroup(next, () => wide)
  }
  assert.deepEqual(next.strokes[0].points, original.strokes[0].points)
  assert.deepEqual(next.strokes[0].layoutAnchor.originalPoints, original.strokes[0].points)
})

test('resize retains user input, selected alternative, exclusions, revision and exact character selection', () => {
  const original = group()
  const next = reflowBrushGroup(original, () => narrow, (target) => ({ ...target, documentRect: narrow }))
  for (const key of ['feedbackDraft', 'selectedAlternative', 'excludedTargetIds', 'revision', 'status']) assert.deepEqual(next[key], original[key])
  assert.deepEqual(next.targets[0].markedRanges, original.targets[0].markedRanges)
  assert.deepEqual(next.targets[0].documentRect, narrow)
})

test('missing, hidden or zero-size anchors never erase strokes or introduce NaN', () => {
  const original = group()
  for (const rect of [null, { x: 0, y: 0, w: 0, h: 0 }, { ...narrow, x: NaN }]) assert.equal(reflowBrushGroup(original, () => rect), original)
})

test('unchanged layout and legacy unanchored/viewport groups are no-ops', () => {
  const original = group()
  assert.equal(reflowBrushGroup(original, () => wide), original)
  const legacy = { ...original, strokes: [{ id: 'raw', points: [{ x: 1, y: 2 }] }] }
  assert.equal(reflowBrushGroup(legacy, () => narrow), legacy)
  const viewport = { ...original, coordinateSpace: 'viewport' }
  assert.equal(reflowBrushGroup(viewport, () => narrow), viewport)
})

test('multiple strokes keep their own object anchors, including a new stroke drawn after reflow', () => {
  let original = reflowBrushGroup(group(), () => narrow)
  const second = anchorBrushStroke({ id: 'second', points: [{ x: 10, y: 40 }, { x: 20, y: 50 }] }, { id: 'card' }, { x: 0, y: 0, w: 100, h: 100 })
  original = { ...original, strokes: [...original.strokes, second] }
  const next = reflowBrushGroup(original, (ref) => ref.id === 'card' ? { x: 30, y: 60, w: 200, h: 100 } : wide)
  assert.deepEqual(next.strokes[0].points, group().strokes[0].points)
  assert.deepEqual(next.strokes[1].points, [{ x: 50, y: 100 }, { x: 70, y: 110 }])
})

test('blank-area insertion bounds move with ink, also inside a batch, without changing the intended edit', () => {
  const original = group()
  const insertion = { type: 'insert', replacementText: '新增配图', insertion: { anchorId: 'heading', placement: 'inside-end' }, parameters: { coordinateSpace: 'web-document', bounds: { x: 100, y: 200, w: 800, h: 100 } } }
  original.inferredIntent = { type: 'batch', steps: [insertion, { type: 'color', color: '#f00', targets: original.targets }] }
  original.localIntent = insertion
  const next = reflowBrushGroup(original, () => narrow, (target) => ({ ...target, documentRect: narrow }))
  assert.deepEqual(next.inferredIntent.steps[0].parameters.bounds, narrow)
  assert.equal(next.inferredIntent.steps[0].insertion.anchorId, 'heading')
  assert.equal(next.inferredIntent.steps[0].replacementText, '新增配图')
  assert.deepEqual(next.inferredIntent.steps[1].targets[0].documentRect, narrow)
  assert.deepEqual(next.localIntent.parameters.bounds, narrow)
  const restored = reflowBrushGroup(next, () => wide)
  assert.deepEqual(restored.localIntent.parameters.bounds, wide)
})

test('temporary subpixel noise does not cause redundant group renders', () => {
  const original = group()
  assert.equal(reflowBrushGroup(original, () => ({ ...wide, w: wide.w + 0.02 })), original)
})

test('layout adapter failures preserve authoritative ink, targets and user input', () => {
  const original = group()
  assert.equal(reflowBrushGroup(original, () => { throw new Error('Unavailable DOM') }), original)
  const next = reflowBrushGroup(original, () => narrow, () => { throw new Error('Unavailable text range geometry') })
  assert.deepEqual(next.targets, original.targets)
  assert.equal(next.feedbackDraft, original.feedbackDraft)
  assert.equal(next.strokes.length, 1)
})

test('a late model batch and candidate plans are projected from their evidence snapshot exactly once',async()=>{
  const original=group(),plan={type:'batch',steps:[{type:'insert',imagePrompt:'主题图',parameters:{coordinateSpace:'web-document',bounds:wide}}],
    candidatePlans:[{type:'insert',parameters:{coordinateSpace:'web-document',bounds:wide}}]}
  const verified=await verifyReflowedBrushPlan(original,plan,{resolveRect:()=>narrow,verify:async(candidate,strokes)=>{
    assert.deepEqual(candidate.steps[0].parameters.bounds,narrow)
    assert.deepEqual(candidate.candidatePlans[0].parameters.bounds,narrow)
    assert.deepEqual(strokes[0].points,[{x:33.75,y:276},{x:546.25,y:564}])
    return{ok:true}
  }})
  assert.equal(verified.report.ok,true);assert.equal(verified.group.revision,original.revision)
  assert.deepEqual(plan.steps[0].parameters.bounds,wide,'the original model response is immutable')
})

test('layout changes during a trial rerun the local verifier once and retain the generated asset',async()=>{
  let rect=wide,checks=0
  const plan={type:'insert',replacementText:'data:image/png;base64,cached',parameters:{coordinateSpace:'web-document',bounds:wide}}
  const verified=await verifyReflowedBrushPlan(group(),plan,{resolveRect:()=>rect,verify:async(candidate)=>{
    checks++;assert.deepEqual(candidate.parameters.bounds,checks===1?wide:narrow)
    if(checks===1)rect=narrow
    return checks===1 ? {ok:false,issues:[{code:'insertion-position-mismatch'}]} : {ok:true}
  }})
  assert.equal(checks,2);assert.equal(verified.report.ok,true)
  assert.equal(verified.plan.replacementText,plan.replacementText)
})

test('repeated layout instability is bounded, never treated as a repairable model design error',async()=>{
  let rect=wide,checks=0
  const verified=await verifyReflowedBrushPlan(group(),{type:'color'},{resolveRect:()=>rect,verify:async()=>{
    checks++;rect=checks===1?narrow:wide;return{ok:true}
  }})
  assert.equal(checks,2);assert.equal(verified.report.ok,false)
  assert.equal(verified.report.issues[0].code,'layout-changing')
})

test('trial reprojection honors cancellation and cannot publish a late check after it was cancelled',async()=>{
  const controller=new AbortController()
  await assert.rejects(verifyReflowedBrushPlan(group(),{type:'color'},{resolveRect:()=>wide,signal:controller.signal,
    verify:async()=>{controller.abort();return{ok:true}}}),{name:'AbortError'})
})
