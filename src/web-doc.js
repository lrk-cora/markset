import { isClientModelGateOn, rewriteText } from './api.js'
import { colorFill, colorRgb } from './colors.js'
import { aabb, intersectBoxes, pointInPolygon, strokeToPolygon } from './geometry.js'
import { getInkStrokes } from './ink.js'
import { collectLayoutPairs } from './layout.js'
import { getPaintMarks } from './overlay.js'
import { inferCommandText, localNextText, parseCommand } from './plan-local.js'
import { getSnapshot, ping, targets } from './store.js'

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'BR', 'HR', 'HEAD', 'HTML'])
const SKIN_ID = 'markset-skin'
const MAX_HITS = 4

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
[data-markset-scaled] { transform-origin: center center; max-width: 100%; }
[data-markset-flow] { overflow: visible; }
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
  webEdits = []
}

function findByWebId(id) {
  if (id == null || id === '') return null
  const doc = getDoc()
  if (!doc) return null
  return doc.querySelector(`[data-markset-id="${CSS.escape(String(id))}"]`)
}

let webEdits = []
let webEditSeq = 0

function snapshotNode(el, extra = {}) {
  return {
    webId: el.getAttribute('data-markset-id') || '',
    html: el.outerHTML,
    parentId: el.parentElement?.getAttribute('data-markset-id') || '',
    nextId: el.nextElementSibling?.getAttribute('data-markset-id') || '',
    removed: false,
    ...extra,
  }
}

function insertShot(shot) {
  const doc = getDoc()
  if (!doc || !shot?.html) return null
  const wrap = doc.createElement('div')
  wrap.innerHTML = shot.html
  const node = wrap.firstElementChild
  if (!node) return null
  const parent = (shot.parentId && findByWebId(shot.parentId)) || doc.body
  const next = shot.nextId ? findByWebId(shot.nextId) : null
  if (next && parent && next.parentElement === parent) parent.insertBefore(node, next)
  else parent?.append(node)
  return node
}

function applyShot(shot) {
  if (!shot) return
  const cur = shot.webId ? findByWebId(shot.webId) : null
  if (shot.removed) {
    cur?.remove()
    return
  }
  const wrap = getDoc()?.createElement('div')
  if (!wrap) return
  wrap.innerHTML = shot.html
  const node = wrap.firstElementChild
  if (!node) return
  if (cur) cur.replaceWith(node)
  else insertShot(shot)
}

function recordWebEdit(label, before, after) {
  if (!before?.length) return null
  webEditSeq += 1
  const item = {
    id: `we-${webEditSeq}`,
    label: label || '改网页',
    keep: true,
    before,
    after: after || [],
  }
  webEdits = [item, ...webEdits]
  ping()
  return item
}

export function listWebEdits() {
  return webEdits.map((item) => ({ id: item.id, label: item.label, keep: item.keep !== false }))
}

export function restoreWebEdit(id) {
  const item = webEdits.find((x) => x.id === id)
  if (!item || item.keep === false) return false
  item.keep = false
  for (const shot of item.before || []) applyShot(shot)
  ping()
  fitHeight()
  return true
}

export function redoWebEdit(id) {
  const item = webEdits.find((x) => x.id === id)
  if (!item || item.keep !== false) return false
  item.keep = true
  for (const shot of item.after || []) applyShot(shot)
  ping()
  fitHeight()
  return true
}

export function popLastWebEdit() {
  if (!webEdits.length) return ''
  const item = webEdits[0]
  webEdits = webEdits.slice(1)
  ping()
  return item.label
}

export function clearWebEdits() {
  webEdits = []
  ping()
}

function areaOf(el) {
  const r = el?.getBoundingClientRect()
  return r ? r.width * r.height : 0
}

function logoCluster(el, box) {
  let cur = el
  for (let i = 0; i < 5 && cur.parentElement; i += 1) {
    const parent = cur.parentElement
    const pr = parent.getBoundingClientRect()
    const pa = pr.width * pr.height
    const ca = areaOf(cur)
    if (parent === parent.ownerDocument?.body) break
    if (pa > 520 * 220) break
    if (pr.height > 150 && pa > ca * 3.2) break
    if (box && !staysInPaint(parent, box) && overlapScore(parent, box).extraTop > 20) break
    cur = parent
  }
  return cur
}

function pickVisualEls(els) {
  const drilled = []
  for (const el of els) {
    if (!el) continue
    const inner = el.matches?.('img, svg, picture, canvas, video')
      ? el
      : el.querySelector?.('img, svg, picture, canvas, video, [class*="logo" i], [id*="logo" i]')
    const seed = inner && areaOf(inner) > 40 && areaOf(inner) < areaOf(el) * 0.92 ? inner : el
    drilled.push(logoCluster(seed))
  }
  const unique = []
  const seen = new Set()
  for (const el of drilled.sort((a, b) => areaOf(a) - areaOf(b))) {
    const id = el.getAttribute('data-markset-id') || el
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(el)
  }
  return unique.slice(0, 1)
}

