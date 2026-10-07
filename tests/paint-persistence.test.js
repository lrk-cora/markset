import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// DOM adapter only. Tests invoke actual production event handlers and rendering.
class ElementStub extends EventTarget {
  constructor(tag = 'div') {
    super(); this.tagName = tag; this.children = []; this.attrs = new Map(); this.style = {}
    this.classes = new Set()
    this.classList = {
      add: (v) => this.classes.add(v), remove: (v) => this.classes.delete(v),
      contains: (v) => this.classes.has(v), toggle: (v, on) => on ? this.classes.add(v) : this.classes.delete(v),
    }
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)) }
  getAttribute(k) { return this.attrs.get(k) ?? null }
  append(node) { this.children.push(node) }
  replaceChildren(...nodes) { this.children = nodes }
  querySelectorAll() { return this.children.filter((c) => c.attrs.has('data-stroke-id')) }
  closest(selector) { return selector === '.page' ? (this.isPage ? this : null) : this.ui ? this : null }
  setPointerCapture(id) { this.captured = id }
  releasePointerCapture() { this.captured = null }
}
const nodes = Object.fromEntries(['paint-layer', 'lasso-layer', 'page-shell'].map((id) => [id, new ElementStub()]))
nodes['page-shell'].isPage = true
globalThis.Element = ElementStub
class WindowStub extends EventTarget {
  // Node's EventTarget differs from the browser for boolean capture removal.
  addEventListener(type, fn, options) { super.addEventListener(type, fn, typeof options === 'boolean' ? { capture: options } : options) }
  removeEventListener(type, fn, options) { super.removeEventListener(type, fn, typeof options === 'boolean' ? { capture: options } : options) }
}
globalThis.window = new WindowStub()
globalThis.document = {
  body: new ElementStub(), getElementById: (id) => nodes[id] || null,
  querySelector: () => null, querySelectorAll: () => [],
  createElementNS: (_, tag) => new ElementStub(tag),
}
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
const overlay = await import('../src/overlay.js')
const store = await import('../src/brush-store.js')
const settings = await import('../src/brush-settings.js')
let dispose, cancels, starts
function pointer(type, x = 10, y = 100, overrides = {}) {
  const e = new Event(type, { cancelable: true })
  for (const [key, value] of Object.entries({
    pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    pointerType: 'mouse', clientX: x, clientY: y, target: nodes['page-shell'], ...overrides,
  })) Object.defineProperty(e, key, { value })
  window.dispatchEvent(e)
  return e
}
function drag(y, { short = false, fast = false } = {}) {
  pointer('pointerdown', 10, y)
  if (!fast) pointer('pointermove', short ? 17 : 90, y)
  pointer('pointerup', short ? 20 : 140, y)
}
const lines = () => nodes['paint-layer'].children.filter((c) => c.tagName === 'polyline')
beforeEach(() => {
  settings.resetBrushSettings()
  overlay.clearPaintMarks(); overlay.setLassoMode(true); store.resetBrushState()
  cancels = []; starts = 0
  dispose = overlay.bindLasso({ onStart: () => starts++, onCancel: (e) => cancels.push(e) })
})
afterEach(() => { dispose(); delete nodes['web-doc-frame'] })
test('production overlay persists open horizontal, vertical and short strokes', () => {
  drag(100); drag(125, { short: true })
  pointer('pointerdown', 170, 90); pointer('pointermove', 170, 160); pointer('pointerup', 170, 190)
  assert.equal(lines().length, 3)
  assert.equal(overlay.getPaintMarks().length, 3)
  assert.ok(overlay.getPaintMarks().every((m) => !m.closed))
  assert.equal(nodes['lasso-layer'].children.length, 0)
})
test('fast down/up without ANY pointermove is a stroke, never clear-group tap', () => {
  drag(100); drag(130, { fast: true }); drag(150, { short: true, fast: true })
  assert.equal(lines().length, 3); assert.equal(cancels.length, 0)
})
test('analysis is suspended at pointerdown, before the movement threshold', () => {
  pointer('pointerdown')
  assert.equal(starts, 1)
  assert.equal(nodes['page-shell'].captured, 1)
  assert.equal(document.body.classList.contains('is-lassoing'), true)
})
test('50 spaced strokes retain distinct ids through analysis-only refreshes', () => {
  for (let i = 0; i < 50; i++) {
    drag(80 + i * 3, { fast: i % 2 === 0 })
    overlay.setPaintMarks(overlay.getPaintMarks())
    assert.equal(lines().length, i + 1)
  }
  assert.equal(new Set(lines().map((line) => line.getAttribute('data-stroke-id'))).size, 50)
})
test('pointer cancellation preserves samples once and does not clear previous ink', () => {
  drag(100)
  pointer('pointerdown', 10, 130); pointer('pointermove', 100, 130)
  pointer('pointercancel', 0, 0); pointer('lostpointercapture', 0, 0); pointer('pointerup', 0, 0)
  assert.equal(lines().length, 2)
  assert.deepEqual(overlay.getPaintMarks()[1].points.at(-1), { x: 100, y: 130 })
  assert.equal(cancels.length, 0)
  drag(170); assert.equal(lines().length, 3)
})
test('lost capture, window blur and missed mouseup do not lock the next stroke', () => {
  for (const type of ['lostpointercapture', 'blur', 'pointermove']) {
    pointer('pointerdown'); pointer('pointermove', 100, 100)
    pointer(type, 150, 100, { buttons: 0 })
    drag(150)
  }
  assert.equal(lines().length, 6)
})

