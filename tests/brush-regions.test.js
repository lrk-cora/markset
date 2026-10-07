import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBrushRegions, orderBrushRegions, hasBrushRegionReference, planningRegionEvidence, drawBrushRegionNumbers, positionBrushRegionLabels } from '../src/brush-regions.js'

const target = (webId, x, y, w = 150, h = 60) => ({ webId, kind: 'text', documentRect: { x, y, w, h } })
const box = (id, x, y, w, h, extra = {}) => ({ id, closed: true, shape: 'box', points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }], ...extra })

test('region numbering follows reading position, not selection/drawing order, with slightly misaligned rows', () => {
  const targets = [target('bottom', 20, 220), target('right', 300, 98), target('left', 20, 103)]
  const original = JSON.stringify(targets)
  const group = { coordinateSpace: 'web-document', targets, strokes: [] }
  const regions = buildBrushRegions(group)
  assert.deepEqual(regions.map(r => [r.number, r.targetIds[0]]), [[1, 'left'], [2, 'right'], [3, 'bottom']])
  assert.deepEqual(buildBrushRegions({ ...group, targets: targets.toReversed() }), regions)
  assert.equal(JSON.stringify(targets), original)
})

test('a higher top edge on the tall right frame cannot precede the upper-centered left title', () => {
  // Reproduces the reported title + tall image-placeholder layout.
  const group = { targets: [target('title', 30, 135, 1400, 410)], strokes: [box('image', 1470, 25, 560, 850)] }
  const regions = buildBrushRegions(group)
  assert.deepEqual(regions.map(r => [r.number, r.id]), [[1, 'target:title'], [2, 'blank:image']])
  assert.ok(regions[1].rect.y < regions[0].rect.y, 'top-edge order is deliberately not the numbering order')
})

test('same-row horizontal order uses centers even when width makes left edges misleading', () => {
  const group = { targets: [target('wide', 0, 100, 600, 80), target('narrow', 220, 100, 40, 80)], strokes: [] }
  assert.deepEqual(buildBrushRegions(group).map(r => r.id), ['target:narrow', 'target:wide'])
})

test('different heights and top edges share a row when their vertical centers coincide', () => {
  const group = { targets: [target('right', 350, 160, 160, 80), target('left', 20, 40, 240, 320)] }
  const regions = buildBrushRegions(group)
  assert.deepEqual(regions.map(r => r.id), ['target:left', 'target:right'])
  assert.deepEqual(buildBrushRegions({ ...group, targets: group.targets.toReversed() }), regions)
})

test('selected content and an adjacent empty frame get one shared numbered index', () => {
  const group = { targets: [target('title', 20, 100, 500, 200)], strokes: [box('blank', 560, 70, 220, 280), box('circle', 0, 80, 540, 240)] }
  const regions = buildBrushRegions(group)
  assert.deepEqual(regions.map(r => [r.number, r.kind]), [[1, 'target'], [2, 'blank']])
  assert.deepEqual(regions[0].strokeIds, ['circle'])
  assert.deepEqual(regions[1].strokeIds, ['blank'])
  assert.deepEqual(regions[1].rect, { x: 560, y: 70, w: 220, h: 280 })
})

test('repeated empty frames deduplicate, dots/open lines/degenerate ink do not become regions', () => {
  const group = { targets: [], strokes: [box('first', 30, 40, 100, 100), box('again', 33, 41, 99, 100), { id: 'line', points: [{ x: 300, y: 20 }, { x: 400, y: 30 }] }, { id: 'dot', shape: 'dot', points: [{ x: 90, y: 90 }] }, box('tiny', 400, 20, 10, 10)] }
  const regions = buildBrushRegions(group)
  assert.equal(regions.length, 1)
  assert.deepEqual(regions[0].strokeIds, ['first', 'again'])
  assert.deepEqual(buildBrushRegions(null), [])
})