function visualTargets() {
  const raw = selectedWebEls().map((x) => x.el).filter(Boolean)
  const fallback = selectedWebEls('image').map((x) => x.el).filter(Boolean)
  return pickVisualEls(raw.length ? raw : fallback)
}

function drawingPolys() {
  const polys = []
  const add = (pts) => {
    if (!pts?.length) return
    polys.push(pts.length >= 3 ? strokeToPolygon(pts) : pts)
  }
  for (const mark of getPaintMarks()) add(mark.points)
  for (const stroke of getInkStrokes()) add(stroke)
  for (const span of getSnapshot().spans) {
    if (span.poly?.length) polys.push(span.poly)
  }
  return polys
}

export function circledEditSpans() {
  const fromDraw = refreshWebTargetsFromDrawing(drawingPolys())
  if (fromDraw.length) return fromDraw
  return getSnapshot().spans.filter((s) => s.webId && s.kind !== 'slot' && s.willEdit !== false)
}

export function describeCircledHits() {
  const spans = circledEditSpans()
  const texts = spans.filter((s) => s.kind === 'text' && (s.text || '').trim())
  const images = spans.filter((s) => s.kind === 'image')
  if (!texts.length && !images.length) {
    return '圈内没有命中网页文字或图片（空白或用户自画）。不要猜成页面主Logo，除非圈确实套在Logo上。'
  }
  const bits = []
  if (texts.length) bits.push(`圈中文字：${texts.map((s) => `「${String(s.text).slice(0, 48)}」`).join('、')}`)
  if (images.length) bits.push(`圈中图片 ${images.length} 个`)
  if (texts.length && images.length) bits.push('字和图都圈到了，改动应同时作用在这两类上，除非操作明确只改其中一类。')
  else if (texts.length) bits.push('只圈中了文字，不要改成改别处的Logo图。')
  else bits.push('只圈中了图片，不要改成改别处的字。')
  return bits.join('\n')
}

export function editTargetEls() {
  const seen = new Set()
  const els = []
  for (const span of circledEditSpans()) {
    const el = findByWebId(span.webId)
    const id = el?.getAttribute('data-markset-id')
    if (!el || !id || seen.has(id)) continue
    seen.add(id)
    els.push(el)
  }
  return els
}

function rememberFlow(el) {
  if (el.dataset.marksetMarB == null) el.dataset.marksetMarB = el.style.marginBottom || ''
  if (el.dataset.marksetMarR == null) el.dataset.marksetMarR = el.style.marginRight || ''
  if (el.dataset.marksetZoom == null) el.dataset.marksetZoom = el.style.zoom || ''
}

function restoreFlow(el) {
  if (el.dataset.marksetMarB != null) el.style.marginBottom = el.dataset.marksetMarB
  if (el.dataset.marksetMarR != null) el.style.marginRight = el.dataset.marksetMarR
  if (el.dataset.marksetZoom != null) el.style.zoom = el.dataset.marksetZoom
  el.removeAttribute('data-markset-flow')
}

function clearAncestorClip(el) {
  let parent = el.parentElement
  for (let i = 0; i < 6 && parent; i += 1) {
    let overflow = ''
    try {
      overflow = parent.ownerDocument?.defaultView?.getComputedStyle(parent)?.overflow || ''
    } catch {
      overflow = ''
    }
    if (overflow === 'hidden' || overflow === 'auto' || overflow === 'scroll') {
      if (parent.dataset.marksetOverflow == null) parent.dataset.marksetOverflow = parent.style.overflow || ''
      parent.style.overflow = 'visible'
    }
    parent = parent.parentElement
  }
}

function adaptLayout(el, kind) {
  if (!el) return
  rememberFlow(el)
  const r = el.getBoundingClientRect()
  el.style.overflow = 'visible'
  if (kind === 'reflect') {
    el.style.marginBottom = `${Math.round(Math.max(r.height * 0.9, 36) + 8)}px`
    el.setAttribute('data-markset-flow', 'reflect')
    clearAncestorClip(el)
  } else if (kind === 'shadow') {
    el.style.marginBottom = `${Math.max(18, parseFloat(el.style.marginBottom) || 0)}px`
    el.style.marginRight = `${Math.max(14, parseFloat(el.style.marginRight) || 0)}px`
    el.setAttribute('data-markset-flow', 'shadow')
    clearAncestorClip(el)
  } else if (kind === 'scale') {
    el.style.maxWidth = '100%'
    el.style.flex = '0 1 auto'
    el.setAttribute('data-markset-flow', 'scale')
  } else if (kind === 'clear') {
    restoreFlow(el)
  }
  requestAnimationFrame(fitHeight)
}

function currentScale(el) {
  const n = Number(el.getAttribute('data-markset-scale') || 1)
  return Number.isFinite(n) && n > 0.05 ? n : 1
}