test('24px appearance controls the actual line and dot with fixed opacity, not brush mode or raw geometry', () => {
  overlay.disarmDrawing()
  settings.setBrushSettings({ width: 24, color: '#d94c3d', opacity: 0.4, smoothing: 'strong' })
  assert.equal(overlay.isLassoMode(), false, 'choosing a color never enters brush mode')
  overlay.setLassoMode(true)
  drag(100)
  const line = lines()[0]
  assert.equal(line.getAttribute('stroke'), '#d94c3d')
  assert.equal(line.getAttribute('stroke-width'), '24')
  assert.equal(line.getAttribute('opacity'), '0.8')
  pointer('pointerdown', 60, 140); pointer('pointerup', 60, 140)
  const dot = nodes['paint-layer'].children.find((child) => child.tagName === 'circle')
  assert.equal(dot.getAttribute('r'), '12')
  assert.equal(dot.getAttribute('opacity'), '0.8')
  assert.deepEqual(overlay.getPaintMarks()[1].points, [{ x: 60, y: 140 }])
  settings.resetBrushSettings()
  overlay.setPaintMarks(overlay.getPaintMarks())
  assert.equal(lines()[0].getAttribute('stroke-width'), '24', 'reset does not reinterpret previous strokes')
})

test('a settings change mid-drag cannot change half of the current stroke', () => {
  settings.setBrushSettings({ width: 7, color: '#2f8f5b', opacity: 0.6 })
  pointer('pointerdown', 10, 100); pointer('pointermove', 90, 100)
  settings.setBrushSettings({ width: 12, color: '#d94c3d' })
  pointer('pointerup', 140, 100)
  assert.equal(lines()[0].getAttribute('stroke-width'), '7')
  assert.equal(lines()[0].getAttribute('stroke'), '#2f8f5b')
  drag(150)
  assert.equal(lines()[1].getAttribute('stroke-width'), '12')
})
test('fresh pointerdown recovers a missing release without merging gestures', () => {
  pointer('pointerdown', 10, 100); pointer('pointermove', 90, 100)
  drag(180)
  assert.equal(lines().length, 2)
  assert.deepEqual(overlay.getPaintMarks()[0].points.at(-1), { x: 90, y: 100 })
  assert.deepEqual(overlay.getPaintMarks()[1].points[0], { x: 10, y: 180 })
})
test('coalesced samples are retained and a secondary pointer cannot finish ink', () => {
  pointer('pointerdown')
  pointer('pointermove', 100, 100, { getCoalescedEvents: () => [{ clientX: 30, clientY: 80 }, { clientX: 60, clientY: 90 }] })
  pointer('pointerup', 200, 200, { pointerId: 2 })
  assert.equal(lines().length, 0)
  pointer('pointerup', 130, 100)
  assert.equal(lines().length, 1)
  assert.equal(overlay.getPaintMarks()[0].points.length, 5)
})
test('mode switch finishes current ink; browse mode and UI/gutter do not draw', () => {
  pointer('pointerdown'); pointer('pointermove', 100, 100)
  overlay.disarmDrawing()
  assert.equal(lines().length, 1)
  drag(140); assert.equal(lines().length, 1)
  overlay.setLassoMode(true)
  const ui = new ElementStub(); ui.ui = true; ui.isPage = true
  for (const target of [ui, new ElementStub()]) {
    pointer('pointerdown', 10, 100, { target }); pointer('pointerup', 200, 100)
  }
  assert.equal(lines().length, 1)
})
test('a stationary click persists a dot, but cancelled contact does not', () => {
  pointer('pointerdown'); pointer('pointerup')
  pointer('pointerdown'); pointer('pointercancel')
  assert.deepEqual(cancels.map((e) => [e.tap, e.cancelled]), [[false, true]])
  const dots = nodes['paint-layer'].children.filter((child) => child.tagName === 'circle')
  assert.equal(dots.length, 1)
  assert.equal(dots[0].getAttribute('cx'), '10')
  assert.equal(dots[0].getAttribute('cy'), '100')
  assert.equal(dots[0].getAttribute('r'), '2.25')
  assert.deepEqual(overlay.getPaintMarks()[0].points, [{ x: 10, y: 100 }])
  assert.equal(overlay.getPaintMarks()[0].shape, 'dot')
  assert.equal(overlay.isLassoMode(), true)
})

