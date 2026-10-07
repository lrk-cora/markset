import test from 'node:test'
import assert from 'node:assert/strict'
import { BRUSH_SETTINGS_KEY, DEFAULT_BRUSH_SETTINGS, createBrushSettings, normalizeBrushSettings } from '../src/brush-settings.js'

const storage = () => {
  const values = new Map()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}
test('settings have the agreed defaults and survive reload without storing page content or history', () => {
  const data = storage(), first = createBrushSettings(data)
  assert.deepEqual(first.get(), DEFAULT_BRUSH_SETTINGS)
  first.update({ width: 8, color: '#D94C3D', opacity: 0.45, analysisDelayMs: 2300, smoothing: 'strong', autoAnalyze: false })
  assert.deepEqual(createBrushSettings(data).get(), first.get())
  assert.deepEqual(Object.keys(JSON.parse(data.getItem(BRUSH_SETTINGS_KEY))), ['version', 'settings'])
  assert.equal(first.isSaved(), true)
})
test('invalid values are bounded, normalized or replaced, never executable CSS', () => {
  assert.deepEqual(normalizeBrushSettings({ width: 100, color: 'url(javascript:alert(1))', opacity: -3, analysisDelayMs: 1, smoothing: 'anything', autoAnalyze: 'false' }), {
    ...DEFAULT_BRUSH_SETTINGS, width: 24, analysisDelayMs: 500,
  })
  assert.deepEqual(normalizeBrushSettings({ width: NaN, opacity: Infinity, analysisDelayMs: null }), DEFAULT_BRUSH_SETTINGS)
  assert.equal(normalizeBrushSettings({ analysisDelayMs: 6000 }).analysisDelayMs, 3000)
})

test('24px width survives reload and removed opacity settings cannot leave hidden legacy values', () => {
  const data = storage()
  data.setItem(BRUSH_SETTINGS_KEY, JSON.stringify({ version: 1, settings: { width: 24, opacity: 0.25 } }))
  const settings = createBrushSettings(data)
  assert.equal(settings.get().width, 24)
  assert.equal(settings.get().opacity, DEFAULT_BRUSH_SETTINGS.opacity)
  settings.update({ opacity: 0.4 })
  assert.equal(settings.get().opacity, DEFAULT_BRUSH_SETTINGS.opacity)
})
test('corrupt storage and future versions fall back safely', () => {
  const data = storage()
  data.setItem(BRUSH_SETTINGS_KEY, '{broken')
  assert.deepEqual(createBrushSettings(data).get(), DEFAULT_BRUSH_SETTINGS)
  data.setItem(BRUSH_SETTINGS_KEY, JSON.stringify({ version: 999, settings: { width: 12 } }))
  assert.deepEqual(createBrushSettings(data).get(), DEFAULT_BRUSH_SETTINGS)
})
test('storage failure does not break drawing settings and is explicitly reported', () => {
  const settings = createBrushSettings({ getItem: () => null, setItem: () => { throw Error('quota') } })
  settings.update({ width: 7 })
  assert.equal(settings.get().width, 7)
  assert.equal(settings.isSaved(), false)
})
test('reset restores all parameters; subscriptions and returned snapshots cannot mutate the store', () => {
  const settings = createBrushSettings(storage())
  let events = 0
  const unsub = settings.subscribe((current, before) => { events++; assert.equal(before.width, 4.5); current.width = 12 })
  settings.update({ width: 6 })
  assert.equal(settings.get().width, 6)
  unsub()
  const copy = settings.get(); copy.width = 10
  settings.reset()
  assert.deepEqual(settings.get(), DEFAULT_BRUSH_SETTINGS)
  assert.equal(events, 1)
})