function setElScale(el, factor) {
  const next = Math.max(0.2, Math.min(3, currentScale(el) * factor))
  if (!el.dataset.marksetOrigW) {
    const r = el.getBoundingClientRect()
    el.dataset.marksetOrigW = String(r.width)
    el.dataset.marksetOrigH = String(r.height)
  }
  const origW = Number(el.dataset.marksetOrigW) || el.getBoundingClientRect().width
  el.setAttribute('data-markset-scale', String(next))
  el.setAttribute('data-markset-scaled', '1')
  rememberFlow(el)
  if (/^(IMG|SVG|CANVAS|VIDEO|PICTURE)$/.test(el.tagName)) {
    el.style.zoom = ''
    el.style.width = `${Math.max(12, origW * next)}px`
    el.style.height = 'auto'
    el.style.maxWidth = '100%'
  } else {
    el.style.zoom = String(next)
  }
  adaptLayout(el, 'scale')
}

export function applyWebScale(factor, label = '缩放') {
  const els = visualTargets()
  if (!els.length) return false
  const before = els.map((el) => snapshotNode(el))
  for (const el of els) setElScale(el, factor)
  recordWebEdit(label, before, els.map((el) => snapshotNode(el)))
  fitHeight()
  return true
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
  if (!el) return false
  if (el.tagName === 'IMG' && (el.naturalWidth || el.width || el.getBoundingClientRect().width)) return true
  if (el.tagName === 'SVG' || el.tagName === 'CANVAS' || el.tagName === 'VIDEO' || el.tagName === 'PICTURE') return true
  return false
}

function isGraphicEl(el) {
  return isImageEl(el) || hasPaintedBg(el) || el?.tagName === 'SVG'
}

function collectColorable(el) {
  const out = []
  const seen = new Set()
  const add = (node) => {
    if (!node || seen.has(node)) return
    seen.add(node)
    out.push(node)
  }
  add(el)
  el.querySelectorAll?.('img, svg, canvas, video, picture, span, a, i, em, b, strong').forEach((node) => {
    if (isGraphicEl(node) || textOf(node)) add(node)
  })
  return out
}

function hasPaintedBg(el) {
  try {
    const bg = el.ownerDocument?.defaultView?.getComputedStyle(el)?.backgroundImage || ''
    return Boolean(bg && bg !== 'none' && !/gradient/i.test(bg))
  } catch {
    return false
  }
}

function isWidgetEl(el) {
  if (!el || SKIP.has(el.tagName)) return false
  if (isImageEl(el) || hasPaintedBg(el)) return true
  const tag = el.tagName
  if (tag === 'A' || tag === 'BUTTON' || tag === 'LABEL' || tag === 'INPUT') return true
  const role = el.getAttribute?.('role')
  if (role === 'img' || role === 'button' || role === 'link') return true
  return false
}

function isTextEl(el) {
  if (!el || SKIP.has(el.tagName) || isImageEl(el)) return false
  return textOf(el).length > 0
}

function promoteTarget(el) {
  const parent = el?.parentElement
  if (!parent || parent === el.ownerDocument?.body) return el
  if (parent.tagName !== 'A' && parent.tagName !== 'BUTTON') return el
  const pr = parent.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  const pa = Math.max(1, pr.width * pr.height)
  const ca = Math.max(1, r.width * r.height)
  if (pa < 220 * 120 && pa / ca < 3.2) return parent
  return el
}

function sampleHitPoints(poly) {
  const box = aabb(poly)
  const pts = [{ x: box.x + box.w / 2, y: box.y + box.h / 2 }]
  const grid = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
    [0.5, 0.2],
    [0.5, 0.8],
    [0.2, 0.5],
    [0.8, 0.5],
  ]
  for (const [fx, fy] of grid) pts.push({ x: box.x + box.w * fx, y: box.y + box.h * fy })
  if (poly.length <= 24) pts.push(...poly)
  return pts.filter((p) => pointInPolygon(p.x, p.y, poly))
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

function coverEl(el, poly) {
  const r = el.getBoundingClientRect()
  if (r.width < 3 || r.height < 3) return 0
  let inside = 0
  const n = 5
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const x = r.x + (r.width * i) / (n + 1)
      const y = r.y + (r.height * j) / (n + 1)
      if (pointInPolygon(x, y, poly)) inside += 1
    }
  }
  const cover = inside / (n * n)
  const box = aabb(poly)
  const hit = intersectBoxes({ x: r.x, y: r.y, w: r.width, h: r.height }, box)
  const boxCover = hit ? (hit.w * hit.h) / Math.max(1, r.width * r.height) : 0
  return Math.max(cover, Math.min(1, boxCover))
}