test('taps and small click jitter append dots without cancelling or erasing other ink', () => {
  drag(100)
  pointer('pointerdown', 60, 130); pointer('pointerup', 60, 130)
  pointer('pointerdown', 70, 140); pointer('pointermove', 71, 140); pointer('pointerup', 72, 140)
  drag(160)
  const marks = overlay.getPaintMarks()
  assert.equal(marks.length, 4)
  assert.equal(lines().length, 2)
  assert.equal(nodes['paint-layer'].children.filter((child) => child.tagName === 'circle').length, 2)
  assert.equal(cancels.length, 0)
  assert.deepEqual(marks[2].points, [{ x: 70, y: 140 }])
  overlay.setPaintMarks(marks)
  assert.equal(nodes['paint-layer'].children.length, 4)
  nodes['paint-layer'].replaceChildren()
  overlay.setPaintMarks(marks)
  assert.equal(nodes['paint-layer'].children.length, 4)
})

test('app-owned tap ink is committed exactly once and remains after group analysis', () => {
  dispose()
  const unsub = store.subscribeBrush(({ group }) => overlay.setPaintMarks(group?.strokes || []))
  let finished = 0
  dispose = overlay.bindLasso({ onFinish: (polygon, meta) => {
    finished++
    assert.equal(meta.shape, 'dot')
    assert.equal(meta.closed, false)
    assert.equal(polygon.length, 4, 'dot has a small hit region, not an empty selection')
    store.startGroup({ id: 'tap-group', revision: 1, strokes: [{ id: meta.strokeId, points: meta.rawPoints, color: meta.strokeColor, shape: meta.shape }] })
    return { paintOwned: true }
  } })
  try {
    pointer('pointerdown', 60, 130); pointer('pointerup', 60, 130)
    assert.equal(finished, 1)
    assert.equal(store.getBrushState().group.strokes.length, 1)
    store.patchGroupAnalysis(store.getBrushState().group, { status: 'suggested' })
    assert.equal(nodes['paint-layer'].children.length, 1)
    assert.equal(nodes['paint-layer'].children[0].tagName, 'circle')
  } finally { unsub() }
})
test('Escape discards only active ink in overlay, not existing ink', () => {
  drag(100); pointer('pointerdown'); pointer('pointermove', 150, 150)
  pointer('keydown', 0, 0, { key: 'Escape' }); pointer('pointerup', 200, 200)
  assert.equal(lines().length, 1)
  assert.equal(nodes['lasso-layer'].children.length, 0)
})
test('symbol classification must not hide raw ink; authoritative clear is accepted', () => {
  drag(100); drag(130)
  const marks = overlay.getPaintMarks()
  overlay.setPaintMarks([{ ...marks[0], role: 'symbol' }])
  assert.equal(lines().length, 1)
  overlay.setPaintMarks([]); assert.equal(lines().length, 0)
})
test('render restores missing SVG nodes and updates stroke color', () => {
  drag(100); const marks = overlay.getPaintMarks()
  nodes['paint-layer'].replaceChildren()
  overlay.setPaintMarks(marks); assert.equal(lines().length, 1)
  overlay.setPaintMarks([{ ...marks[0], color: '#ff0000' }])
  assert.equal(lines()[0].getAttribute('stroke'), '#ff0000')
})
test('document ink stays anchored after page scroll and zoom', () => {
  const frame = new ElementStub()
  frame.contentDocument = { documentElement: { style: { zoom: '0.5' } }, defaultView: { scrollX: 0, scrollY: 20 } }
  let top = 100
  frame.getBoundingClientRect = () => ({ left: 30, top })
  nodes['web-doc-frame'] = frame
  drag(200)
  top -= 60
  assert.equal(overlay.getPaintMarks()[0].points[0].y, 140)
  frame.contentDocument.defaultView.scrollY += 20
  assert.equal(overlay.getPaintMarks()[0].points[0].y, 130)
})
test('real group analysis cannot overwrite ink or revive a cleared group', () => {
  const first = { id: 'g1', revision: 1, strokes: [{ id: 's1' }] }
  store.startGroup(first)
  store.patchGroup({ revision: 2, strokes: [...first.strokes, { id: 's2' }] })
  assert.equal(store.patchGroupAnalysis(first, { strokes: first.strokes, status: 'suggested' }), null)
  const current = store.getBrushState().group
  store.patchGroupAnalysis(current, { strokes: [], revision: 0, id: 'wrong', status: 'suggested' })
  assert.equal(store.getBrushState().group.strokes.length, 2)
  assert.equal(store.getBrushState().group.status, 'suggested')
  store.clearGroup()
  assert.equal(store.patchGroupAnalysis(current, { status: 'suggested' }), null)
  store.startGroup({ ...first, id: 'g2' })
  assert.equal(store.patchGroupAnalysis(first, { status: 'suggested' }), null)
})

