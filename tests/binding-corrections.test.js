import test from 'node:test'
import assert from 'node:assert/strict'
import { bindingTargetPool, normalizeBindingCorrections, checkBindingConstraints, rangeFromQuote, correctionPatch, stampBindingPlan, checkBindingStamp, checkBindingSnapshot, inspectBindings } from '../src/binding-corrections.js'

const targets = [
  { webId: 'module', kind: 'container' },
  { webId: 'title', kind: 'text', text: '标题应保留', context: { parentId: 'module' } },
  { webId: 'description', kind: 'text', text: '这段只改中间几个字', context: { parentId: 'module' } },
  { webId: 'other', kind: 'text', text: '其他区域' },
]
const regions = [{ id: 'target:title', number: 1, kind: 'target', targetIds: ['title'] }, { id: 'blank:ink', number: 2, kind: 'blank', targetIds: [] }]
const raw = (bindings = [], relations = []) => ({ version: 1, revision: 1, bindings, relations })
const binding = (role = 'preserve', targetIds = ['title']) => ({ regionId: regions[0].id, role, targetIds })
const corrected = (bindings, relations) => {
  const result = normalizeBindingCorrections(raw(bindings, relations), targets, regions)
  assert.equal(result.ok, true); return result.value
}
const write = (type, targetId = 'title', extra = {}) => ({ type, targets: [targets.find(target => target.webId === targetId)], ...extra })

test('correction schema derives original IDs and removes arbitrary extra data', () => {
  const value = corrected([{ ...binding(), originalTargetIds: ['other'], prompt: 'not sent' }])
  assert.deepEqual(value.bindings[0], { regionId: 'target:title', role: 'preserve', targetIds: ['title'], originalTargetIds: ['title'] })
})
test('unknown nodes, roles, region IDs, duplicate entries and invalid revisions fail closed', () => {
  for (const value of [raw([binding('unsafe')]), raw([binding('change', ['missing'])]), raw([{ ...binding(), regionId: 'fake' }]), raw([binding(), binding()]), { ...raw(), revision: 0 }, { ...raw(), bindings: null }]) {
    assert.equal(normalizeBindingCorrections(value, targets, regions).ok, false)
  }
})
test('absent corrections retain ordinary planning behavior', () => {
  assert.equal(normalizeBindingCorrections(null).ok, true)
  assert.equal(checkBindingConstraints(write('delete'), null, targets).ok, true)
})
test('preserved text cannot be replaced or deleted, including via ancestor deletion', () => {
  for (const type of ['replace', 'delete', 'replace-image']) for (const targetId of ['title', 'module']) {
    assert.equal(checkBindingConstraints(write(type, targetId), corrected([binding()]), targets).reason, 'binding-preserved-content')
  }
})
test('preservation allows styling and adding inside the module without replacing content', () => {
  const corrections = corrected([binding('preserve', ['module'])])
  for (const plan of [write('color'), write('style', 'module'), write('insert', 'module', { insertion: { anchorId: 'module', placement: 'inside-end' } })]) assert.equal(checkBindingConstraints(plan, corrections, targets).ok, true)
})
test('context blocks writes but permits explicit child change and pure insertion references', () => {
  const context = corrected([binding('context', ['module'])])
  assert.equal(checkBindingConstraints(write('color'), context, targets).reason, 'binding-context-write')
  assert.equal(checkBindingConstraints(write('insert'), context, targets).ok, true)
  const both = corrected([binding('context', ['module']), { regionId: 'blank:ink', role: 'change', targetIds: ['title'] }])
  assert.equal(checkBindingConstraints(write('color'), both, targets).ok, true)
  assert.equal(checkBindingConstraints(write('delete', 'module'), both, targets).ok, false)
})
test('rebinding never silently applies an old write to the original object', () => {
  const corrections = corrected([binding('change', ['description'])])
  assert.equal(checkBindingConstraints(write('color'), corrections, targets).reason, 'binding-old-target')
  assert.equal(checkBindingConstraints(write('color', 'description'), corrections, targets).ok, true)
  assert.equal(bindingTargetPool([targets[1]], { nodes: targets }, corrections).find(target => target.webId === 'description').selected, true)
})