function considerEl(el, frameArea, seen, poly, { minCover = 0.12 } = {}) {
  if (!el || el === el.ownerDocument?.documentElement || el === el.ownerDocument?.body) return
  if (SKIP.has(el.tagName)) return
  const target = promoteTarget(el)
  const r = target.getBoundingClientRect()
  if (r.width < 3 || r.height < 3) return
  if (r.width * r.height > frameArea * 0.82) return
  const id = target.getAttribute('data-markset-id')
  if (!id) return
  const widget = isWidgetEl(target) || isImageEl(target)
  const text = isTextEl(target)
  if (!widget && !text) {
    if (r.width * r.height > 240 * 90) return
  }
  const cover = coverEl(target, poly)
  const box = aabb(poly)
  const hit = intersectBoxes({ x: r.x, y: r.y, w: r.width, h: r.height }, box)
  const overlap = hit ? (hit.w * hit.h) / Math.max(1, Math.min(r.width * r.height, box.w * box.h)) : 0
  const score = Math.max(cover, overlap)
  if (score < minCover) return
  const area = r.width * r.height
  const kind = widget && !text ? 'image' : text && !widget ? 'text' : widget ? 'image' : 'text'
  const prev = seen.get(id)
  if (!prev || score > prev.score || (score === prev.score && area < prev.area)) {
    seen.set(id, { el: target, area, kind, cover, overlap, score })
  }
}

function scanMarked(poly, frameArea, seen, minCover) {
  const doc = getDoc()
  if (!doc) return
  for (const el of doc.querySelectorAll('[data-markset-id]')) {
    considerEl(el, frameArea, seen, poly, { minCover })
  }
}

function inflatePoly(poly, pad) {
  const box = aabb(poly)
  return [
    { x: box.x - pad, y: box.y - pad },
    { x: box.x + box.w + pad, y: box.y - pad },
    { x: box.x + box.w + pad, y: box.y + box.h + pad },
    { x: box.x - pad, y: box.y + box.h + pad },
  ]
}

export function hitWebDoc(polygon, { loose = false } = {}) {
  const empty = { texts: { found: [], suggest: [] }, images: { found: [], suggest: [] } }
  const doc = getDoc()
  const iframe = frameEl()
  if (!doc?.body || !iframe) return empty
  const poly = toIframePoly(polygon)
  const frameArea = Math.max(1, iframe.clientWidth * iframe.clientHeight)
  const seen = new Map()
  const minCover = loose ? 0.04 : 0.12
  for (const p of sampleHitPoints(poly)) {
    let stack = []
    try {
      stack = doc.elementsFromPoint(p.x, p.y) || []
    } catch {
      const one = doc.elementFromPoint(p.x, p.y)
      if (one) stack = [one]
    }
    for (const el of stack.slice(0, 8)) considerEl(el, frameArea, seen, poly, { minCover })
  }
  if (loose) scanMarked(inflatePoly(poly, 14), frameArea, seen, 0.08)
  const box = aabb(poly)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const paintArea = Math.max(1, box.w * box.h)
  let items = [...seen.values()].filter((h) => h.cover >= (loose ? 0.08 : 0.22) || (loose && h.overlap >= 0.12))
  if (!items.length) items = [...seen.values()].filter((h) => h.score >= minCover)
  items = items.filter((h) => {
    if (isGraphicEl(h.el)) return h.cover >= 0.06 || h.overlap >= 0.08
    return h.area <= paintArea * 8 || h.cover >= 0.45
  })
  const atCenter = items
    .filter((h) => {
      const r = h.el.getBoundingClientRect()
      return cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height
    })
    .sort((a, b) => a.area - b.area)
  if (atCenter.length) {
    const core = atCenter[0]
    items = items.filter(
      (h) =>
        h.el === core.el ||
        (h.area <= Math.max(core.area * 8, paintArea * 3) && (h.cover >= 0.16 || h.overlap >= 0.18)),
    )
    if (!items.some((h) => h.el === core.el)) items.unshift(core)
  }
  items.sort((a, b) => a.area - b.area || (b.score || b.cover) - (a.score || a.cover))
  if (items[0] && items[0].cover >= 0.4 && !loose) {
    items = items.filter((h) => h.area <= items[0].area * 8)
  }
  items = items.slice(0, loose ? 4 : MAX_HITS)
  const images = []
  const texts = []
  for (const hit of items) {
    if (hit.kind === 'image') images.push(spanFromEl(hit.el, 'image'))
    else texts.push(spanFromEl(hit.el, 'text'))
  }
  return {
    texts: { found: texts, suggest: [] },
    images: { found: images, suggest: [] },
  }
}

export function refreshWebTargetsFromDrawing(polygons = []) {
  const found = []
  const seen = new Set()
  const add = (span) => {
    if (!span?.webId || seen.has(span.webId)) return
    seen.add(span.webId)
    found.push(span)
  }
  for (const poly of polygons) {
    if (!poly?.length) continue
    const hits = hitWebDoc(poly, { loose: true })
    hits.images.found.forEach(add)
    hits.texts.found.forEach(add)
  }
  return found
}