test('app-owned ink survives synchronous render during pointerup and delayed analysis', async () => {
  dispose()
  const unsub = store.subscribeBrush(({ group }) => overlay.setPaintMarks(group?.strokes || []))
  dispose = overlay.bindLasso({ onFinish: (_, meta) => {
    const group = store.getBrushState().group
    const stroke = { id: meta.strokeId, points: meta.rawPoints, closed: meta.closed, color: meta.strokeColor }
    if (!group) store.startGroup({ id: 'session', revision: 1, strokes: [stroke] })
    else store.patchGroup({ revision: group.revision + 1, strokes: [...group.strokes, stroke] })
    return { paintOwned: true }
  } })
  try {
    drag(100)
    const oldAnalysis = structuredClone(store.getBrushState().group)
    pointer('pointerdown', 10, 130); pointer('pointermove', 100, 130)
    // A pending request finishes while the next line is still on the live layer.
    await Promise.resolve()
    store.patchGroupAnalysis(oldAnalysis, { status: 'suggested' })
    assert.equal(lines().length, 1)
    assert.equal(nodes['lasso-layer'].children.length, 1)
    pointer('pointerup', 150, 130)
    assert.equal(lines().length, 2)
    assert.equal(nodes['lasso-layer'].children.length, 0)
    store.patchGroupAnalysis(oldAnalysis, { strokes: oldAnalysis.strokes, status: 'suggested' })
    assert.equal(lines().length, 2)
    store.clearGroup()
    assert.equal(lines().length, 0)
    drag(190, { fast: true })
    assert.equal(lines().length, 1)
  } finally { unsub() }
})

test('closed curves, a two-stroke cross and raw unrecognised ink coexist', () => {
  pointer('pointerdown', 160, 140)
  for (let i = 1; i <= 36; i++) {
    const a = i * Math.PI * 2 / 36
    pointer('pointermove', 100 + 60 * Math.cos(a), 140 + 40 * Math.sin(a))
  }
  pointer('pointerup', 160, 140)
  pointer('pointerdown', 210, 110); pointer('pointermove', 270, 170); pointer('pointerup', 270, 170)
  pointer('pointerdown', 270, 110); pointer('pointermove', 210, 170); pointer('pointerup', 210, 170)
  drag(220, { short: true })
  assert.equal(lines().length, 4)
  assert.ok(overlay.getPaintMarks()[0].closed)
  assert.ok(nodes['paint-layer'].children.some((c) => c.tagName === 'path'))
  overlay.setPaintMarks(overlay.getPaintMarks())
  assert.equal(lines().length, 4)
})

test('retraced wide oval persists both ink and a filled selection through real pointer handlers', () => {
  const points = Array.from({ length: 100 }, (_, i) => {
    const angle = i / 99 * (Math.PI * 2 + 0.2)
    return { x: 480 + 390 * Math.cos(angle), y: 300 + 110 * Math.sin(angle) }
  })
  pointer('pointerdown', points[0].x, points[0].y)
  for (const point of points.slice(1, -1)) pointer('pointermove', point.x, point.y)
  pointer('pointerup', points.at(-1).x, points.at(-1).y)
  assert.equal(lines().length, 1)
  assert.equal(overlay.getPaintMarks()[0].closed, true)
  assert.ok(nodes['paint-layer'].children.some((child) => child.tagName === 'path'))
  overlay.setPaintMarks(overlay.getPaintMarks())
  assert.equal(lines().length, 1)
})

test('a component-close UI control cannot start ink or trigger blank-click cancellation', () => {
  drag(100)
  const button = new ElementStub('button')
  button.ui = true
  button.className = 'target-deselect app-ui'
  const beforeStarts = starts
  pointer('pointerdown', 150, 80, { target: button })
  pointer('pointerup', 150, 80, { target: button })
  assert.equal(starts, beforeStarts)
  assert.equal(cancels.length, 0)
  assert.equal(lines().length, 1)
})
