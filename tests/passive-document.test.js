import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { stripExecutableMarkup } from '../src/passive-document.js'

function parse(html) { return new JSDOM(html).window.document }
test('removes runnable HTML/SVG scripts, nested frames and refresh before mounting', () => {
  const doc = parse('<h1>保留标题</h1><script src="/app.js"></script><svg><script>test()</script><path d="M0 0h10"/></svg><iframe srcdoc="test"></iframe><object data="/page.html"></object><embed src="/plugin"><meta http-equiv=" Refresh " content="0;url=/new"><link rel="modulepreload" href="/app.js">')
  const report = stripExecutableMarkup(doc)
  assert.equal(doc.querySelectorAll('script, iframe, object, embed, meta, link').length, 0)
  assert.equal(doc.querySelector('h1').textContent, '保留标题')
  assert.ok(doc.querySelector('svg path'))
  assert.equal(report.elements, 7)
})

test('strips entity/control-whitespace URLs and handlers but retains styles, images and safe links', () => {
  const doc = parse('<body onload="test()"><h1 style="color:red" data-markset-id="heading">标题</h1><img src="data:image/png;base64,AAAA" onerror="test()"><a id="script" href="java&#x73;cript:test()">动作</a><a id="control" href="java&#10;script:test()">动作</a><a id="link" href="https://example.com/">安全链接</a><a id="anchor" href="#heading">定位</a><button formaction="javascript:test()" onclick="test()">按钮</button>')
  stripExecutableMarkup(doc)
  assert.equal(doc.body.hasAttribute('onload'), false)
  assert.equal(doc.getElementById('script').hasAttribute('href'), false)
  assert.equal(doc.getElementById('control').hasAttribute('href'), false)
  assert.equal(doc.querySelector('img').hasAttribute('onerror'), false)
  assert.equal(doc.querySelector('img').getAttribute('src'), 'data:image/png;base64,AAAA')
  assert.equal(doc.querySelector('h1').style.color, 'red')
  assert.equal(doc.getElementById('link').getAttribute('href'), 'https://example.com/')
  assert.equal(doc.getElementById('anchor').getAttribute('href'), '#heading')
  assert.equal(doc.querySelector('button').hasAttribute('formaction'), false)
})

test('cleans template content and is idempotent on a restored document', () => {
  const doc = parse('<template><template><script>test()</script><span onclick="test()">内容</span></template></template>')
  stripExecutableMarkup(doc)
  const inner = doc.querySelector('template').content.querySelector('template').content
  assert.equal(inner.querySelector('script'), null)
  assert.equal(inner.querySelector('span').hasAttribute('onclick'), false)
  assert.equal(inner.querySelector('span').textContent, '内容')
  assert.deepEqual(stripExecutableMarkup(doc), { elements: 0, attributes: 0 })
})