export function webHitsFromSpans(spans) {
  const found = { texts: [], images: [] }
  const seen = new Set()
  const add = (span) => {
    if (!span?.webId || seen.has(span.webId)) return
    seen.add(span.webId)
    if (span.kind === 'image') found.images.push(span)
    else found.texts.push(span)
  }
  for (const span of spans || []) {
    if (span.webId && span.kind !== 'slot') add(span)
    if (span.poly) {
      const hits = hitWebDoc(span.poly, { loose: true })
      hits.images.found.forEach(add)
      hits.texts.found.forEach(add)
    }
  }
  return found
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
  const els = editTargetEls()
  if (!els.length) return false
  const before = els.map((el) => snapshotNode(el))
  for (const el of els) el.setAttribute('data-markset-anno', kind)
  recordWebEdit(kind === 'highlight' ? '高亮' : '加框', before, els.map((el) => snapshotNode(el)))
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
  const img = visualTargets()[0]
  if (!img) return false
  const before = [snapshotNode(img)]
  const css = 'drop-shadow(6px 10px 8px rgba(36, 24, 14, 0.45))'
  if (img.dataset.marksetShadow === '1') {
    img.style.filter = ''
    delete img.dataset.marksetShadow
    if (img.getAttribute('data-markset-flow') === 'shadow') adaptLayout(img, 'clear')
  } else {
    img.style.filter = css
    img.dataset.marksetShadow = '1'
    adaptLayout(img, 'shadow')
  }
  recordWebEdit('加阴影', before, [snapshotNode(img)])
  return true
}

export function applyWebReflect() {
  const img = visualTargets()[0]
  if (!img) return false
  const before = [snapshotNode(img)]
  const css = 'below 8px linear-gradient(transparent 20%, rgba(0,0,0,.45))'
  if (img.dataset.marksetReflect === '1') {
    img.style.webkitBoxReflect = ''
    delete img.dataset.marksetReflect
    if (img.getAttribute('data-markset-flow') === 'reflect') adaptLayout(img, 'clear')
  } else {
    img.style.webkitBoxReflect = css
    img.dataset.marksetReflect = '1'
    adaptLayout(img, 'reflect')
  }
  recordWebEdit('加倒影', before, [snapshotNode(img)])
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
  const before = els.map((el) => snapshotNode(el))
  for (const el of els) {
    const cur = parseFloat(el.style.paddingLeft || getComputedStyle(el).paddingLeft) || 0
    if (cur >= 24) continue
    el.style.paddingLeft = '2em'
  }
  recordWebEdit('空两格', before, els.map((el) => snapshotNode(el)))
  return true
}

export function applyWebLayoutMoves() {
  const pairs = collectLayoutPairs()
  let n = 0
  const before = []
  const afterEls = []
  for (const pair of pairs) {
    const el = findByWebId(pair.webId)
    const dest = toIframeRect(pair.dest)
    if (!el || !dest) continue
    before.push(snapshotNode(el))
    const src = el.getBoundingClientRect()
    const dx = Math.round(dest.x - src.left)
    const dy = Math.round(dest.y - src.top)
    el.style.transform = `translate(${dx}px, ${dy}px)`
    el.setAttribute('data-markset-shifted', '1')
    afterEls.push(el)
    n += 1
  }
  if (n) recordWebEdit('挪位置', before, afterEls.map((el) => snapshotNode(el)))
  return n
}

function replaceText(el, fromText, toText) {
  if (!el) return
  const next = String(toText || '')
  const from = String(fromText || '')
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  if (from) {
    let did = false
    for (const node of nodes) {
      if (node.nodeValue.includes(from)) {
        node.nodeValue = node.nodeValue.split(from).join(next)
        did = true
      }
    }
    if (did) return
  }
  if (nodes.length === 1) {
    nodes[0].nodeValue = next
    return
  }
  if (nodes.length) {
    nodes[0].nodeValue = next
    for (let i = 1; i < nodes.length; i += 1) nodes[i].nodeValue = ''
  }
}

function tintFilter(name) {
  const [r, g, b] = colorRgb(name)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  if (max !== min) {
    const d = max - min
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const sat = max === 0 ? 0 : (max - min) / max
  return `sepia(1) saturate(${Math.max(3, sat * 10 + 2).toFixed(2)}) hue-rotate(${(h - 35).toFixed(1)}deg) brightness(${(0.45 + (max / 255) * 0.55).toFixed(2)})`
}

function applyColor(el, name, kind) {
  const fill = colorFill(name) || name
  if (!fill) return
  const graphic = kind === 'image' || isGraphicEl(el)
  if (graphic) {
    const keep = String(el.style.filter || '')
      .replace(/sepia\([^)]*\)|saturate\([^)]*\)|hue-rotate\([^)]*\)|brightness\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    el.style.filter = `${keep} ${tintFilter(name)}`.trim()
    el.dataset.marksetTint = fill
    return
  }
  el.style.color = fill
  el.style.fill = fill
}

