import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { getBrushSettings, resetBrushSettings } from '../src/brush-settings.js'
import { initBrushSettingsPanel } from '../src/brush-settings-panel.js'

test('real settings controls update outputs, preview, advanced options and reset', () => {
  const dom = new JSDOM(readFileSync(new URL('../index.html', import.meta.url), 'utf8'))
  const root = dom.window.document
  resetBrushSettings()
  const panel = initBrushSettingsPanel(root)
  const change = (id, value, type = 'input') => {
    const input = root.getElementById(id)
    if (typeof value === 'boolean') input.checked = value; else input.value = value
    input.dispatchEvent(new dom.window.Event(type))
  }
  try {
    assert.equal(root.getElementById('brush-opacity'), null)
    assert.ok(root.getElementById('brush-analysis-delay').closest('.brush-advanced'))
    assert.equal(root.getElementById('brush-width').max, '24')
    change('brush-width', 24)
    root.querySelector('[data-brush-color="#d94c3d"]').click()
    assert.equal(root.getElementById('brush-width-value').textContent, '24 px')
    assert.equal(root.getElementById('brush-preview-line').getAttribute('stroke-width'), '24')
    assert.equal(root.getElementById('brush-preview-line').getAttribute('stroke'), '#d94c3d')
    assert.equal(root.getElementById('brush-preview-dot').getAttribute('r'), '12')
    assert.equal(root.querySelector('[data-brush-color="#d94c3d"]').getAttribute('aria-pressed'), 'true')
    change('brush-auto-analyze', false, 'change')
    assert.equal(root.getElementById('brush-analysis-delay').disabled, true)
    change('brush-smoothing', 'strong', 'change')
    assert.equal(getBrushSettings().smoothing, 'strong')
    root.getElementById('btn-reset-brush-settings').click()
    assert.equal(root.getElementById('brush-width-value').textContent, '4.5 px')
    assert.equal(root.getElementById('brush-analysis-delay').disabled, false)
    assert.equal(root.getElementById('brush-auto-analyze').checked, true)
    assert.equal(root.getElementById('brush-smoothing').value, 'light')
  } finally { panel.destroy(); dom.window.close(); resetBrushSettings() }
})
