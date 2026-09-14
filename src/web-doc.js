import { isClientModelGateOn, rewriteText } from './api.js'
import { colorFill } from './colors.js'
import { rectIntersectsPolygon } from './geometry.js'
import { collectLayoutPairs } from './layout.js'
import { inferCommandText, localNextText, parseCommand } from './plan-local.js'
import { getSnapshot, ping, targets } from './store.js'

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'BR', 'HR', 'HEAD', 'HTML'])
const SKIN_ID = 'markset-skin'
const MAX_HITS = 12

let meta = { title: '', sourceUrl: '' }
let viewportBound = false

const SKIN = `
html, body { margin: 0; width: 100%; min-width: 100%; max-width: none; }
img, video { max-width: 100%; height: auto; }
[data-markset-anno="underline"] { text-decoration: underline 2px; text-underline-offset: 3px; }
[data-markset-anno="wavy"] { text-decoration: underline wavy 2px #3c6fd4; text-underline-offset: 3px; }
[data-markset-anno="strike"],
[data-markset-anno="line-strike"] { text-decoration: line-through 2px; }
[data-markset-anno="highlight"] { background: rgba(255, 226, 80, 0.55); }
[data-markset-anno="bold"] { font-weight: 700; }
[data-markset-anno="box"] { outline: 2px solid #3c6fd4; outline-offset: 3px; }
[data-markset-anno="circle"] { outline: 2px solid #3c6fd4; border-radius: 999px; outline-offset: 4px; }
[data-markset-anno="frame"] { outline: 2px solid #3c6fd4; outline-offset: 4px; }
[data-markset-shifted] { position: relative; z-index: 3; }
`

