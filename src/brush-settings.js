export const BRUSH_SETTINGS_KEY = 'markset-brush-settings-v1'
export const DEFAULT_BRUSH_SETTINGS = Object.freeze({
  width: 4.5, color: '#3c6fd4', opacity: 0.8,
  analysisDelayMs: 1200, smoothing: 'light', autoAnalyze: true,
})

const bounded = (value, min, max, fallback, step) => {
  const number = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(number) ? Math.round(Math.max(min, Math.min(max, number)) / step) * step : fallback
}
export function normalizeBrushSettings(value = {}) {
  const input = value && typeof value === 'object' ? value : {}
  return {
    width: bounded(input.width, 2, 24, 4.5, 0.5),
    color: /^#[\da-f]{6}$/i.test(input.color || '') ? input.color.toLowerCase() : DEFAULT_BRUSH_SETTINGS.color,
    // Opacity is no longer a user setting. Ignore previously saved values.
    opacity: DEFAULT_BRUSH_SETTINGS.opacity,
    analysisDelayMs: bounded(input.analysisDelayMs, 500, 3000, 1200, 100),
    smoothing: ['none', 'light', 'strong'].includes(input.smoothing) ? input.smoothing : 'light',
    autoAnalyze: typeof input.autoAnalyze === 'boolean' ? input.autoAnalyze : true,
  }
}

export function createBrushSettings(storage) {
  let settings = { ...DEFAULT_BRUSH_SETTINGS }, saved = Boolean(storage)
  const listeners = new Set()
  try {
    const data = JSON.parse(storage?.getItem(BRUSH_SETTINGS_KEY) || 'null')
    if (data?.version === 1) settings = normalizeBrushSettings(data.settings)
  } catch { saved = false }
  const get = () => ({ ...settings })
  const update = (patch) => {
    const before = get()
    settings = normalizeBrushSettings({ ...settings, ...patch })
    try {
      if (!storage) throw new Error('storage-unavailable')
      storage.setItem(BRUSH_SETTINGS_KEY, JSON.stringify({ version: 1, settings }))
      saved = true
    } catch { saved = false }
    for (const listener of listeners) listener(get(), before)
    return get()
  }
  return { get, update, reset: () => update(DEFAULT_BRUSH_SETTINGS), isSaved: () => saved,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
}

let storage
try { storage = globalThis.localStorage } catch {}
const settings = createBrushSettings(storage)
export const getBrushSettings = settings.get
export const setBrushSettings = settings.update
export const resetBrushSettings = settings.reset
export const subscribeBrushSettings = settings.subscribe
export const brushSettingsSaved = settings.isSaved