test('ancestor styles cannot bypass a specific context binding or indirectly recolor a rebound old object',()=>{
  assert.equal(checkBindingConstraints(write('style','module'),corrected([binding('context')]),targets).reason,'binding-context-write')
  assert.equal(checkBindingConstraints(write('color','module'),corrected([binding('change',['description'])]),targets).reason,'binding-old-target')
})
test('UTF-16 phrase correction supports emoji, rejects repeated/missing/truncated text', () => {
  const target = { webId: 'emoji', kind: 'text', text: '前🙂后' }
  assert.deepEqual(rangeFromQuote(target, '🙂').range, { targetId: 'emoji', start: 1, end: 3, expectedText: '🙂' })
  for (const [node, quote] of [[{ ...target, text: '重复重复' }, '重复'], [target, '无'], [{ ...target, textTruncated: true }, '前']]) assert.equal(rangeFromQuote(node, quote).ok, false)
})
test('a precise correction cannot become full-object replacement or a wider range', () => {
  const range = rangeFromQuote(targets[2], '中间几个字').range
  const corrections = corrected([{ ...binding('change', ['description']), range }])
  assert.equal(checkBindingConstraints(write('replace', 'description', { targetRanges: [range] }), corrections, targets).ok, true)
  for (const targetRanges of [[], [{ ...range, start: 0 }]]) assert.equal(checkBindingConstraints(write('replace', 'description', { targetRanges }), corrections, targets).reason, 'binding-range-expanded')
  assert.equal(checkBindingConstraints(write('color','description'),corrections,targets).reason,'binding-range-operation')
  assert.equal(normalizeBindingCorrections(raw([{ ...binding(), range: { ...range, expectedText: '错字' } }]), targets, regions).ok, false)
})
test('corrected blank insertion and move relations constrain the actual anchor and placement', () => {
  const corrections = corrected([{ regionId: 'blank:ink', role: 'destination', targetIds: [] }], [{ regionId: 'blank:ink', anchorId: 'description', placement: 'after' }])
  for (const type of ['insert', 'move']) {
    const plan = write(type, 'title', { insertion: { anchorId: 'description', placement: 'after' } })
    assert.equal(checkBindingConstraints(plan, corrections, targets).ok, true)
    assert.equal(checkBindingConstraints({ ...plan, insertion: { anchorId: 'other', placement: 'after' } }, corrections, targets).reason, 'binding-placement-mismatch')
  }
  assert.equal(checkBindingConstraints(write('color'), corrections, targets).reason, 'binding-placement-mismatch')
  assert.equal(normalizeBindingCorrections(raw([], [{ regionId: 'blank:ink', anchorId: 'other', placement: 'position' }]), targets, regions).ok, false)
})
test('compound plans do not bypass protected roles or constrained relationships', () => {
  assert.equal(checkBindingConstraints({ type: 'batch', steps: [write('color'), write('delete')] }, corrected([binding()]), targets).ok, false)
})

test('two spatial corrections are bound to stable regions, not mixed by step order or visual numbering', () => {
  const corrections = corrected([binding('change')], [
    { regionId: 'target:title', anchorId: 'description', placement: 'after' },
    { regionId: 'blank:ink', anchorId: 'module', placement: 'inside-end' },
  ])
  const move = write('move', 'title', { regionId: 'target:title', insertion: { anchorId: 'description', placement: 'after' } })
  const insert = write('insert', 'module', { regionId: 'blank:ink', insertion: { anchorId: 'module', placement: 'inside-end' } })
  assert.equal(checkBindingConstraints({ type: 'batch', steps: [insert, move] }, corrections, targets).ok, true)
  assert.equal(checkBindingConstraints({ type: 'batch', steps: [{ ...insert, regionId: 'target:title' }, move] }, corrections, targets).ok, false)
})
test('save invalidates the whole plan conservatively, preserving ink/input/assets and blocking stale stamps', () => {
  const group = { id: 'g', revision: 4, inferredIntent: write('color'), strokes: [{}], feedbackDraft: '保留输入', imageAssets: [{}] }
  const oldPlan = stampBindingPlan(group.inferredIntent, group), next = { ...group, ...correctionPatch(group, corrected([binding()])) }
  assert.equal(next.strokes, group.strokes); assert.equal(next.imageAssets, group.imageAssets); assert.equal(next.feedbackDraft, group.feedbackDraft)
  assert.equal(next.inferredIntent, null); assert.equal(next.analysisPaused, true); assert.equal(next.revision, 5)
  assert.equal(checkBindingStamp(oldPlan, next).reason, 'binding-plan-stale')
  assert.equal(checkBindingStamp(stampBindingPlan(write('insert'), next), next).ok, true)
  assert.equal(checkBindingStamp(write('insert'), next).ok, false)
})
test('semantic snapshots block missing/changed content, while geometry is absent from the contract', () => {
  const before = [{ id: 'title', parent: 'module', text: '标题', src: '' }]
  assert.equal(checkBindingSnapshot(before, structuredClone(before)).ok, true)
  assert.equal(checkBindingSnapshot(before, [{ ...before[0], parent: 'other' }]).reason, 'binding-page-changed')
  assert.equal(checkBindingSnapshot([{ id: 'title', missing: true }], [{ id: 'title', missing: true }]).ok, false)
})
test('inspector distinguishes insert references from write targets without inventing preservation', () => {
  const entries = inspectBindings({ inferredIntent: write('insert', 'title', { insertion: { anchorId: 'title' } }) }, regions, targets)
  assert.equal(entries[0].explanation, '方案以此为放置锚点')
  assert.equal(entries[0].role, 'auto')
})
