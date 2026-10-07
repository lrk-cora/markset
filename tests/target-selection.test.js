import test from 'node:test'
import assert from 'node:assert/strict'
import { deselectTargetPatch, filterExcludedTargets, retargetSelectionPlan, mergeHitTargets } from '../src/target-selection.js'
import { inferCompleteColorPlan } from '../src/intent-plan.js'

const a = { webId: 'a', kind: 'text', text: '标题' }
const b = { webId: 'b', kind: 'text', text: '说明' }

test('later strokes accumulate hit ranges on an existing object without mutating its earlier snapshot',()=>{
  const first={webId:'title',kind:'text',text:'从问题到证据',markedRanges:[{start:0,end:2,text:'从问'}]}
  const next=mergeHitTargets([first],[{...first,markedRanges:[{start:1,end:4,text:'问题到'},{start:4,end:6,text:'证据'}],screenRect:{x:10,y:20,w:300,h:40}}])
  assert.equal(next.length,1)
  assert.deepEqual(next[0].markedRanges,[{start:0,end:6,text:'从问题到证据'}])
  assert.deepEqual(first.markedRanges,[{start:0,end:2,text:'从问'}])
  assert.equal(next[0].screenRect.x,10)
  assert.equal(mergeHitTargets(next,[b]).length,2)
})

test('deselection increments scope revision without changing ink or document content', () => {
  const group = { id: 'g', revision: 4, targets: [a, b], strokes: [{ id: 'ink' }], feedbackDraft: '改成红色', preview: {} }
  const patch = deselectTargetPatch(group, 'b')
  const next = { ...group, ...patch }
  assert.deepEqual(next.targets, [a])
  assert.deepEqual(next.excludedTargetIds, ['b'])
  assert.equal(next.revision, 5)
  assert.equal(next.preview, null)
  assert.equal(next.strokes, group.strokes)
  assert.equal(next.feedbackDraft, group.feedbackDraft)
  assert.deepEqual(group.targets, [a, b])
  assert.equal(deselectTargetPatch(next, 'missing'), null)
  assert.deepEqual(filterExcludedTargets([a, b], next.excludedTargetIds), [a])
})

test('excluding a nested component also prevents editing it via selected parents or children', () => {
  const child = { webId: 'child', kind: 'text' }
  const elements = {
    a: { contains: (el) => [elements.a, elements.b, elements.child].includes(el) },
    b: { contains: (el) => [elements.b, elements.child].includes(el) },
    child: { contains: (el) => el === elements.child },
    unrelated: { contains: (el) => el === elements.unrelated },
  }
  const other = { webId: 'unrelated', kind: 'text' }
  assert.deepEqual(filterExcludedTargets([a, b, child, other], ['b'], (id) => elements[id]), [other])
})

test('an existing color plan can be narrowed, but an invalid single-item reorder cannot survive', () => {
  const group = { targets: [a], inferredIntent: inferCompleteColorPlan('改成红色', [a, b]) }
  assert.deepEqual(retargetSelectionPlan(group).targets, [a])
  assert.equal(retargetSelectionPlan({ ...group, inferredIntent: { ...group.inferredIntent, type: 'reorder', operation: 'reorder', parameters: { direction: 'horizontal' } } }), null)
  assert.equal(retargetSelectionPlan({ ...group, targets: [] }), null)
})
