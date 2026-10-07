import test from 'node:test'
import assert from 'node:assert/strict'
import { interpretGroup } from '../src/gesture-interpreter.js'

const cardText = {
  webId: 'card-text',
  kind: 'text',
  text: '一个内容卡片',
  screenRect: { x: 40, y: 40, w: 180, h: 90 },
  context: { parentId: 'card', tag: 'p', layout: 'flow' },
}
const cardImage = {
  webId: 'card-image',
  kind: 'image',
  text: '',
  screenRect: { x: 40, y: 40, w: 180, h: 90 },
  context: { parentId: 'card', tag: 'img', layout: 'flow' },
}

test('a cross over a mixed card is interpreted as removal', () => {
  const plan = interpretGroup({
    strokes: [{ shape: 'x', points: [{ x: 55, y: 55 }, { x: 190, y: 115 }] }],
    targets: [cardText, cardImage],
  })
  assert.equal(plan.type, 'delete')
  assert.equal(plan.needsInput, false)
})

test('an image-only cross remains a replacement candidate', () => {
  const plan = interpretGroup({
    strokes: [{ shape: 'x', points: [{ x: 55, y: 55 }, { x: 190, y: 115 }] }],
    targets: [cardImage],
  })
  assert.equal(plan.type, 'replace-image')
  assert.equal(plan.needsInput, true)
})

test('a circle around text identifies the target but does not imply deletion', () => {
  const plan = interpretGroup({
    strokes: [{ shape: 'circle', points: [{ x: 20, y: 20 }, { x: 220, y: 20 }, { x: 220, y: 150 }, { x: 20, y: 150 }, { x: 20, y: 20 }] }],
    targets: [cardText],
  })
  assert.equal(plan.type, 'note')
  assert.equal(plan.parameters.hasRegion, true)
  assert.equal(plan.parameters.hasCross, false)
  assert.match(plan.goal, /已标记/)
  assert.doesNotMatch(plan.goal, /删除|移除/)
})

test('a closed lasso with noisy crossing does not become deletion', () => {
  const plan = interpretGroup({
    strokes: [{
      points: [
        { x: 10, y: 40 }, { x: 80, y: 8 }, { x: 180, y: 20 },
        { x: 230, y: 90 }, { x: 190, y: 155 }, { x: 85, y: 170 },
        { x: 18, y: 115 }, { x: 10, y: 40 }, { x: 28, y: 60 },
        { x: 210, y: 125 }, { x: 10, y: 40 },
      ],
    }],
    targets: [cardText],
  })
  assert.equal(plan.type, 'note')
  assert.equal(plan.parameters.hasRegion, true)
  assert.equal(plan.parameters.hasCross, false)
})

test('an empty region is an insertion request, not an annotation-only result', () => {
  const plan = interpretGroup({
    strokes: [{ shape: 'box', points: [{ x: 280, y: 20 }, { x: 420, y: 20 }, { x: 420, y: 110 }, { x: 280, y: 110 }, { x: 280, y: 20 }] }],
    targets: [],
  })
  assert.equal(plan.type, 'insert')
  assert.equal(plan.needsInput, true)
})

test('a wide region mark is not a deletion line', () => {
  const plan = interpretGroup({
    strokes: [{ shape: 'circle', points: [{ x: 10, y: 10 }, { x: 500, y: 10 }, { x: 520, y: 90 }, { x: 10, y: 90 }, { x: 10, y: 10 }] }],
    targets: [cardText],
  })
  assert.equal(plan.type, 'note')
  assert.equal(plan.parameters.hasCross, false)
  assert.equal(plan.parameters.textStrike, false)
})

test('a plain region never exposes removal as a fallback action', () => {
  const plan = interpretGroup({
    strokes: [{ shape: 'circle', points: [{ x: 20, y: 20 }, { x: 220, y: 20 }, { x: 220, y: 150 }, { x: 20, y: 150 }, { x: 20, y: 20 }] }],
    targets: [cardText],
  })
  assert.equal(plan.type, 'note')
  assert.ok(plan.suggestion.alternatives.every((item) => !/移除|删除|去掉|删掉/u.test(item)))
})