export function applyWebColor(name) {
  const result = executeCircledOp('color', { color: name, label: `改成${name}` })
  return result.ok
}

function uniqueEls(list) {
  const seen = new Set()
  const out = []
  for (const el of list || []) {
    const id = el?.getAttribute?.('data-markset-id') || el
    if (!el || seen.has(id)) continue
    seen.add(id)
    out.push(el)
  }
  return out
}

function iframeUnionBox(polys) {
  let x = Infinity
  let y = Infinity
  let r = -Infinity
  let b = -Infinity
  for (const poly of polys || []) {
    if (!poly?.length) continue
    const box = aabb(toIframePoly(poly))
    if (box.w < 2 || box.h < 2) continue
    x = Math.min(x, box.x)
    y = Math.min(y, box.y)
    r = Math.max(r, box.x + box.w)
    b = Math.max(b, box.y + box.h)
  }
  if (!Number.isFinite(x)) return null
  return { x, y, w: r - x, h: b - y }
}

function overlapScore(el, box) {
  const r = el.getBoundingClientRect()
  const area = Math.max(1, r.width * r.height)
  const hit = intersectBoxes({ x: r.x, y: r.y, w: r.width, h: r.height }, box)
  const o = hit ? hit.w * hit.h : 0
  return {
    el,
    area,
    coverBox: o / Math.max(1, box.w * box.h),
    coverEl: o / area,
    extraTop: Math.max(0, box.y - r.y),
    extraBottom: Math.max(0, r.y + r.height - (box.y + box.h)),
    extraLeft: Math.max(0, box.x - r.x),
    extraRight: Math.max(0, r.x + r.width - (box.x + box.w)),
  }
}

function staysInPaint(el, box) {
  const hit = overlapScore(el, box)
  if (hit.coverEl < 0.6) return false
  if (hit.extraTop > Math.max(16, box.h * 0.1)) return false
  if (hit.extraBottom > Math.max(28, box.h * 0.16)) return false
  if (hit.extraLeft > Math.max(28, box.w * 0.1) && hit.extraRight > Math.max(28, box.w * 0.1) && hit.coverEl < 0.78) {
    return false
  }
  return true
}

function scanOverlapEls(box) {
  const doc = getDoc()
  const iframe = frameEl()
  if (!doc?.body || !iframe) return []
  const frameArea = Math.max(1, iframe.clientWidth * iframe.clientHeight)
  const out = []
  for (const el of doc.querySelectorAll('[data-markset-id]')) {
    if (SKIP.has(el.tagName) || el === doc.body || el === doc.documentElement) continue
    const hit = overlapScore(el, box)
    if (hit.area > frameArea * 0.82) continue
    if (hit.coverBox < 0.035 && hit.coverEl < 0.1) continue
    out.push(hit)
  }
  return out
}

function pickModuleEl(hits, box, frameArea) {
  const paintArea = Math.max(1, box.w * box.h)
  const ranked = hits
    .filter((h) => staysInPaint(h.el, box) && h.coverBox >= 0.4 && h.area < frameArea * 0.55 && h.area > paintArea * 0.22)
    .sort((a, b) => Math.abs(a.area - paintArea) - Math.abs(b.area - paintArea) || b.coverEl - a.coverEl)
  if (ranked[0]) return ranked[0].el
  const seeds = hits.filter((h) => h.coverEl >= 0.35).sort((a, b) => a.area - b.area).slice(0, 12)
  let best = null
  for (const seed of seeds) {
    let parent = seed.el
    for (let i = 0; i < 6 && parent && parent !== parent.ownerDocument?.body; i += 1) {
      const hit = overlapScore(parent, box)
      if (staysInPaint(parent, box) && hit.coverBox >= 0.45 && hit.area < frameArea * 0.55) {
        if (!best || hit.area > overlapScore(best, box).area) best = parent
      }
      parent = parent.parentElement
    }
  }
  return best
}

function commonCoveringParent(els, box, frameArea) {
  if (!els.length) return null
  let parent = els[0].parentElement
  let lastFit = null
  while (parent && parent !== parent.ownerDocument?.body) {
    const inside = els.filter((el) => parent.contains(el)).length
    if (inside < Math.max(2, Math.ceil(els.length * 0.7))) break
    const hit = overlapScore(parent, box)
    if (!staysInPaint(parent, box) || hit.area >= frameArea * 0.55) break
    lastFit = parent
    parent = parent.parentElement
  }
  return lastFit
}

function blockEls(hits, box) {
  const candidates = hits
    .filter((h) => staysInPaint(h.el, box) && h.area > 70 * 48)
    .sort((a, b) => b.area - a.area)
  const kept = []
  for (const hit of candidates) {
    if (kept.some((k) => k.contains(hit.el))) continue
    kept.push(hit.el)
  }
  return uniqueEls(kept)
}

