import test from 'node:test'
import assert from 'node:assert/strict'
import { analysisRecoveryIntent, runAnalysisTask } from '../src/analysis-task.js'

test('deadline releases a hung capture even if it ignores AbortSignal', async () => {
  let signal
  const task = runAnalysisTask((received) => { signal = received; return new Promise(() => {}) }, { timeoutMs: 5 })
  await assert.rejects(task, { name: 'TimeoutError' })
  assert.equal(signal.aborted, true)
})

test('parent cancellation releases work immediately and does not become a timeout', async () => {
  const controller = new AbortController()
  const task = runAnalysisTask(() => new Promise(() => {}), { signal: controller.signal, timeoutMs: 10_000 })
  controller.abort()
  await assert.rejects(task, { name: 'AbortError' })
})

test('completed work returns normally; thrown failures also terminate', async () => {
  assert.equal(await runAnalysisTask(async () => 'ready'), 'ready')
  await assert.rejects(runAnalysisTask(() => { throw new RangeError('classifier failed') }), { name: 'RangeError' })
})

test('a late capture cannot advance to a model request after timeout', async () => {
  let release
  let modelCalls = 0
  const task = runAnalysisTask(async (signal) => {
    await new Promise((resolve) => { release = resolve })
    signal.throwIfAborted()
    modelCalls++
  }, { timeoutMs: 5 })
  await assert.rejects(task, { name: 'TimeoutError' })
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(modelCalls, 0)
})

test('recovery is a generic edit prompt, not an invented replacement-title request', () => {
  const plan = analysisRecoveryIntent({ targets: [{ webId: 't', kind: 'text' }] })
  assert.equal(plan.type, 'note')
  assert.equal(plan.needsInput, false)
  assert.equal(plan.needsClarification, false)
  assert.deepEqual(plan.suggestion.alternatives, ['修改颜色', '替换文字内容'])
})
