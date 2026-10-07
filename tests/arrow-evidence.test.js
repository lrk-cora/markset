import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyMarkShape, looksLikeArrowGesture } from '../src/geometry.js'
import { interpretGroup } from '../src/gesture-interpreter.js'
const path = (...coords) => coords.map(([x, y]) => ({ x, y }))
test('long lines are not arrows (regression: every chord > 90px was an arrow)', () => {
  for (const stroke of [path([0,0],[50,0],[100,0],[180,0]), path([0,0],[0,180]), path([0,0],[200,200])]) {
    assert.equal(looksLikeArrowGesture([stroke]), false)
    assert.notEqual(classifyMarkShape([stroke]).shape, 'arrow')
  }
})
test('two parallel lines or crossing strokes do not imply arrowheads', () => {
  const shaft = path([0,0],[200,0])
  assert.equal(looksLikeArrowGesture([shaft, path([0,20],[200,20])]), false)
  assert.equal(looksLikeArrowGesture([shaft, path([100,-80],[100,80])]), false)
})
test('separate and continuous heads work in horizontal, vertical, diagonal directions', () => {
  for (const transform of [p => p, ({x,y}) => ({x:y,y:x}), ({x,y}) => ({x:(x-y)*0.707,y:(x+y)*0.707})]) {
    const shaft = path([0,0],[200,0]).map(transform)
    const head = path([175,-20],[200,0],[175,20]).map(transform)
    assert.equal(looksLikeArrowGesture([shaft, head]), true)
    assert.equal(looksLikeArrowGesture([[...shaft, ...head]]), true)
  }
})
test('an open straight mark does not suggest rearranging peer text objects', () => {
  const points = path([0,0],[50,0],[100,0],[180,0])
  const shape = classifyMarkShape([points]).shape
  const plan = interpretGroup({ strokes: [{points, shape}], targets: [1,2].map((id) => ({ webId: String(id), kind: 'text', text: 'text', context: {parentId:'p',tag:'span'} })) })
  assert.equal(plan.parameters.hasArrow, false)
  assert.notEqual(plan.type, 'reorder')
})

test('densely sampled continuous arrows retain their heads despite a wide bounding box', () => {
  for (const vertices of [path([0,0],[200,0],[175,-20]), path([0,0],[200,0],[175,-20],[200,0],[175,20])]) {
    const points = vertices.slice(0, -1).flatMap((a, i) => Array.from({ length: 12 }, (_, j) => ({
      x: a.x + (vertices[i + 1].x - a.x) * j / 12,
      y: a.y + (vertices[i + 1].y - a.y) * j / 12,
    }))).concat(vertices.at(-1))
    assert.equal(looksLikeArrowGesture([points]), true)
    assert.equal(classifyMarkShape([points]).shape, 'arrow')
  }
})