function leafEls(hits) {
  return uniqueEls(
    hits
      .filter((h) => (isGraphicEl(h.el) || isTextEl(h.el)) && h.coverEl >= 0.28)
      .sort((a, b) => a.area - b.area)
      .slice(0, 24)
      .map((h) => h.el),
  )
}

export function executeCircledOp(op, { color = '', label = '', onBefore } = {}) {
  const doc = getDoc()
  const iframe = frameEl()
  if (!doc?.body || !iframe) return { ok: false, reason: '没有导入的网页' }
  const box = iframeUnionBox(drawingPolys())
  if (!box || box.w < 6 || box.h < 6) return { ok: false, reason: '没有可用的圈。请再圈一次要改的地方' }
  const frameArea = Math.max(1, iframe.clientWidth * iframe.clientHeight)
  const hits = scanOverlapEls(box)
  const paintArea = box.w * box.h
  const large = paintArea > frameArea * 0.07 || Math.max(box.w, box.h) > 200
  const kind = String(op || '')
  let els = []

  if (kind.startsWith('delete')) {
    if (large) {
      const mod = pickModuleEl(hits, box, frameArea)
      if (mod && staysInPaint(mod, box)) els = [mod]
      if (!els.length) els = blockEls(hits, box)
    }
    if (!els.length) {
      els = leafEls(hits)
      if (kind === 'delete-image') els = els.filter((el) => isGraphicEl(el))
      if (kind === 'delete-text') els = els.filter((el) => isTextEl(el) && !isGraphicEl(el))
    }
    if (els.length >= 3) {
      const parent = commonCoveringParent(els, box, frameArea)
      if (parent && staysInPaint(parent, box)) els = [parent]
    }
    els = els.filter((el) => staysInPaint(el, box) || overlapScore(el, box).coverEl >= 0.5)
  } else if (kind === 'color') {
    els = leafEls(hits).filter((el) => overlapScore(el, box).coverEl >= 0.35)
    if (!els.length) {
      const mod = pickModuleEl(hits, box, frameArea)
      if (mod && staysInPaint(mod, box)) els = collectColorable(mod).filter((el) => staysInPaint(el, box) || overlapScore(el, box).coverEl >= 0.4)
    }
  } else if (kind === 'shadow' || kind === 'reflect' || kind === 'scale-down' || kind === 'scale-up') {
    const leaves = leafEls(hits).filter((el) => isGraphicEl(el) && overlapScore(el, box).coverEl >= 0.4)
    els = pickVisualEls(leaves.length ? leaves : [])
    if (!els.length) els = leaves.slice(0, 3)
  } else if (kind === 'clear-anno') {
    els = leafEls(hits)
  } else {
    if (large) {
      const mod = pickModuleEl(hits, box, frameArea)
      if (mod && staysInPaint(mod, box)) els = [mod]
    }
    if (!els.length) els = leafEls(hits)
  }

  els = uniqueEls(els).filter((el) => el.isConnected && el !== doc.body)
  if (!els.length) return { ok: false, reason: '圈里没对上可改的网页内容。请把圈贴着要改的那一块再画一次' }

  const title = label || kind
  onBefore?.(title)
  const before = els.map((el) => snapshotNode(el))
  let count = 0

  if (kind.startsWith('delete')) {
    for (const el of els) {
      el.remove()
      count += 1
    }
  } else if (kind === 'color') {
    const name = color || '红色'
    const painted = uniqueEls(els.flatMap((el) => collectColorable(el)))
    for (const el of painted) {
      applyColor(el, name, isGraphicEl(el) ? 'image' : 'text')
      count += 1
    }
  } else if (kind === 'shadow') {
    for (const el of els) {
      el.style.filter = `${el.style.filter || ''} drop-shadow(6px 10px 8px rgba(36, 24, 14, 0.45))`.trim()
      el.dataset.marksetShadow = '1'
      adaptLayout(el, 'shadow')
      count += 1
    }
  } else if (kind === 'reflect') {
    for (const el of els) {
      el.style.webkitBoxReflect = 'below 8px linear-gradient(transparent 20%, rgba(0,0,0,.45))'
      el.dataset.marksetReflect = '1'
      adaptLayout(el, 'reflect')
      count += 1
    }
  } else if (kind === 'scale-down' || kind === 'scale-up') {
    for (const el of els) {
      setElScale(el, kind === 'scale-down' ? 0.82 : 1.22)
      count += 1
    }
  } else if (kind === 'clear-anno') {
    for (const el of els) {
      if (el.hasAttribute('data-markset-anno')) {
        el.removeAttribute('data-markset-anno')
        count += 1
      }
    }
  } else {
    const anno = annoKind(kind)
    for (const el of els) {
      el.setAttribute('data-markset-anno', anno)
      count += 1
    }
  }

  if (!count) return { ok: false, reason: '没有改到圈中的内容' }
  const after = before.map((shot, i) => {
    const el = els[i]
    if (!el?.isConnected) return { ...shot, removed: true }
    return snapshotNode(el)
  })
  recordWebEdit(title, before, after)
  fitHeight()
  return {
    ok: true,
    count,
    message: kind.startsWith('delete')
      ? `已删除圈中内容，共 ${count} 处。可还原这一处`
      : `已改圈中内容，共 ${count} 处。可还原这一处`,
  }
}

