import test from 'node:test'
import assert from 'node:assert/strict'
import { createResearchLog } from '../src/research-log.js'
const fixture = () => {
  const items = new Map()
  const storage = { getItem: key => items.get(key), setItem: (key, value) => items.set(key, value) }
  return { storage, log: createResearchLog({ storage, now: () => 100, sessionId: () => 'anonymous-session' }) }
}
test('research logging is off by default and requires explicit consent', () => {
  const { log } = fixture()
  assert.equal(log.record('input'), false)
  for (const args of [{}, { consent: false }, { consent: true, condition: 'invalid' }, { consent: true, trial: '真实姓名' }]) assert.equal(log.start(args).ok, false)
  assert.equal(log.start({ consent: true }).ok, true)
  assert.equal(log.record('input', { strokeCount: 2 }), true)
  log.stop(); assert.equal(log.record('apply'), false)
})
test('persistent events whitelist metadata, not raw evidence/provider prose; reload never resumes consent', () => {
  const { log, storage } = fixture(); log.start({ consent: true })
  log.record('analysis-end', { model: 'qwen3.8-flash', elapsedMs: 1000, text: 'private page', prompt: 'private input', apiKey: 'secret', reason: 'secret key = sensitive', imageDataUrl: 'data:image', strokes: [{}] })
  const json = JSON.stringify(log.snapshot())
  for (const word of ['private', 'secret', 'sensitive', 'imageDataUrl', 'strokes']) assert.equal(json.includes(word), false)
  const restored = createResearchLog({ storage }); assert.equal(restored.snapshot().events.length, 2); assert.equal(restored.snapshot().active, false)
  log.clear(); assert.equal(createResearchLog({ storage }).snapshot().events.length, 0)
})
test('storage failure is visible and does not lose the in-memory events', () => {
  const log = createResearchLog({ storage: { getItem: () => null, setItem: () => { throw Error('quota') } }, sessionId: () => 's' })
  log.start({ consent: true }); log.record('correction', { role: 'preserve' })
  assert.equal(log.snapshot().events.length, 2); assert.match(log.snapshot().error, /存储失败/u)
})
