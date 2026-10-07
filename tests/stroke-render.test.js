import test from 'node:test'
import assert from 'node:assert/strict'
import { displayStrokePoints, drawCanvasStroke } from '../src/stroke-render.js'

function context() {
  const calls = []
  const ctx = Object.fromEntries(['beginPath', 'arc', 'fill', 'moveTo', 'lineTo', 'stroke'].map((name) => [name, (...args) => calls.push([name, ...args])]))
  return { ctx, calls }
}

test('display smoothing reduces jitter without mutating recognition samples or endpoints', () => {
  const raw = [{ x: 0, y: 0 }, { x: 10, y: 3 }, { x: 20, y: 0 }]
  const before = structuredClone(raw)
  const light = displayStrokePoints(raw, 'light'), strong = displayStrokePoints(raw, 'strong')
  assert.ok(strong[1].y < light[1].y && light[1].y < raw[1].y)
  assert.deepEqual(raw, before)
  assert.deepEqual(light[0], raw[0]); assert.deepEqual(light.at(-1), raw.at(-1))
  assert.deepEqual(displayStrokePoints(raw, 'none'), raw)
})
test('smoothing preserves sharp box/arrow corners and single-point dots', () => {
  const corner = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
  assert.deepEqual(displayStrokePoints(corner, 'strong'), corner)
  assert.deepEqual(displayStrokePoints([{ x: 4, y: 7 }], 'strong'), [{ x: 4, y: 7 }])
})

test('a single point becomes a filled circular dot in the model screenshot', () => {
  const { ctx, calls } = context()
  drawCanvasStroke(ctx, [{ x: 40, y: 50 }], '#3c6fd4', 4.5, (point) => ({ x: point.x / 2, y: point.y / 2 }))
  assert.equal(ctx.fillStyle, '#3c6fd4')
  assert.deepEqual(calls, [['beginPath'], ['arc', 20, 25, 2.25, 0, Math.PI * 2], ['fill']])
})

test('multi-point paths remain round-capped strokes, and empty ink is ignored', () => {
  const { ctx, calls } = context()
  drawCanvasStroke(ctx, [], 'red', 4.5)
  assert.deepEqual(calls, [])
  drawCanvasStroke(ctx, [{ x: 10, y: 20 }, { x: 50, y: 30 }], 'red', 4.5)
  assert.deepEqual(calls, [['beginPath'], ['moveTo', 10, 20], ['lineTo', 50, 30], ['stroke']])
  assert.equal(ctx.strokeStyle, 'red')
  assert.equal(ctx.lineWidth, 4.5)
  assert.equal(ctx.lineCap, 'round')
})