export async function runWebWriteback(kind, notify, { onBefore } = {}) {
  const circled = circledEditSpans()
  const picked = targets().filter((s) => s.willEdit !== false)
  const fromHits = webHitsFromSpans(picked)
  let web = (circled.length ? circled : [
    ...picked.filter((s) => s.webId && s.kind !== 'slot'),
    ...fromHits.images,
    ...fromHits.texts,
  ]).filter((s, i, arr) => s.webId && s.kind !== 'slot' && arr.findIndex((x) => x.webId === s.webId) === i)
  if (!web.length) {
    notify('没圈到可改的网页内容。请把圈画在要改的文字或图片上')
    return false
  }
  const snap = getSnapshot()
  const scope = snap.scope || 'inside'
  const commandText = inferCommandText(snap.commandText, web.filter((s) => s.kind === 'text'))
  const parsed = parseCommand(commandText)
  const deco = /倒影|镜像|反射/.test(commandText)
    ? 'reflect'
    : /阴影|投影|影子/.test(commandText)
      ? 'shadow'
      : /缩小|变小|小一点/.test(commandText) || kind === 'scale-down'
        ? 'scale-down'
        : /放大|变大|大一点/.test(commandText) || kind === 'scale-up'
          ? 'scale-up'
          : ''
  if (deco === 'reflect' || kind === 'reflect') {
    onBefore?.('加倒影')
    const ok = applyWebReflect()
    if (!ok) {
      notify('先圈要加倒影的图')
      return false
    }
    ping()
    fitHeight()
    notify('已在网页上加上倒影，仍是 HTML。可撤回这一处')
    return true
  }
  if (deco === 'shadow' || kind === 'shadow') {
    onBefore?.('加阴影')
    const ok = applyWebShadow()
    if (!ok) {
      notify('先圈要加阴影的图')
      return false
    }
    ping()
    fitHeight()
    notify('已在网页上加上阴影，仍是 HTML。可撤回这一处')
    return true
  }
  if (deco === 'scale-down' || deco === 'scale-up' || kind === 'scale-down' || kind === 'scale-up') {
    const down = deco === 'scale-down' || kind === 'scale-down'
    onBefore?.(down ? '缩小' : '放大')
    const ok = applyWebScale(down ? 0.82 : 1.22, down ? '缩小' : '放大')
    if (!ok) {
      notify('先圈要缩放的 Logo 或图片')
      return false
    }
    ping()
    fitHeight()
    notify(down ? '已缩小圈中内容，仍是 HTML。可撤回这一处' : '已放大圈中内容，仍是 HTML。可撤回这一处')
    return true
  }
  if (parsed.color && kind !== 'delete') {
    onBefore?.('改颜色')
    const ok = applyWebColor(parsed.color)
    if (!ok) {
      notify('没圈到可改颜色的字或图。请贴着要改的文字或图片画圈')
      return false
    }
    ping()
    fitHeight()
    notify(`已把圈中的内容改成${parsed.color}（字和图会一起改）。可撤回这一处`)
    return true
  }
  if ((kind === 'rewrite' || kind === 'unify' || kind === 'replace') && !commandText && !parsed.color) {
    notify('先写下新名字或选出颜色')
    return false
  }
  if (kind === 'delete') {
    /* user already picked a delete guess */
  }

  const items = web.map((s) => ({ span: s, el: findByWebId(s.webId) })).filter((x) => x.el)
  const useModel = isClientModelGateOn() && (kind === 'rewrite' || kind === 'unify') && items.some((x) => x.span.kind === 'text')
  if (useModel) {
    const ok = window.confirm(`将调用云端改写 ${items.filter((x) => x.span.kind === 'text').length} 处文字，会消耗额度。确定？`)
    if (!ok) return false
  }

  onBefore?.(kind === 'delete' ? '删网页内容' : '改网页')

  const before = items.map((x) => snapshotNode(x.el))
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
  const after = items.map((x, i) => {
    const el = findByWebId(x.span.webId)
    if (!el) return { ...before[i], removed: true }
    return snapshotNode(el)
  })
  recordWebEdit(kind === 'delete' ? '删除' : parsed.color ? '改颜色' : '改网页', before, after)
  ping()
  fitHeight()
  notify(scope === 'follow' ? `已写入网页，共 ${count} 处，仍是 HTML。每处可撤回` : `已改圈里的网页内容，共 ${count} 处。每处可点「还原这一处」`)
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
