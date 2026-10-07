import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

test('proposal action hidden state wins over button styles; visible Cancel is not suppressed as a secondary button',()=>{
  const css=readFileSync(new URL('../src/styles.css',import.meta.url),'utf8')
  const dom=new JSDOM(`<style>${css}</style><div class="inline-proposal-actions"><button id="btn-analyze-strokes" class="button button-secondary">取消分析</button><button class="button button-primary" hidden>开始分析</button></div>`)
  try {
    const buttons=dom.window.document.querySelectorAll('button')
    assert.equal(dom.window.getComputedStyle(buttons[0]).display,'inline-flex')
    assert.equal(dom.window.getComputedStyle(buttons[1]).display,'none')
  }finally{dom.window.close()}
})

test('interactive proposal container is not hidden from the accessibility tree', () => {
  const container = html.match(/<div\b[^>]*\bid="chrome-layer"[^>]*>/u)?.[0]
  assert.ok(container)
  assert.doesNotMatch(container, /aria-hidden="true"|\binert\b/u)
  // Only decorative drawing layers are hidden; the proposal uses native hidden
  // while absent, and becomes accessible together with its buttons/inputs.
  assert.match(html, /<section\b[^>]*id="inline-proposal"[^>]*\bhidden\b/u)
})

test('imported HTML remains script-sandboxed; console warnings must not weaken isolation', () => {
  const sandbox = html.match(/<iframe\b[^>]*id="web-doc-frame"[^>]*sandbox="([^"]*)"/u)?.[1]
  assert.equal(sandbox, 'allow-same-origin')
})

test('target deselection controls live outside the decorative aria-hidden ghost layer', () => {
  const controls = html.match(/<div\b[^>]*id="target-controls-layer"[^>]*>/u)?.[0]
  assert.ok(controls)
  assert.doesNotMatch(controls, /aria-hidden="true"|\binert\b/u)
  assert.match(html, /id="ghost-layer"[^>]*><\/div>\s*<div id="target-controls-layer"/u)
})
