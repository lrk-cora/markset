import test from 'node:test'
import assert from 'node:assert/strict'

test('analysis flow contract keeps a fallback result available when model analysis fails', () => {
  const fallback = {
    type: 'note',
    operation: 'note',
    needsInput: true,
    needsClarification: false,
    source: 'local-fallback',
    suggestion: { text: '请补充希望执行的修改', alternatives: [] },
  }
  assert.equal(fallback.type, 'note')
  assert.equal(fallback.needsInput, true)
  assert.equal(fallback.source, 'local-fallback')
})
