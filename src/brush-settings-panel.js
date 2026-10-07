import { brushSettingsSaved, getBrushSettings, resetBrushSettings, setBrushSettings, subscribeBrushSettings } from './brush-settings.js'
import { displayStrokePoints } from './stroke-render.js'

export function initBrushSettingsPanel(root = document) {
  const control = (id) => root.getElementById(id)
  const fields = { width: control('brush-width'), color: control('brush-color'),
    analysisDelayMs: control('brush-analysis-delay'), smoothing: control('brush-smoothing'), autoAnalyze: control('brush-auto-analyze') }
  const preview = [{ x: 10, y: 38 }, { x: 35, y: 18 }, { x: 65, y: 22 }, { x: 96, y: 41 }, { x: 125, y: 25 }, { x: 155, y: 18 }, { x: 185, y: 36 }]
  const render = () => {
    const settings = getBrushSettings()
    for (const [key, input] of Object.entries(fields)) {
      if (key === 'autoAnalyze') input.checked = settings[key]
      else input.value = settings[key]
    }
    control('brush-width-value').textContent = `${settings.width} px`
    control('brush-color-value').textContent = settings.color.toUpperCase()
    control('brush-analysis-delay-value').textContent = `${(settings.analysisDelayMs / 1000).toFixed(1)} 秒`
    fields.analysisDelayMs.disabled = !settings.autoAnalyze
    const line = control('brush-preview-line')
    line.setAttribute('points', displayStrokePoints(preview, settings.smoothing).map((p) => `${p.x},${p.y}`).join(' '))
    line.setAttribute('stroke', settings.color)
    line.setAttribute('stroke-width', settings.width)
    line.setAttribute('opacity', settings.opacity)
    const dot = control('brush-preview-dot')
    dot.setAttribute('r', settings.width / 2)
    dot.setAttribute('fill', settings.color)
    dot.setAttribute('opacity', settings.opacity)
    control('brush-settings-storage-status').textContent = brushSettingsSaved() ? '设置自动保存在当前浏览器' : '本次设置有效，但浏览器未能保存'
    root.querySelectorAll('[data-brush-color]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.brushColor === settings.color)))
  }
  for (const [key, input] of Object.entries(fields)) input.addEventListener(['smoothing', 'autoAnalyze'].includes(key) ? 'change' : 'input', () => {
    setBrushSettings({ [key]: key === 'autoAnalyze' ? input.checked : input.value })
  })
  root.querySelectorAll('[data-brush-color]').forEach((button) => button.addEventListener('click', () => setBrushSettings({ color: button.dataset.brushColor })))
  control('btn-reset-brush-settings').addEventListener('click', resetBrushSettings)
  const unsubscribe = subscribeBrushSettings(render)
  render()
  return { render, destroy: unsubscribe }
}
