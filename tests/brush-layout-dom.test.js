import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { reflowBrushGroup } from '../src/brush-layout.js'

const dom = new JSDOM('<main class="page"><div id="web-doc-host"><iframe id="web-doc-frame"></iframe></div></main>', { url: 'https://markset.test/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, DOMParser: dom.window.DOMParser, NodeFilter: dom.window.NodeFilter,
  CSS: { escape: (value) => String(value) }, requestAnimationFrame: () => 0 })
const web = await import('../src/web-doc.js')
const frame = document.getElementById('web-doc-frame')
frame.getBoundingClientRect = () => ({ left: 28, top: 100, width: 1200, height: 1000 })
Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 1200 })
const doc = () => frame.contentDocument
const rectangles = new Map()
beforeEach(() => {
  assert.equal(web.mountWebDoc('<html><body><section data-markset-id="module"><h1 data-markset-id="title">标题</h1><p data-markset-id="other">其他内容</p></section></body></html>'), true)
  rectangles.clear()
  rectangles.set('module', { x: 10, y: 20, w: 1100, h: 700 })
  rectangles.set('title', { x: 20, y: 50, w: 900, h: 100 })
  for (const el of doc().querySelectorAll('[data-markset-id]')) el.getBoundingClientRect = () => {
    const rect = rectangles.get(el.getAttribute('data-markset-id')) || { x: 0, y: 0, w: 0, h: 0 }
    return { ...rect, left: rect.x, top: rect.y, width: rect.w, height: rect.h }
  }
})
after(() => dom.window.close())

test('production DOM anchor capture resolves a heading and reflows it instead of keeping viewport coordinates', () => {
  const stroke = web.attachBrushLayoutAnchor({ id: 'circle', closed: true, points: [{ x: 10, y: 40 }, { x: 930, y: 160 }] }, [{ webId: 'title', kind: 'text' }])
  assert.deepEqual(stroke.layoutAnchor.reference.objects, [{ webId: 'title' }])
  rectangles.set('title', { x: 20, y: 50, w: 600, h: 200 })
  const next = reflowBrushGroup({ coordinateSpace: 'web-document', strokes: [stroke], targets: [] }, web.resolveBrushLayoutRect)
  assert.deepEqual(next.strokes[0].points, [{ x: 20 - 20 / 3, y: 30 }, { x: 20 + 1820 / 3, y: 270 }])
})

test('production blank box anchors to the local module, not an incidental loose heading hit', () => {
  const stroke = web.attachBrushLayoutAnchor({ id: 'blank', closed: true, points: [{ x: 800, y: 400 }, { x: 1080, y: 650 }] }, [{ webId: 'title', kind: 'text' }])
  assert.deepEqual(stroke.layoutAnchor.reference.objects, [{ webId: 'module' }])
  rectangles.set('module', { x: 10, y: 20, w: 800, h: 850 })
  const rect = web.resolveBrushLayoutRect(stroke.layoutAnchor.reference)
  assert.deepEqual(rect, { x: 10, y: 20, w: 800, h: 850 })
})

test('production union of multiple page objects and missing-object handling use the geometry API correctly', () => {
  const ref = { kind: 'objects', objects: [{ webId: 'title' }, { webId: 'module' }] }
  assert.deepEqual(web.resolveBrushLayoutRect(ref), { x: 10, y: 20, w: 1100, h: 700 })
  doc().querySelector('[data-markset-id="title"]').remove()
  assert.equal(web.resolveBrushLayoutRect(ref), null)
})

test('page fallback adapts width without scaling vertical ink against total page height', () => {
  const stroke = web.attachBrushLayoutAnchor({ points: [{ x: 1120, y: 900 }, { x: 1190, y: 960 }] }, [])
  assert.equal(stroke.layoutAnchor.reference.kind, 'page')
  Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 900 })
  const next = reflowBrushGroup({ coordinateSpace: 'web-document', strokes: [stroke], targets: [] }, web.resolveBrushLayoutRect)
  assert.deepEqual(next.strokes[0].points, [{ x: 840, y: 900 }, { x: 892.5, y: 960 }])
  Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 1200 })
})