test('deselection renumbers by position and cannot turn canceled selection ink into blank evidence', () => {
  const a = target('a', 20, 50), b = target('b', 230, 50)
  const strokes = [box('a-circle', 0, 30, 180, 100, { hitTargetIds: ['a'] })]
  assert.equal(buildBrushRegions({ targets: [a, b], strokes }).length, 2)
  const regions = buildBrushRegions({ targets: [b], excludedTargetIds: ['a'], strokes })
  assert.deepEqual(regions.map(r => [r.number, r.targetIds]), [[1, ['b']]])
  assert.equal(buildBrushRegions({ targets: [b], excludedTargetIds: ['a-child'], strokes: [box('nested-circle', 0, 30, 180, 100, { hitTargetIds: ['a', 'a-child'] })] }).length, 1,
    'indirectly excluded parents cannot resurrect the canceled region as an insertion frame')
})

test('a small empty frame inside a selected container remains an independently referencable position', () => {
  const group = { targets: [{ ...target('module', 0, 0, 800, 600), kind: 'container' }], strokes: [box('inner', 550, 200, 200, 150)] }
  assert.deepEqual(buildBrushRegions(group).map(r => r.kind), ['target', 'blank'])
})

test('ordering is stable across scroll offsets, reflow and non-transitive near-row inputs', () => {
  const regions = ['c', 'b', 'a'].map((id, index) => ({ id, rect: { x: 300 - index * 100, y: 10 + index * 7, w: 90, h: 60 } }))
  const ordered = orderBrushRegions(regions).map(r => r.id)
  assert.deepEqual(orderBrushRegions(regions.toReversed()).map(r => r.id), ordered)
  assert.deepEqual(orderBrushRegions(regions.map(r => ({ ...r, rect: { ...r.rect, y: r.rect.y - 300 } }))).map(r => r.id), ordered)
})

test('model evidence keeps visible region numbers and rejects invalid or out-of-scope references', () => {
  const targets = [target('a', 20, 50), target('b', 230, 50)]
  const strokes = [box('blank', 450, 50, 100, 100)]
  const regions = buildBrushRegions({ targets, strokes })
  assert.deepEqual(planningRegionEvidence(regions, targets, strokes), regions)
  const malicious = { ...regions[0], number: 99, targetIds: ['not-selected'] }
  assert.deepEqual(planningRegionEvidence([...regions, null, malicious, { ...regions[1], number: 0 }], targets, strokes), regions)
})

test('numbered instructions bypass broad local shortcuts; ordinary colors/copy do not', () => {
  for (const text of ['区域 2 改红', '区域1的文字移到区域2', '第2个区域加图', '选区#3', 'R2 remove']) assert.ok(hasBrushRegionReference(text), text)
  for (const text of ['改成红色', '添加2张图片', '这块区域改红']) assert.equal(hasBrushRegionReference(text), false, text)
})

test('screenshot labels carry the same numbers at mapped top-left positions, not in page DOM', () => {
  const calls = [], ctx = Object.fromEntries(['save', 'restore', 'fillRect', 'strokeRect', 'fillText'].map(name => [name, (...args) => calls.push([name, ...args])]))
  const regions = buildBrushRegions({ targets: [target('right', 300, 50), target('left', 20, 50)], strokes: [] })
  drawBrushRegionNumbers(ctx, regions, (_, p) => ({ x: p.x / 2, y: p.y / 2 }), 0.5)
  assert.deepEqual(calls.filter(c => c[0] === 'fillText'), [['fillText', '1', 19, 25], ['fillText', '2', 159, 25]])
  calls.length = 0
  drawBrushRegionNumbers(ctx, regions.slice(0, 1), (_, p) => p)
  assert.deepEqual(calls, [])
})

test('nested selection numbers do not cover one another in either UI positions or screenshots', () => {
  const regions = buildBrushRegions({ targets: [target('parent', 20, 50, 300, 150), target('child', 20, 50, 80, 40)] })
  const labels = positionBrushRegionLabels(regions)
  assert.deepEqual(labels.map(label => [label.region.number, label.x, label.y]), [[1, 26, 38], [2, 54, 38]])
  const text = [], ctx = { save() {}, restore() {}, fillRect() {}, strokeRect() {}, fillText: (...args) => text.push(args) }
  drawBrushRegionNumbers(ctx, regions, (_, p) => ({ x: p.x / 2, y: p.y / 2 }), .5)
  assert.deepEqual(text, [['1', 19, 25], ['2', 33, 25]])
})
