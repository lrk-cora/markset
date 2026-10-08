import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateCorrections } from '../scripts/evaluate-corrections.mjs'
test('controlled injected-plan evaluation: fourteen contracts, live DOM mutations and full undo, no paid calls', async () => {
  const report = await evaluateCorrections()
  assert.equal(report.cases, 14); assert.equal(report.passed, 14)
  assert.equal(report.allowed, 5); assert.equal(report.blocked, 9)
  assert.equal(report.paidCalls, 0); assert.equal(report.modelCalls, 0); assert.equal(report.participantCount, 0)
})