function esc(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function hostEl() {
  return document.getElementById('web-doc-host')
}

function frameEl() {
  return document.getElementById('web-doc-frame')
}

export function isWebDocActive() {
  return Boolean(document.querySelector('.page.is-web-doc') && frameEl()?.contentDocument?.body)
}

export function getWebMeta() {
  return { ...meta }
}

function getDoc() {
  return frameEl()?.contentDocument || null
}

function stampIds(doc) {
  let n = 0
  doc.body?.querySelectorAll('*').forEach((el) => {
    const cur = Number(el.getAttribute('data-markset-id') || 0)
    if (cur > n) n = cur
  })
  doc.body?.querySelectorAll('*').forEach((el) => {
    if (!el.getAttribute('data-markset-id')) {
      n += 1
      el.setAttribute('data-markset-id', String(n))
    }
  })
}

function injectSkin(doc) {
  if (!doc?.head) return
  let skin = doc.getElementById(SKIN_ID)
  if (!skin) {
    skin = doc.createElement('style')
    skin.id = SKIN_ID
    doc.head.append(skin)
  }
  skin.textContent = SKIN
}

function fitHeight() {
  const iframe = frameEl()
  const doc = getDoc()
  if (!iframe || !doc) return
  const root = doc.documentElement
  if (root) root.style.zoom = ''
  const sw = Math.max(root?.scrollWidth || 0, doc.body?.scrollWidth || 0)
  const cw = iframe.clientWidth || 0
  if (root && cw > 0 && sw > cw + 8) root.style.zoom = String(cw / sw)
  const h = Math.max(root?.scrollHeight || 0, doc.body?.scrollHeight || 0, 240)
  iframe.style.height = `${h}px`
}

function prepareDoc(doc) {
  if (!doc) return
  injectSkin(doc)
  stampIds(doc)
  doc.querySelectorAll('a[href]').forEach((a) => {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener')
  })
  fitHeight()
  requestAnimationFrame(fitHeight)
  doc.body?.querySelectorAll('img').forEach((img) => {
    if (!img.complete) img.addEventListener('load', fitHeight, { once: true })
  })
}

function bindViewport() {
  if (viewportBound) return
  viewportBound = true
  const onMove = () => {
    if (!isWebDocActive()) return
    ping()
  }
  document.querySelector('.stage')?.addEventListener('scroll', onMove, { passive: true })
  window.addEventListener('resize', () => {
    if (!isWebDocActive()) return
    fitHeight()
    ping()
  })
}

function setHtml(html) {
  const iframe = frameEl()
  const doc = iframe?.contentDocument
  if (!iframe || !doc) return false
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  if (!parsed.documentElement) return false
  doc.replaceChild(doc.importNode(parsed.documentElement, true), doc.documentElement)
  prepareDoc(doc)
  return true
}

export function snapshotWebHtml() {
  const doc = getDoc()
  if (!doc?.documentElement) return ''
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
}

export function restoreWebHtml(html) {
  if (!html || !frameEl()) return false
  return setHtml(html)
}

export function blocksToHtml(page) {
  const title = esc(page?.title || '导入的网页')
  const parts = [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    `<title>${title}</title>`,
    '<style>body{font-family:system-ui,sans-serif;margin:28px 32px;max-width:680px;line-height:1.6;color:#222}h1{font-size:1.6rem}img{max-width:100%;height:auto}</style>',
    '</head><body>',
  ]
  for (const block of page?.blocks || []) {
    if (block.type === 'heading' && block.text) parts.push(`<h1>${esc(block.text)}</h1>`)
    else if (block.type === 'image' && block.src) {
      parts.push(`<p><img src="${esc(block.src)}" alt="${esc(block.alt || '')}"></p>`)
    } else if (block.text) parts.push(`<p>${esc(block.text)}</p>`)
  }
  if (parts.length <= 4) parts.push('<p>这个网页没有读出可用内容。</p>')
  parts.push('</body></html>')
  return parts.join('')
}

export function screenshotToHtml(src, title) {
  const name = esc(title || '导入的网页')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name}</title>
<style>body{margin:0;background:#fff}img{display:block;width:100%;height:auto}</style>
</head><body><img src="${esc(src)}" alt="${name}"></body></html>`
}

export function mountWebDoc(html, nextMeta = {}) {
  const page = document.querySelector('.page')
  const host = hostEl()
  const iframe = frameEl()
  const editor = document.getElementById('editor')
  if (!page || !host || !iframe) return false
  meta = {
    title: nextMeta.title || '导入的网页',
    sourceUrl: nextMeta.sourceUrl || '',
  }
  page.classList.add('is-import', 'is-web-doc')
  host.hidden = false
  if (editor) editor.setAttribute('aria-hidden', 'true')
  iframe.setAttribute('title', meta.title)
  const ok = setHtml(html)
  bindViewport()
  return ok
}

export function unmountWebDoc() {
  const page = document.querySelector('.page')
  const host = hostEl()
  const iframe = frameEl()
  const editor = document.getElementById('editor')
  page?.classList.remove('is-web-doc', 'is-import')
  if (host) host.hidden = true
  if (iframe) {
    iframe.style.height = ''
    try {
      const doc = iframe.contentDocument
      if (doc?.documentElement) doc.documentElement.innerHTML = '<head></head><body></body>'
    } catch {
      iframe.src = 'about:blank'
    }
  }
  if (editor) editor.removeAttribute('aria-hidden')
  meta = { title: '', sourceUrl: '' }
}

function findByWebId(id) {
  if (id == null || id === '') return null
  const doc = getDoc()
  if (!doc) return null
  return doc.querySelector(`[data-markset-id="${CSS.escape(String(id))}"]`)
}

function iframeBox() {
  return frameEl()?.getBoundingClientRect() || null
}

export function liveScreenRect(span) {
  if (span?.webId) {
    const el = findByWebId(span.webId)
    const r = el?.getBoundingClientRect()
    const frame = iframeBox()
    if (r && frame) {
      return { x: frame.left + r.left, y: frame.top + r.top, w: r.width, h: r.height }
    }
  }
  return span?.screenRect || span?.imageRect || null
}

function toViewport(r) {
  const frame = iframeBox()
  if (!frame || !r) return null
  return { x: frame.left + r.left, y: frame.top + r.top, w: r.width, h: r.height }
}

function toIframePoly(polygon) {
  const frame = iframeBox()
  if (!frame) return polygon
  return (polygon || []).map((p) => ({ x: p.x - frame.left, y: p.y - frame.top }))
}

function toIframeRect(rect) {
  const frame = iframeBox()
  if (!frame || !rect) return null
  return {
    x: rect.x - frame.left,
    y: rect.y - frame.top,
    w: rect.w,
    h: rect.h,
  }
}

function textOf(el) {
  return String(el?.innerText || el?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isImageEl(el) {
  return el?.tagName === 'IMG' && (el.naturalWidth || el.width || el.getBoundingClientRect().width)
}

function isTextEl(el) {
  if (!el || SKIP.has(el.tagName) || isImageEl(el)) return false
  return textOf(el).length > 0
}

function spanFromEl(el, kind) {
  const r = el.getBoundingClientRect()
  const screen = toViewport(r)
  const id = el.getAttribute('data-markset-id') || ''
  if (kind === 'image') {
    const nw = el.naturalWidth || Math.round(r.width)
    const nh = el.naturalHeight || Math.round(r.height)
    return {
      kind: 'image',
      webId: id,
      block_id: `web-img-${id}`,
      screenRect: screen,
      imageRect: screen,
      bbox: { x: 0, y: 0, w: nw, h: nh },
      naturalSize: { w: nw, h: nh },
      mode: 'object',
      why: 'web-doc',
    }
  }
  const text = textOf(el).slice(0, 240)
  return {
    kind: 'text',
    webId: id,
    block_id: `web-${id}`,
    text,
    start: 0,
    end: text.length,
    screenRect: screen,
    why: 'web-doc',
  }
}

export function hitWebDoc(polygon) {
  const empty = { texts: { found: [], suggest: [] }, images: { found: [], suggest: [] } }
  const doc = getDoc()
  const iframe = frameEl()
  if (!doc?.body || !iframe) return empty
  const poly = toIframePoly(polygon)
  const frameArea = Math.max(1, iframe.clientWidth * iframe.clientHeight)
  const hits = []
  for (const el of doc.body.querySelectorAll('*')) {
    if (SKIP.has(el.tagName)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) continue
    if (r.width * r.height > frameArea * 0.82) continue
    if (!rectIntersectsPolygon(r, poly)) continue
    hits.push({ el, r, area: r.width * r.height })
  }
  const leaves = hits.filter((h) => !hits.some((o) => o.el !== h.el && h.el.contains(o.el)))
  leaves.sort((a, b) => a.area - b.area)
  const images = []
  const texts = []
  for (const hit of leaves) {
    if (isImageEl(hit.el)) images.push(spanFromEl(hit.el, 'image'))
    else if (isTextEl(hit.el)) texts.push(spanFromEl(hit.el, 'text'))
  }
  return {
    texts: { found: texts.slice(0, MAX_HITS), suggest: texts.slice(MAX_HITS, MAX_HITS + 4) },
    images: { found: images.slice(0, 6), suggest: images.slice(6, 8) },
  }
}

function selectedWebEls(kind) {
  return getSnapshot()
    .spans.filter((s) => s.webId && s.willEdit !== false && (!kind || s.kind === kind))
    .map((s) => ({ span: s, el: findByWebId(s.webId) }))
    .filter((x) => x.el)
}

function annoKind(id) {
  if (id === 'box' || id === 'frame') return 'box'
  if (id === 'circle') return 'circle'
  if (id === 'line-strike' || id === 'line-strike-h' || id === 'line-strike-v') return 'strike'
  return id
}

export function applyWebAnno(id) {
  if (id === 'clear-anno') return clearWebAnno()
  const kind = annoKind(id)
  const items = selectedWebEls()
  if (!items.length) return false
  for (const { el } of items) el.setAttribute('data-markset-anno', kind)
  return true
}

export function applyWebAnnoAll(id) {
  const doc = getDoc()
  if (!doc?.body) return false
  if (id === 'clear-anno') {
    doc.body.querySelectorAll('[data-markset-anno]').forEach((el) => el.removeAttribute('data-markset-anno'))
    return true
  }
  const kind = annoKind(id)
  const nodes = [...doc.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, th, a, span, figcaption')]
    .filter((el) => isTextEl(el) && ![...el.querySelectorAll('p, h1, li')].length)
  const targets = nodes.length ? nodes : selectedWebEls().map((x) => x.el)
  for (const el of targets) el.setAttribute('data-markset-anno', kind)
  return targets.length > 0
}

export function clearWebAnno() {
  const items = selectedWebEls()
  if (!items.length) {
    const doc = getDoc()
    const all = doc?.body?.querySelectorAll('[data-markset-anno]')
    if (!all?.length) return false
    all.forEach((el) => el.removeAttribute('data-markset-anno'))
    return true
  }
  for (const { el } of items) el.removeAttribute('data-markset-anno')
  return true
}

export function applyWebShadow() {
  const img = selectedWebEls('image')[0]?.el || selectedWebEls()[0]?.el
  if (!img) return false
  const css = 'drop-shadow(6px 10px 8px rgba(36, 24, 14, 0.45))'
  if (img.dataset.marksetShadow === '1' && img.style.filter === css) {
    img.style.filter = ''
    delete img.dataset.marksetShadow
    return true
  }
  img.style.filter = css
  img.dataset.marksetShadow = '1'
  return true
}

export function applyWebIndent({ all = false } = {}) {
  const doc = getDoc()
  if (!doc) return false
  let els = selectedWebEls('text').map((x) => x.el)
  if (!els.length) {
    const marks = getSnapshot().spans.filter((s) => s.indentMark && s.webId)
    els = marks.map((s) => findByWebId(s.webId)).filter(Boolean)
  }
  if (all) {
    els = [...doc.body.querySelectorAll('p, h1, h2, h3, li')].filter((el) => textOf(el))
  }
  if (!els.length) return false
  for (const el of els) {
    const cur = parseFloat(el.style.paddingLeft || getComputedStyle(el).paddingLeft) || 0
    if (cur >= 24) continue
    el.style.paddingLeft = '2em'
  }
  return true
}

export function applyWebLayoutMoves() {
  const pairs = collectLayoutPairs()
  let n = 0
  for (const pair of pairs) {
    const el = findByWebId(pair.webId)
    const dest = toIframeRect(pair.dest)
    if (!el || !dest) continue
    const src = el.getBoundingClientRect()
    const dx = Math.round(dest.x - src.left)
    const dy = Math.round(dest.y - src.top)
    el.style.transform = `translate(${dx}px, ${dy}px)`
    el.setAttribute('data-markset-shifted', '1')
    n += 1
  }
  return n
}

function replaceText(el, fromText, toText) {
  if (!el) return
  const next = String(toText || '')
  const from = String(fromText || '')
  if (from && from.length >= 2) {
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    let did = false
    for (const node of nodes) {
      if (node.nodeValue.includes(from)) {
        node.nodeValue = node.nodeValue.split(from).join(next)
        did = true
      }
    }
    if (did) return
  }
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const first = walker.nextNode()
  if (first && !walker.nextNode()) first.nodeValue = next
  else el.textContent = next
}

function applyColor(el, name, kind) {
  const fill = colorFill(name) || name
  if (!fill) return
  if (kind === 'image') {
    el.style.filter = `drop-shadow(0 0 0 ${fill})`
    return
  }
  el.style.color = fill
}

export async function runWebWriteback(kind, notify, { onBefore } = {}) {
  const picked = targets().filter((s) => s.kind !== 'slot' && s.willEdit !== false)
  const web = picked.filter((s) => s.webId)
  if (!web.length) {
    notify('先圈网页上要改的字或图')
    return false
  }
  const snap = getSnapshot()
  const scope = snap.scope || 'inside'
  const commandText = inferCommandText(snap.commandText, web.filter((s) => s.kind === 'text'))
  const parsed = parseCommand(commandText)
  if ((kind === 'rewrite' || kind === 'unify' || kind === 'replace') && !commandText && !parsed.color) {
    notify('先写下新名字或选出颜色')
    return false
  }
  if (kind === 'delete') {
    const ok = window.confirm('会从导入的网页里去掉圈中的字或图。确定？')
    if (!ok) return false
  }

  const items = web.map((s) => ({ span: s, el: findByWebId(s.webId) })).filter((x) => x.el)
  const useModel = isClientModelGateOn() && (kind === 'rewrite' || kind === 'unify') && items.some((x) => x.span.kind === 'text')
  if (useModel) {
    const ok = window.confirm(`将调用云端改写 ${items.filter((x) => x.span.kind === 'text').length} 处文字，会消耗额度。确定？`)
    if (!ok) return false
  }

  onBefore?.(kind === 'delete' ? '删网页内容' : '改网页')

  let count = 0
  const rewritten = new Set()
  for (const { span, el } of items) {
    if (kind === 'delete') {
      el.remove()
      count += 1
      continue
    }
    if (parsed.color && (span.kind === 'text' || span.kind === 'image')) {
      applyColor(el, parsed.color, span.kind)
      count += 1
    }
    if (span.kind !== 'text') continue
    let next = localNextText(span, commandText, kind)
    if (useModel) {
      try {
        const data = await rewriteText(commandText || '润色这段，保持原意', span.text || el.textContent)
        if (data?.text) next = data.text
      } catch {
        /* keep local next */
      }
    }
    if (next != null && next !== (span.text || '')) {
      replaceText(el, span.text, next)
      rewritten.add(span.text)
      count += 1
    }
  }

  if (scope === 'follow' && rewritten.size && kind !== 'delete') {
    const doc = getDoc()
    const all = [...(doc?.body?.querySelectorAll('p, h1, h2, h3, h4, li, td, a, span') || [])]
    for (const original of rewritten) {
      if (!original || original.length < 2) continue
      for (const el of all) {
        if (items.some((x) => x.el === el)) continue
        if (!(el.textContent || '').includes(original)) continue
        const sample = { kind: 'text', text: original }
        const next = localNextText(sample, commandText, kind)
        replaceText(el, original, next)
        count += 1
      }
    }
  }

  if (!count) {
    notify('没有改到圈中的内容')
    return false
  }
  ping()
  notify(scope === 'follow' ? `已写入网页，共 ${count} 处。可撤回` : `已改圈里的网页内容，共 ${count} 处。可撤回`)
  return true
}

function fileName() {
  const raw = String(meta.title || 'markset-page').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'markset-page'
  return `${raw.slice(0, 40)}.html`
}

export function exportWebDoc() {
  if (!isWebDocActive()) return false
  const html = snapshotWebHtml()
  if (!html.trim()) return false
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = fileName()
  a.click()
  URL.revokeObjectURL(a.href)
  return true
}
