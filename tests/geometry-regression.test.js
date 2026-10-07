import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyMarkShape, classifyStrokeShape, isRegionStroke, isSelfIntersecting, looksLikeDrawnLine, looksLikeEnclosingStroke, looksLikeXStroke, paintHitPolygon, pointInPolygon } from '../src/geometry.js'
import { interpretGroup } from '../src/gesture-interpreter.js'

const ellipse = ({ rx = 390, ry = 110, sweep = Math.PI * 2 + 0.2, n = 100, phase = 0 } = {}) => Array.from({ length: n }, (_, i) => {
  const t = phase + i / (n - 1) * sweep
  return { x: 480 + rx * Math.cos(t), y: 300 + ry * Math.sin(t) }
})

test('open diagonal strokes at every angle are lines, not filled regions or replacement scopes', () => {
  for (const [dx,dy] of [[485,280],[550,250],[420,220],[250,350],[0,350],[400,0],[-420,220]]) {
    const points=Array.from({length:51},(_,i)=>({x:500+dx*i/50,y:100+dy*i/50+Math.sin(i*.6)*1.5}))
    assert.equal(looksLikeEnclosingStroke(points),false,`${dx},${dy}`)
    assert.equal(isRegionStroke(points),false)
    assert.equal(classifyMarkShape([points]).shape,'line')
    const polygon=paintHitPolygon(points)
    // Far from the shaft inside its AABB must not become a selected triangle.
    if(dx && dy) assert.equal(pointInPolygon(500+dx*.2,100+dy*.8,polygon),false)
    const intent=interpretGroup({strokes:[{points,shape:'line'}],targets:[{webId:'title',kind:'text',text:'科研标题',markedRanges:[{start:0,end:2,text:'科研'}]}]})
    assert.equal(intent.parameters.hasRegion,false);assert.equal(intent.type,'delete')
  }
})

test('a wide lasso with a retraced end reproduces the reported crossing, without recursive classifiers', () => {
  const points = ellipse()
  assert.equal(isSelfIntersecting(points), true, 'fixture must reach the previously recursive X branch')
  assert.equal(looksLikeEnclosingStroke(points), true)
  assert.equal(looksLikeXStroke(points), false)
  assert.equal(looksLikeDrawnLine(points), false)
  assert.equal(isRegionStroke(points), true)
  const polygon = paintHitPolygon(points)
  assert.ok(polygon.length >= 3)
  assert.equal(pointInPolygon(480, 300, polygon), true)
})

test('wide near-closed and retraced ovals remain region selection, not a text deletion line', () => {
  for (const sweep of [Math.PI * 2 - 0.25, Math.PI * 2, Math.PI * 2 + 0.2]) {
    const points = ellipse({ sweep })
    const shape = classifyMarkShape([points]).shape
    assert.notEqual(shape, 'line')
    assert.notEqual(shape, 'x')
    assert.notEqual(shape, 'arrow')
    const intent = interpretGroup({ strokes: [{ points, shape }], targets: [{
      webId: 'title', kind: 'text', text: '把 Agent 做成可研究的交互',
      markedRanges: [{ start: 0, end: 2, text: '把 ' }],
    }] })
    assert.equal(intent.parameters.hasRegion, true)
    assert.notEqual(intent.type, 'delete')
  }
})

test('classifiers terminate across skinny, tall, shifted, open and overlapping lassos', () => {
  for (const [rx, ry] of [[390, 110], [220, 14], [14, 220], [90, 90]]) {
    for (const sweep of [Math.PI, Math.PI * 1.8, Math.PI * 2, Math.PI * 2.1]) {
      for (const phase of [0, 0.7, 2]) {
        const points = ellipse({ rx, ry, sweep, phase, n: 45 })
        assert.doesNotThrow(() => {
          looksLikeEnclosingStroke(points); looksLikeXStroke(points); looksLikeDrawnLine(points)
          isRegionStroke(points); classifyStrokeShape(points); classifyMarkShape([points]); paintHitPolygon(points)
        })
      }
    }
  }
})
