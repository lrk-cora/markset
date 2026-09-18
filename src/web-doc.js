import { rewriteText } from './api.js'
import { colorFill, colorRgb, COLOR_SCHEMES } from './colors.js'
import { aabb, dist, intersectBoxes, looksLikeRadialBurst, pathLength, pointInPolygon, strokeToPolygon } from './geometry.js'
import { collectLayoutPairs } from './layout.js'
import { getInkStrokes } from './ink.js'
import { getPaintMarks, SELECT_COLOR } from './overlay.js'
import { inferCommandText, localNextText, parseCommand } from './plan-local.js'
import { getSnapshot, ping, targets, upsertSpan } from './store.js'

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'BR', 'HR', 'HEAD', 'HTML'])
const SKIN_ID = 'markset-skin'
const MAX_HITS = 4

let meta = { title: '', sourceUrl: '' }
let viewportBound = false
const iframeScrollBound = new WeakSet()
const BADGE_HOST = 'markset-badge-host'

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
[data-markset-shifted]:not([data-markset-shifted="flow"]) { position: relative; z-index: 3; }
[data-markset-shifted="flow"] { position: relative; left: auto; top: auto; transform: none; z-index: auto; max-width: 100%; clear: both; }
[data-markset-move-slot] { display: block; width: 100%; max-width: 100%; box-sizing: border-box; clear: both; }
[data-markset-scaled] { transform-origin: center center; max-width: 100%; }
[data-markset-flow] { overflow: visible; }
[data-markset-tombstone] { display: inline-block; width: 0; overflow: hidden; margin: 0; padding: 0; border: 0; vertical-align: top; pointer-events: none; }
[data-markset-shaped-shadow] { pointer-events: none; }
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
  doc.querySelector(`#${BADGE_HOST}`)?.remove()
  doc.querySelectorAll('[data-markset-badge-host], [data-markset-edit-badge]').forEach((el) => el.remove())
  bindIframeScroll(doc)
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

function bindIframeScroll(doc) {
  if (!doc || iframeScrollBound.has(doc)) return
  iframeScrollBound.add(doc)
  const onMove = () => ping()
  doc.addEventListener('scroll', onMove, { passive: true, capture: true })
  doc.defaultView?.addEventListener('scroll', onMove, { passive: true })
}

function bindViewport() {
  if (viewportBound) return
  viewportBound = true
  const onMove = () => {
    if (!isWebDocActive()) return
    ping()
  }
  document.querySelector('.stage')?.addEventListener('scroll', onMove, { passive: true })
  document.querySelector('.page')?.addEventListener('scroll', onMove, { passive: true })
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
  const clone = doc.documentElement.cloneNode(true)
  clone.querySelector(`#${BADGE_HOST}`)?.remove()
  clone.querySelectorAll('[data-markset-badge-host], [data-markset-edit-badge]').forEach((el) => el.remove())
  return `<!DOCTYPE html>\n${clone.outerHTML}`
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

function iframeScroll() {
  const doc = getDoc()
  const win = doc?.defaultView
  return {
    x: win?.scrollX || doc?.documentElement?.scrollLeft || 0,
    y: win?.scrollY || doc?.documentElement?.scrollTop || 0,
  }
}

function nodeAnchor(el) {
  if (!el?.getBoundingClientRect) return null
  const r = el.getBoundingClientRect()
  const s = iframeScroll()
  return { ix: r.left + s.x + Math.max(r.width, 0) + 6, iy: r.top + s.y }
}

function mapAnchor(anchor) {
  if (!anchor || anchor.ix == null || anchor.iy == null) return null
  const frame = iframeBox()
  if (!frame) return null
  const s = iframeScroll()
  return { x: frame.left + anchor.ix - s.x, y: frame.top + anchor.iy - s.y }
}

function isTombstone(el) {
  return Boolean(el?.hasAttribute?.('data-markset-tombstone'))
}

function leaveTombstone(el) {
  if (!el?.isConnected) return null
  const doc = el.ownerDocument
  const id = el.getAttribute('data-markset-id') || ''
  const r = el.getBoundingClientRect()
  const ph = doc.createElement('span')
  if (id) ph.setAttribute('data-markset-id', id)
  ph.setAttribute('data-markset-tombstone', '1')
  ph.setAttribute('aria-hidden', 'true')
  const h = Math.max(12, Math.min(40, Math.round(r.height || 0)))
  ph.style.cssText = `display:inline-block;width:0;height:${h}px;overflow:hidden;margin:0;padding:0;border:0;vertical-align:top;pointer-events:none;`
  el.replaceWith(ph)
  return ph
}

function snapshotNode(el, extra = {}) {
  return {
    webId: el.getAttribute('data-markset-id') || '',
    html: el.outerHTML,
    parentId: el.parentElement?.getAttribute('data-markset-id') || '',
    nextId: el.nextElementSibling?.getAttribute('data-markset-id') || '',
    removed: false,
    tombstone: isTombstone(el),
    anchor: nodeAnchor(el),
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
  if (shot.relocated || shot.styleOnly) {
    const cur = shot.webId ? findByWebId(shot.webId) : null
    if (!cur) return
    if (shot.relocated) {
      detachMoveSlot(cur)
      const parent = (shot.parentId && findByWebId(shot.parentId)) || cur.parentElement
      const next = shot.nextId ? findByWebId(shot.nextId) : null
      if (parent && (cur.parentElement !== parent || cur.nextElementSibling !== next)) {
        if (next && next.parentElement === parent) parent.insertBefore(cur, next)
        else parent.append(cur)
      }
    }
    if (shot.cssText != null) cur.setAttribute('style', shot.cssText)
    else cur.removeAttribute('style')
    if (shot.shifted) cur.setAttribute('data-markset-shifted', shot.shifted)
    else cur.removeAttribute('data-markset-shifted')
    return
  }
  const cur = shot.webId ? findByWebId(shot.webId) : null
  if (shot.removed) {
    if (cur && !isTombstone(cur)) leaveTombstone(cur)
    else if (!cur) insertShot({ ...shot, html: tombstoneHtml(shot) })
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

function snapshotStyle(el) {
  return {
    webId: el.getAttribute('data-markset-id') || '',
    html: '',
    cssText: el.getAttribute('style') || '',
    shifted: el.getAttribute('data-markset-shifted') || '',
    styleOnly: true,
    relocated: true,
    parentId: el.parentElement?.getAttribute('data-markset-id') || '',
    nextId: el.nextElementSibling?.getAttribute('data-markset-id') || '',
    removed: false,
    anchor: nodeAnchor(el),
  }
}

function snapshotPlace(el) {
  return snapshotStyle(el)
}

function tombstoneHtml(shot) {
  const id = shot?.webId ? ` data-markset-id="${esc(shot.webId)}"` : ''
  return `<span${id} data-markset-tombstone="1" aria-hidden="true" style="display:inline-block;width:0;height:12px;overflow:hidden;margin:0;padding:0;border:0;vertical-align:top;pointer-events:none;"></span>`
}

function recordWebEdit(label, before, after) {
  if (!before?.length) return null
  webEditSeq += 1
  const item = {
    id: `we-${webEditSeq}`,
    label: label || '改网页',
    keep: true,
    at: Date.now(),
    before,
    after: after || [],
    screen: null,
  }
  item.screen = firstLiveAnchor(item.after) || firstLiveAnchor(item.before)
  if (!item.screen) {
    const shot = (item.after || []).find((s) => s?.anchor) || (item.before || []).find((s) => s?.anchor)
    item.screen = mapAnchor(shot?.anchor)
  }
  webEdits = [item, ...webEdits]
  ping()
  return item
}

function firstLiveAnchor(shots) {
  for (const shot of shots || []) {
    if (!shot?.webId) continue
    if (shot.removed && !shot.tombstone) continue
    const r = liveScreenRect({ webId: shot.webId })
    if (r) return { x: r.x + Math.max(r.w, 0) + 6, y: r.y }
    const cached = mapAnchor(shot.anchor)
    if (cached) return cached
  }
  return null
}

export function listWebEdits() {
  return webEdits.map((item) => ({
    id: item.id,
    label: item.label,
    keep: item.keep !== false,
    webIds: [...new Set([...(item.after || []), ...(item.before || [])].map((s) => s.webId).filter(Boolean))],
  }))
}

export function webEditAnchor(item) {
  const full = webEdits.find((x) => x.id === item?.id) || item
  const live = firstLiveAnchor(full.keep === false ? full.before : full.after) || firstLiveAnchor(full.before)
  if (live) {
    full.screen = live
    return live
  }
  return full.screen || null
}

export function tintWebEl(webId, name, kind = 'auto') {
  const el = findByWebId(webId)
  if (!el) return false
  const before = snapshotNode(el)
  const graphic = kind === 'image' || isGraphicEl(el)
  applyColor(el, name, graphic ? 'image' : 'text')
  for (const child of collectColorable(el)) {
    if (child === el) continue
    applyColor(child, name, isGraphicEl(child) ? 'image' : 'text')
  }
  recordWebEdit(`改成${name || '所选颜色'}`, [before], [snapshotNode(el)])
  return true
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

export function popWebEditsSince(at) {
  undoWebEditsSince(at)
}

export function undoWebEditsSince(at) {
  const t = Number(at) || 0
  const recent = t
    ? webEdits.filter((item) => (item.at || 0) >= t)
    : webEdits.slice(0, 1)
  for (const item of recent) {
    if (item.keep === false) continue
    for (const shot of item.before || []) applyShot(shot)
    item.keep = false
  }
  webEdits = t ? webEdits.filter((item) => (item.at || 0) < t) : webEdits.slice(1)
  ping()
  fitHeight()
}

export function clearWebEdits() {
  webEdits = []
  ping()
}

function areaOf(el) {
  const r = el?.getBoundingClientRect()
  return r ? r.width * r.height : 0
}

let lastPaintBox = null
let lastShadowJob = null
let paintRoleCache = { key: '', val: null }

export function rememberPaintBox(polygon) {
  const box = iframeUnionBox([polygon])
  if (box && box.w >= 6 && box.h >= 6) lastPaintBox = box
  return lastPaintBox
}

function paintBoxKey(marks) {
  return (marks || [])
    .map((m) => `${m.points?.length || 0}:${Math.round(m.points?.[0]?.x || 0)},${Math.round(m.points?.[0]?.y || 0)}`)
    .join('|')
}

function isChromeStrip(el) {
  if (!el) return false
  const iframe = frameEl()
  const r = el.getBoundingClientRect()
  const fw = iframe?.clientWidth || 0
  if (!fw || r.width < 8) return false
  return r.top < 180 && r.width > fw * 0.62 && r.height < 96 && r.height > 10
}

function containsStackedStrips(el) {
  if (!el) return false
  const iframe = frameEl()
  const fw = iframe?.clientWidth || 0
  const kids = significantChildren(el)
  const strips = kids.filter((kid) => {
    if (isChromeStrip(kid)) return true
    const r = kid.getBoundingClientRect()
    return fw && r.width > fw * 0.58 && r.height < 110 && r.height > 16
  })
  return strips.length >= 2
}

function distinctiveClass(el) {
  return [...(el?.classList || [])].filter(
    (c) =>
      c.length > 2 &&
      !/^(is-|js-|active|open|on|off|clearfix|row|col|container|wrap|wrapper|inner|flex|grid|item|box|left|right|top|nav|header|footer|main|content)/i.test(c) &&
      !/^markset/i.test(c),
  )
}

function logoCluster(el, box) {
  let cur = el
  const paintH = box?.h || 48
  const fw = frameEl()?.clientWidth || 0
  for (let i = 0; i < 5 && cur.parentElement; i += 1) {
    const parent = cur.parentElement
    const pr = parent.getBoundingClientRect()
    const pa = pr.width * pr.height
    const ca = areaOf(cur)
    if (parent === parent.ownerDocument?.body) break
    if (containsStackedStrips(parent)) break
    if (isChromeStrip(parent) && !looksLikeLogo(parent)) break
    if (pa > 420 * 160) break
    if (pr.height > Math.max(72, paintH * 1.45) && pa > ca * 2.1) break
    if (fw && pr.width > fw * 0.68 && pr.height > paintH * 1.25) break
    if (box && !staysInPaint(parent, box) && overlapScore(parent, box).extraTop > 12) break
    cur = parent
  }
  return cur
}

function pickVisualEls(els, box) {
  const drilled = []
  for (const el of els) {
    if (!el) continue
    const inner = el.matches?.('img, svg, picture, canvas, video')
      ? el
      : el.querySelector?.('img, svg, picture, canvas, video, [class*="logo" i], [id*="logo" i]')
    const seed = inner && areaOf(inner) > 40 && areaOf(inner) < areaOf(el) * 0.92 ? inner : el
    const cluster = logoCluster(seed, box)
    const use = box && cluster && !staysInPaint(cluster, box) ? seed : cluster
    drilled.push(use)
  }
  const unique = []
  const seen = new Set()
  for (const el of drilled.sort((a, b) => areaOf(a) - areaOf(b))) {
    const id = el.getAttribute('data-markset-id') || el
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(el)
  }
  return unique.slice(0, 3)
}

function visualTargets() {
  const box = iframeUnionBox(drawingPolys())
  const raw = selectedWebEls().map((x) => x.el).filter(Boolean)
  const fallback = selectedWebEls('image').map((x) => x.el).filter(Boolean)
  const seeds = pickVisualEls(raw.length ? raw : fallback, box)
  if (!box) return seeds.slice(0, 1)
  return seeds.filter((el) => staysInPaint(el, box) || overlapScore(el, box).coverEl >= 0.4).slice(0, 1)
}

function looksLikeLassoStroke(pts) {
  if (!pts || pts.length < 8) return false
  const box = aabb(pts)
  if (box.w < 32 || box.h < 22) return false
  const peri = 2 * (box.w + box.h)
  const len = pathLength(pts)
  const closed = dist(pts[0], pts[pts.length - 1]) < Math.max(box.w, box.h) * 0.42
  return closed && len < peri * 3.2
}

function isHandwritingPaint(mark) {
  const pts = mark?.points
  if (!pts || pts.length < 2) return true
  const hex = String(mark.color || '').toLowerCase()
  if (hex === '#1d1916' || hex === '#111111' || hex === '#000000') return true
  if (looksLikeLassoStroke(pts)) return false
  const box = aabb(pts)
  const select = String(SELECT_COLOR || '#3c6fd4').toLowerCase()
  if (hex && hex === select) return false
  return box.w < 90 && box.h < 90
}

function boxOverlap(a, b) {
  if (!a || !b) return 0
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.w, b.x + b.w)
  const bot = Math.min(a.y + a.h, b.y + b.h)
  return Math.max(0, r - x) * Math.max(0, bot - y)
}

function boxesFar(a, b) {
  if (!a || !b) return true
  const overlap = boxOverlap(a, b)
  const area = Math.max(1, a.w * a.h, b.w * b.h)
  if (overlap / area > 0.4) return false
  const dx = a.x + a.w / 2 - (b.x + b.w / 2)
  const dy = a.y + a.h / 2 - (b.y + b.h / 2)
  return Math.hypot(dx, dy) > 36
}

function sceneFromIframeBox(box) {
  const empty = {
    blank: false,
    kind: 'none',
    fill: 0,
    coreTexts: [],
    coreImages: 0,
    incidental: [],
    text: '没有圈。',
  }
  if (!box || box.w < 8 || box.h < 8) return empty
  const paintArea = Math.max(1, box.w * box.h)
  const hits = scanOverlapEls(box).filter((h) => isGraphicEl(h.el) || isTextEl(h.el) || isWidgetEl(h.el))
  const core = hits.filter((h) => {
    if (isChromeStrip(h.el) && h.coverEl < 0.45) return false
    if (h.coverEl >= 0.28 && (centerInPaint(h.el, box) || h.coverBox >= 0.08)) return true
    return centerInPaint(h.el, box) && h.coverBox >= 0.05 && (isGraphicEl(h.el) || isWidgetEl(h.el)) && h.coverEl >= 0.22
  })
  const incidental = hits.filter((h) => !core.includes(h) && (h.coverBox < 0.08 || (!centerInPaint(h.el, box) && h.coverEl < 0.45)))
  const coreArea = core.reduce((sum, h) => sum + Math.min(h.area, paintArea) * Math.min(1, h.coverEl), 0)
  const fill = coreArea / paintArea
  const coreTexts = core.filter((h) => isPrimarilyText(h.el)).map((h) => textOf(h.el)).filter(Boolean)
  const coreImages = core.filter((h) => isGraphicEl(h.el) || isWidgetEl(h.el)).length
  const blank = fill < 0.16 && !coreImages && !coreTexts.length
  const kind = blank ? 'blank' : coreImages && coreTexts.length ? 'mixed' : coreImages ? 'image' : coreTexts.length ? 'text' : 'blank'
  const bits = []
  if (blank) {
    bits.push('圈内大部分是空白。操作对象是这块空白区域，不要把边上蹭到的搜索框/按钮当主目标。')
    if (incidental.length) {
      bits.push(`圈边只是碰到：${incidental.slice(0, 4).map((h) => `「${(textOf(h.el) || h.el.tagName).slice(0, 24)}」`).join('、')}。这些不要当成主目标。`)
    }
  } else {
    if (coreTexts.length) bits.push(`圈中文字：${coreTexts.map((t) => `「${t.slice(0, 48)}」`).join('、')}`)
    if (coreImages) bits.push(`圈中图片/Logo ${coreImages} 处。手写若是变小/缩小/改色，应改这一块，不是空白插入。`)
  }
  return { blank, kind, fill, coreTexts, coreImages, incidental, text: bits.join('\n') }
}

function paintLassoMarks() {
  const paints = getPaintMarks().filter((m) => m.points?.length >= 3 && !isHandwritingPaint(m))
  const lassos = paints.filter((m) => looksLikeLassoStroke(m.points))
  return lassos.length ? lassos : paints
}

function classifyPaintRoles(marks = paintLassoMarks()) {
  const all = marks || []
  const key = paintBoxKey(all)
  if (paintRoleCache.key === key && paintRoleCache.val) return paintRoleCache.val
  const result = (() => {
    if (all.length < 2) return { sources: all, dests: [], all }
    const scored = all.map((m) => {
      const poly = m.points.length >= 3 ? strokeToPolygon(m.points) : m.points
      const box = aabb(m.points)
      const iframe = iframeUnionBox([poly])
      const scene = sceneFromIframeBox(iframe)
      const hits = hitWebDoc(poly, { loose: true })
      const n = (hits.images?.found?.length || 0) + (hits.texts?.found?.length || 0)
      return { mark: m, box, poly, scene, n, blank: scene.blank || scene.fill < 0.28 }
    })
    const dests = scored.filter((s) => s.blank)
    const sources = scored.filter((s) => !s.blank)
    if (dests.length && sources.length) {
      return { sources: sources.map((s) => s.mark), dests: dests.map((s) => s.mark), all }
    }
    scored.sort((a, b) => b.n - a.n || a.box.w * a.box.h - b.box.w * b.box.h)
    const primary = scored[0]
    const extra = scored.slice(1).filter((s) => boxesFar(primary.box, s.box) && (s.n < primary.n || s.scene.fill < primary.scene.fill * 0.7))
    if (extra.length) {
      return { sources: [primary.mark], dests: extra.map((s) => s.mark), all }
    }
    return { sources: all, dests: [], all }
  })()
  paintRoleCache = { key, val: result }
  return result
}

function polysOfMarks(marks) {
  const polys = []
  for (const mark of marks || []) {
    if (!mark?.points?.length) continue
    polys.push(mark.points.length >= 3 ? strokeToPolygon(mark.points) : mark.points)
  }
  return polys
}

export function lassoPolys() {
  const roles = classifyPaintRoles()
  const source = roles.sources.length ? roles.sources : roles.all
  const polys = polysOfMarks(source)
  if (polys.length) return polys
  const destIds = new Set(getSnapshot().spans.filter((s) => s.layoutRole === 'dest').map((s) => s.markId))
  for (const span of getSnapshot().spans) {
    if (span.layoutRole === 'dest' || destIds.has(span.markId)) continue
    if (span.poly?.length) polys.push(span.poly)
  }
  return polys
}

function drawingPolys() {
  return lassoPolys()
}

export function looksLikeWebLayoutDest(rawPoints, polygon) {
  const sources = getSnapshot().spans.filter((s) => s.webId && s.kind !== 'slot' && s.layoutRole !== 'dest' && s.willEdit !== false)
  if (!sources.length) return false
  const pts = rawPoints?.length ? rawPoints : polygon
  const box = aabb(pts)
  const far = sources.every((s) => boxesFar(s.screenRect || liveScreenRect(s), box))
  if (!far) return false
  const iframe = iframeUnionBox([polygon?.length ? polygon : pts])
  const scene = sceneFromIframeBox(iframe)
  if (scene.blank || scene.fill < 0.38) return true
  const srcFill = Math.max(
    0,
    ...sources.map((s) => {
      const r = s.screenRect || liveScreenRect(s)
      if (!r) return 0
      return sceneFromIframeBox(toIframeRect(r))?.fill || 0
    }),
  )
  return scene.fill < Math.max(0.18, srcFill * 0.72)
}

export function pairWebLayoutDest(rawPoints, polygon, color = SELECT_COLOR) {
  const pts = rawPoints?.length ? rawPoints : polygon
  const box = aabb(pts)
  const sources = getSnapshot().spans.filter((s) => s.webId && s.kind !== 'slot' && s.layoutRole !== 'dest' && s.willEdit !== false)
  const src = sources[0]
  if (!src || !box) return null
  const hex = String(color || SELECT_COLOR)
  upsertSpan(
    (s) => s.markId === src.markId || (src.webId && s.webId === src.webId),
    { layoutColor: hex, layoutRole: 'source' },
  )
  upsertSpan(
    (s) => s.layoutColor === hex && s.layoutRole === 'dest',
    {
      kind: 'slot',
      layoutColor: hex,
      layoutRole: 'dest',
      screenRect: box,
      poly: polygon,
      paintMark: true,
      why: 'layout-dest',
    },
  )
  return { source: src, dest: box }
}

export function inferWebLayoutPairs() {
  const tagged = collectLayoutPairs()
  if (tagged.length) return tagged
  const roles = classifyPaintRoles()
  if (!roles.dests.length || !roles.sources.length) {
    const dest = getSnapshot().spans.find((s) => s.layoutRole === 'dest' && s.screenRect)
    const src = getSnapshot().spans.find((s) => s.webId && s.kind !== 'slot' && s.layoutRole !== 'dest')
    if (src?.webId && dest?.screenRect) {
      return [{
        webId: src.webId,
        dest: dest.screenRect,
        sourceRect: src.screenRect,
        kind: src.kind,
        label: src.kind === 'image' ? '图' : String(src.text || '这块').slice(0, 8),
      }]
    }
    return []
  }
  const destBox = aabb(roles.dests[0].points)
  const pairs = []
  const seen = new Set()
  for (const mark of roles.sources) {
    const poly = mark.points.length >= 3 ? strokeToPolygon(mark.points) : mark.points
    const hits = hitWebDoc(poly, { loose: true })
    for (const span of [...(hits.images?.found || []), ...(hits.texts?.found || [])]) {
      if (!span.webId || seen.has(span.webId)) continue
      seen.add(span.webId)
      pairs.push({
        webId: span.webId,
        dest: destBox,
        sourceRect: span.screenRect,
        kind: span.kind,
        label: span.kind === 'image' ? '图' : String(span.text || '这块').slice(0, 8),
      })
    }
  }
  return pairs
}

export function circledEditSpans() {
  const fromDraw = refreshWebTargetsFromDrawing(drawingPolys())
  if (fromDraw.length) return fromDraw
  return getSnapshot().spans.filter((s) => s.webId && s.kind !== 'slot' && s.willEdit !== false)
}

export function describePaintScene() {
  const empty = {
    blank: false,
    kind: 'none',
    fill: 0,
    coreTexts: [],
    coreImages: 0,
    incidental: [],
    text: '没有圈。',
  }
  if (!isWebDocActive()) return empty
  const box = iframeUnionBox(drawingPolys())
  const scene = sceneFromIframeBox(box)
  const pairs = inferWebLayoutPairs()
  if (pairs.length) {
    scene.text = `${scene.text || '已圈中要挪的模块。'}\n另有一处空白圈，应理解为落点而不是新选区。`
    scene.layout = true
  }
  const inks = getInkStrokes().filter((s) => s?.length >= 2)
  if (inks.length >= 3) {
    const inkBox = iframeUnionBox(inks)
    const around = sceneFromIframeBox(inkBox)
    const radial = looksLikeRadialBurst(inks)
    const who = around.coreTexts[0]
      ? `「${around.coreTexts[0].slice(0, 24)}」`
      : around.coreImages
        ? '这块图/Logo'
        : ''
    if (who) {
      scene.blank = false
      scene.drawn = radial ? 'radial' : 'pattern'
      scene.text = `${scene.text || ''}\n用户在${who}周围画了${inks.length}条线${radial ? '（放射状光芒/装饰）' : ''}。这是要把画出的图案加到该物体周围，不是空白插入，也不是删除这些线。`.trim()
    } else if (radial) {
      scene.blank = false
      scene.drawn = 'radial'
      scene.text = `${scene.text || ''}\n用户画了放射状线条，应把该图案贴到所画位置。`.trim()
    }
  }
  return scene.kind === 'none' && !box && !scene.drawn ? empty : scene
}

export function describeCircledHits() {
  const scene = describePaintScene()
  if (scene.text && (scene.kind !== 'none' || scene.drawn || scene.layout)) return scene.text
  const spans = circledEditSpans()
  const texts = spans.filter((s) => s.kind === 'text' && (s.text || '').trim())
  const images = spans.filter((s) => s.kind === 'image')
  if (!texts.length && !images.length) {
    return '圈内没有命中网页文字或图片。若用户只画了线或图案，按画法理解为贴上图案或调整布局，不要默认插入文字，也不要无视周围的 Logo。'
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
  clearAncestorClip(el)
  if (/^(IMG|SVG|CANVAS|VIDEO|PICTURE)$/.test(el.tagName)) {
    el.style.zoom = ''
    el.style.width = `${Math.max(12, origW * next)}px`
    el.style.height = 'auto'
    el.style.maxWidth = 'none'
  } else {
    el.style.zoom = String(next)
  }
  adaptLayout(el, 'scale')
}

export function applyWebScale(factor, label = '缩放') {
  return executeCircledOp(factor < 1 ? 'scale-down' : 'scale-up', { label }).ok
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
      const z = iframeZoom()
      return { x: frame.left + r.left * z, y: frame.top + r.top * z, w: r.width * z, h: r.height * z }
    }
  }
  return span?.screenRect || span?.imageRect || null
}

function toViewport(r) {
  const frame = iframeBox()
  if (!frame || !r) return null
  const z = iframeZoom()
  return { x: frame.left + r.left * z, y: frame.top + r.top * z, w: r.width * z, h: r.height * z }
}

function iframeZoom() {
  const z = Number.parseFloat(getDoc()?.documentElement?.style?.zoom || '')
  return Number.isFinite(z) && z > 0.05 ? z : 1
}

function toIframePoly(polygon) {
  const frame = iframeBox()
  if (!frame) return polygon
  const z = iframeZoom()
  return (polygon || []).map((p) => ({ x: (p.x - frame.left) / z, y: (p.y - frame.top) / z }))
}

function toIframeRect(rect) {
  const frame = iframeBox()
  if (!frame || !rect) return null
  const z = iframeZoom()
  const w = rect.w ?? rect.width ?? 0
  const h = rect.h ?? rect.height ?? 0
  return {
    x: (rect.x - frame.left) / z,
    y: (rect.y - frame.top) / z,
    w: w / z,
    h: h / z,
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

function looksLikeLogo(el) {
  const blob = `${el?.id || ''} ${el?.className || ''} ${el?.getAttribute?.('aria-label') || ''} ${el?.getAttribute?.('alt') || ''}`.toLowerCase()
  return /logo|brand|icon|sogou|搜狗/.test(blob)
}

function isGraphicEl(el) {
  if (!el) return false
  if (isImageEl(el) || hasPaintedBg(el) || el.tagName === 'SVG') return true
  if (el.getAttribute?.('role') === 'img') return true
  if (looksLikeLogo(el) && (hasPaintedBg(el) || el.querySelector?.('img, svg, canvas'))) return true
  if (el.querySelector?.(':scope > img, :scope > svg') && areaOf(el) < 420 * 220) return true
  return false
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

function polygonCover(el, poly) {
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
  return inside / (n * n)
}

function coverEl(el, poly) {
  return polygonCover(el, poly)
}

function centerInPoly(el, poly) {
  const r = el.getBoundingClientRect()
  return pointInPolygon(r.x + r.width / 2, r.y + r.height / 2, poly)
}

function considerEl(el, frameArea, seen, poly, { minCover = 0.12 } = {}) {
  if (!el || el === el.ownerDocument?.documentElement || el === el.ownerDocument?.body) return
  if (SKIP.has(el.tagName) || isTombstone(el) || decoNode(el) || el.hasAttribute?.('data-markset-shaped-shadow')) return
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
  const cover = polygonCover(target, poly)
  const inPoly = centerInPoly(target, poly)
  const box = aabb(poly)
  const hit = intersectBoxes({ x: r.x, y: r.y, w: r.width, h: r.height }, box)
  const overlap = hit ? (hit.w * hit.h) / Math.max(1, Math.min(r.width * r.height, box.w * box.h)) : 0
  const score = cover + (inPoly ? 0.35 : 0) + overlap * 0.08
  if (!inPoly && cover < minCover && overlap < minCover) return
  const area = r.width * r.height
  const kind =
    isImageEl(target) || (widget && !text)
      ? 'image'
      : text
        ? 'text'
        : widget
          ? 'image'
          : 'text'
  const prev = seen.get(id)
  if (!prev || score > prev.score || (score === prev.score && area < prev.area)) {
    seen.set(id, { el: target, area, kind, cover, overlap, score, inPoly })
  }
}

function dropAncestors(items) {
  return items.filter((h) => !items.some((o) => o.el !== h.el && h.el.contains(o.el)))
}

function tightenHits(items, poly, { loose = false } = {}) {
  if (!items.length) return items
  const minCover = loose ? 0.22 : 0.32
  let picked = items.filter((h) => h.inPoly || h.cover >= minCover)
  if (!picked.length) picked = items.filter((h) => h.inPoly || h.cover >= 0.16 || h.overlap >= 0.28)
  if (!picked.length) {
    picked = [...items].sort((a, b) => b.score - a.score || a.area - b.area).slice(0, 1)
  }
  picked = dropAncestors(picked)
  picked.sort((a, b) => b.score - a.score || a.area - b.area)
  const best = picked[0]
  if (best && (best.inPoly || best.cover >= 0.28)) {
    picked = picked.filter((h) => {
      if (h.el === best.el) return true
      if (h.inPoly && h.cover >= 0.18) return true
      if (h.cover >= Math.max(minCover, best.cover * 0.55)) return true
      return false
    })
  }
  return dropAncestors(picked)
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
  stampIds(doc)
  const poly = toIframePoly(polygon)
  const frameArea = Math.max(1, iframe.clientWidth * iframe.clientHeight)
  const seen = new Map()
  const minCover = loose ? 0.1 : 0.16
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
  if (!seen.size) scanMarked(poly, frameArea, seen, minCover)
  if (loose && !seen.size) scanMarked(inflatePoly(poly, 8), frameArea, seen, 0.12)
  const paintArea = Math.max(1, aabb(poly).w * aabb(poly).h)
  const paintBox = aabb(poly)
  let items = tightenHits([...seen.values()], poly, { loose })
  items = items.flatMap((h) => {
    if (!containsOutsiders(h.el, paintBox)) return [h]
    return significantChildren(h.el)
      .filter((kid) => !decoNode(kid) && (kidInPaint(kid, paintBox) || aimedLeaf(kid, paintBox)))
      .map((kid) => ({
        ...h,
        el: kid,
        area: Math.max(1, areaOf(kid)),
        kind: isGraphicEl(kid) && !isPrimarilyText(kid) ? 'image' : 'text',
        inPoly: centerInPoly(kid, poly),
        cover: polygonCover(kid, poly),
      }))
  })
  items = dropAncestors(items.filter((h) => {
    if (!h?.el || decoNode(h.el)) return false
    if (isGraphicEl(h.el)) return h.inPoly || h.cover >= 0.08 || h.overlap >= 0.12
    return h.area <= paintArea * 10 || h.cover >= 0.4 || h.inPoly
  }))
  const logos = items.filter((h) => looksLikeLogo(h.el) || (isGraphicEl(h.el) && h.area < 220 * 90 && (h.inPoly || kidInPaint(h.el, paintBox))))
  if (logos.length) {
    const seed = logos.sort((a, b) => a.area - b.area)[0]
    items = items.filter((h) => {
      if (h.el === seed.el) return true
      if (seed.el.contains(h.el) || h.el.contains(seed.el)) return h.area <= seed.area * 1.8
      if (isChromeStrip(h.el) || containsStackedStrips(h.el) || h.area > seed.area * 6) return false
      return false
    })
  }
  items.sort((a, b) => (b.inPoly - a.inPoly) || b.cover - a.cover || a.area - b.area)
  items = items.slice(0, loose ? 3 : MAX_HITS)
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
  if (id === 'clear-anno') return executeCircledOp('clear-anno', { label: '去掉批注' }).ok
  return executeCircledOp(annoKind(id) === id ? id : annoKind(id), { label: id === 'highlight' ? '高亮' : '加框' }).ok
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
  return executeCircledOp('shadow', { label: '加阴影' }).ok
}

function similarModules(el) {
  if (!el?.isConnected) return []
  const doc = getDoc()
  if (!doc) return []
  const r = el.getBoundingClientRect()
  const area = Math.max(1, r.width * r.height)
  const cls = distinctiveClass(el)
  const parent = el.parentElement
  const grand = parent?.parentElement
  const out = []
  for (const node of doc.querySelectorAll(el.tagName)) {
    if (node === el || isTombstone(node) || decoNode(node)) continue
    const nr = node.getBoundingClientRect()
    const na = nr.width * nr.height
    if (na < 80 || nr.width < 8 || nr.height < 8) continue
    if (na < area * 0.45 || na > area * 2.2) continue
    if (nr.width < r.width * 0.5 || nr.width > r.width * 2.1) continue
    if (nr.height < r.height * 0.5 || nr.height > r.height * 2.1) continue
    const sameParent = parent && node.parentElement === parent
    const sameGrid = grand && node.parentElement?.parentElement === grand
    const classHit = cls.length && cls.some((c) => node.classList?.contains(c))
    const bothLogo = looksLikeLogo(el) && looksLikeLogo(node)
    const bothImg = isGraphicEl(el) && isGraphicEl(node)
    if (sameParent || sameGrid || classHit || bothLogo || (bothImg && sameGrid)) out.push(node)
    if (out.length >= 24) break
  }
  return uniqueEls(out)
}

export function countSimilarShadowHosts() {
  const host = lastShadowJob?.hostId ? findByWebId(lastShadowJob.hostId) : null
  if (!host) return 0
  return similarModules(host).length
}

export function applySimilarWebShadows() {
  const host = lastShadowJob?.hostId ? findByWebId(lastShadowJob.hostId) : null
  if (!host || !lastShadowJob) return { ok: false, reason: '还没有刚加上的阴影可套用', count: 0 }
  const peers = similarModules(host).filter((el) => el.getAttribute('data-markset-shadow') !== host.getAttribute('data-markset-shadow') || !el.dataset.marksetShadow)
  if (!peers.length) return { ok: false, reason: '没有找到同类模块', count: 0 }
  const before = peers.map((el) => snapshotNode(el))
  let count = 0
  for (const el of peers) {
    if (lastShadowJob.shaped && lastShadowJob.pts?.length >= 6) {
      if (attachShapedShadow(el, lastShadowJob.pts)) count += 1
    } else {
      replaceFilterPart(el, 'shadow', lastShadowJob.css || inferCssShadow(lastShadowJob.pts, el))
      el.dataset.marksetShadow = '1'
      adaptLayout(el, 'shadow')
      count += 1
    }
  }
  if (!count) return { ok: false, reason: '同类模块没能加上阴影', count: 0 }
  recordWebEdit(
    '同类模块加阴影',
    before,
    peers.map((el) => snapshotNode(el)),
  )
  fitHeight()
  return { ok: true, count, message: `已给 ${count} 个同类模块加上同样的阴影。可还原这一处` }
}

export function applyWebReflect() {
  return executeCircledOp('reflect', { label: '加倒影' }).ok
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
  const doc = getDoc()
  if (doc) stampIds(doc)
  const pairs = inferWebLayoutPairs()
  if (!pairs.length) return 0
  const seen = new Set()
  const jobs = []
  for (const pair of pairs) {
    const raw = findByWebId(pair.webId)
    const dest = toIframeRect(pair.dest)
    if (!raw || !dest) continue
    const el = layoutMoveHost(raw, pair)
    const id = el.getAttribute('data-markset-id') || el
    if (seen.has(id)) continue
    seen.add(id)
    jobs.push({ el, dest, before: snapshotPlace(el), beforeEv: evidenceOf(el) })
  }
  if (!jobs.length) return 0
  const modes = ['flow', 'absolute']
  for (const mode of modes) {
    if (mode !== 'flow') {
      for (const job of jobs) applyShot(job.before)
    }
    for (const job of jobs) {
      job.el = (job.before.webId && findByWebId(job.before.webId)) || job.el
      if (!job.el?.isConnected) continue
      if (mode === 'flow') placeElInFlow(job.el, job.dest)
      else moveElToDest(job.el, job.dest, 'absolute')
    }
    if (mode === 'flow') {
      for (const job of jobs) {
        if (job.el?.isConnected) resolveRemainingOverlap(job.el)
      }
    }
    let afterEv = jobs.map((job) => (job.el?.isConnected ? evidenceOf(job.el) : { connected: false, rect: { x: 0, y: 0, w: 0, h: 0 } }))
    let moved = mode === 'flow'
      ? jobs.some((job, i) => layoutFlowChanged(job, afterEv[i]))
      : verifyMove(
        jobs.map((job) => job.beforeEv),
        afterEv,
        jobs.map((job) => job.dest),
      )
    if (mode === 'flow' && !moved) {
      for (const job of jobs) {
        if (!job.el?.isConnected) continue
        placeElInFlow(job.el, job.dest)
      }
      afterEv = jobs.map((job) => (job.el?.isConnected ? evidenceOf(job.el) : { connected: false, rect: { x: 0, y: 0, w: 0, h: 0 } }))
      moved = jobs.some((job, i) => layoutFlowChanged(job, afterEv[i]))
    }
    if (!moved) continue
    recordWebEdit(
      '挪位置',
      jobs.map((job) => job.before),
      jobs.map((job) => snapshotPlace(job.el)),
    )
    fitHeight()
    return jobs.length
  }
  jobs.forEach((job) => applyShot(job.before))
  return 0
}

function layoutMoveHost(el, pair) {
  const srcBox = pair?.sourceRect ? toIframeRect(pair.sourceRect) : null
  let host = el
  let parent = el.parentElement
  for (let i = 0; i < 5 && parent && parent !== parent.ownerDocument?.body; i += 1) {
    if (containsStackedStrips(parent) || isChromeStrip(parent)) break
    if ((parent.children?.length || 0) >= 4) break
    if (srcBox && containsOutsiders(parent, srcBox)) break
    const pr = parent.getBoundingClientRect()
    const cr = host.getBoundingClientRect()
    if (pr.width * pr.height > cr.width * cr.height * 2.6) break
    if (srcBox && !staysInPaint(parent, srcBox) && overlapScore(parent, srcBox).coverEl < 0.55) break
    host = parent
    parent = parent.parentElement
  }
  return host
}

function moveElToDest(el, dest, mode) {
  const src = el.getBoundingClientRect()
  const dx = Math.round(dest.x - src.left)
  const dy = Math.round(dest.y - src.top)
  if (mode === 'absolute') {
    const pos = el.ownerDocument?.defaultView?.getComputedStyle(el)?.position
    if (!pos || pos === 'static') el.style.position = 'absolute'
    else el.style.position = pos === 'fixed' ? 'absolute' : pos
    el.style.left = `${Math.round(dest.x)}px`
    el.style.top = `${Math.round(dest.y)}px`
    el.style.margin = '0'
    el.setAttribute('data-markset-shifted', '1')
    return
  }
  nudgeEl(el, dx, dy)
}

function layoutFlowChanged(job, after) {
  if (!job?.el?.isConnected) return false
  const parentId = job.el.parentElement?.getAttribute('data-markset-id') || ''
  const nextId = job.el.nextElementSibling?.getAttribute('data-markset-id') || ''
  if (parentId !== (job.before?.parentId || '') || nextId !== (job.before?.nextId || '')) return true
  const b = job.beforeEv?.rect
  const a = after?.rect
  if (!b || !a) return false
  return Math.hypot(a.x - b.x, a.y - b.y) > 8
}

function boxOfRect(r) {
  if (!r) return null
  if (r.w != null) return { x: r.x, y: r.y, w: r.w, h: r.h }
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}

function overlapRatio(a, b) {
  const aa = boxOfRect(a)
  const bb = boxOfRect(b)
  if (!aa || !bb) return 0
  const hit = intersectBoxes(aa, bb)
  if (!hit) return 0
  return (hit.w * hit.h) / Math.max(1, bb.w * bb.h)
}

function pageOverlapHits(box, moving) {
  const doc = getDoc()
  if (!doc?.body || !box || !moving) return []
  const out = []
  for (const other of doc.body.querySelectorAll('[data-markset-id]')) {
    if (other === moving || moving.contains(other) || other.contains(moving) || decoNode(other) || SKIP.has(other.tagName)) continue
    const hit = overlapScore(other, box)
    if (hit.coverBox > 0.12 && hit.coverEl > 0.08) out.push(hit)
  }
  return out
}

function keepCardLook(el) {
  const win = el.ownerDocument?.defaultView
  const cs = win?.getComputedStyle(el)
  const r = el.getBoundingClientRect()
  if (!cs) return
  const props = [
    'display', 'flex-direction', 'align-items', 'justify-content', 'gap',
    'padding', 'border', 'border-radius', 'background', 'background-color',
    'box-shadow', 'color', 'font', 'font-size', 'font-weight', 'line-height',
    'text-decoration', 'text-align',
  ]
  for (const prop of props) {
    const val = cs.getPropertyValue(prop)
    if (val) el.style.setProperty(prop, val)
  }
  el.style.boxSizing = 'border-box'
  el.style.width = `${Math.round(r.width)}px`
  el.style.maxWidth = '100%'
  el.style.position = 'relative'
  el.style.left = 'auto'
  el.style.top = 'auto'
  el.style.transform = 'none'
  el.style.margin = '0'
  el.style.zIndex = 'auto'
  el.setAttribute('data-markset-shifted', 'flow')
}

function packParent(el) {
  const parent = el.parentElement
  if (!parent) return null
  const d = parent.ownerDocument?.defaultView?.getComputedStyle(parent)?.display || ''
  return /grid|flex/.test(d) ? parent : null
}

function reorderAmongSiblings(el, dest, parent) {
  const kids = [...parent.children].filter((kid) => kid !== el && !decoNode(kid))
  const midX = dest.x + dest.w / 2
  const midY = dest.y + dest.h / 2
  let best = null
  for (const kid of kids) {
    const r = kid.getBoundingClientRect()
    if (midY < r.top - 8) {
      best = kid
      break
    }
    if (midY <= r.bottom + 8 && midX < r.left + r.width / 2) {
      best = kid
      break
    }
  }
  if (best) parent.insertBefore(el, best)
  else parent.append(el)
  el.setAttribute('data-markset-shifted', 'flow')
}

function findFlowAnchor(dest, moving) {
  const doc = getDoc()
  if (!doc?.body) return null
  const x = dest.x + dest.w / 2
  const y = dest.y + dest.h / 2
  let hit = null
  try {
    hit = doc.elementFromPoint(x, y)
  } catch {
    hit = null
  }
  if (!hit || hit === moving || moving.contains(hit) || decoNode(hit) || hit === doc.body) {
    const scored = pageOverlapHits(dest, moving).sort((a, b) => b.coverBox - a.coverBox)
    hit = scored[0]?.el || null
  }
  if (!hit || hit === doc.body || hit === doc.documentElement) {
    return findBlockBelow(dest, moving)
  }
  while (hit && (hit === moving || moving.contains(hit) || decoNode(hit))) hit = hit.parentElement
  let target = hit
  const frame = iframeBox()
  const frameArea = Math.max(1, (frame?.width || 1) * (frame?.height || 1))
  while (target?.parentElement && target.parentElement !== doc.body) {
    const parent = target.parentElement
    if (parent === moving || moving.contains(parent)) {
      target = parent
      continue
    }
    const pr = parent.getBoundingClientRect()
    if (pr.width * pr.height > frameArea * 0.45) break
    if (containsStackedStrips(parent) || isChromeStrip(parent)) break
    const d = parent.ownerDocument?.defaultView?.getComputedStyle(parent)?.display || ''
    if (d === 'inline' || d === 'contents') break
    target = parent
  }
  return target
}

function findBlockBelow(dest, moving) {
  const doc = getDoc()
  if (!doc?.body) return null
  const blocks = [...doc.body.querySelectorAll('div, section, article, main, aside, header, footer, nav, p, h1, h2, h3, ul, ol, figure')]
  let best = null
  let bestTop = Infinity
  for (const el of blocks) {
    if (el === moving || moving.contains(el) || el.contains(moving) || decoNode(el) || SKIP.has(el.tagName)) continue
    const r = el.getBoundingClientRect()
    if (r.height < 20 || r.width < 40) continue
    if (r.top < dest.y - 4) continue
    if (r.top < bestTop) {
      best = el
      bestTop = r.top
    }
  }
  return best
}

function destHitsSibling(el, dest, parent) {
  if (!parent) return null
  for (const kid of parent.children) {
    if (kid === el || decoNode(kid)) continue
    const r = kid.getBoundingClientRect()
    if (overlapRatio(r, dest) > 0.28) return kid
    const cx = dest.x + dest.w / 2
    const cy = dest.y + dest.h / 2
    if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return kid
  }
  return null
}

function detachMoveSlot(el) {
  const slot = el?.parentElement
  if (!slot?.hasAttribute?.('data-markset-move-slot')) return
  const host = slot.parentElement
  if (!host) return
  host.insertBefore(el, slot)
  slot.remove()
}

function ensureMoveSlot(el) {
  if (el.parentElement?.hasAttribute?.('data-markset-move-slot')) return el.parentElement
  const host = el.parentElement
  const doc = el.ownerDocument
  if (!host || !doc) return null
  const slot = doc.createElement('div')
  slot.setAttribute('data-markset-move-slot', '1')
  host.insertBefore(slot, el)
  slot.append(el)
  stampIds(doc)
  return slot
}

function clampNum(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

function findDestSlot(el, dest) {
  const pack = packParent(el)
  const parent = pack?.parentElement || el.parentElement
  if (!parent) return null
  const destMid = dest.y + dest.h / 2
  const kids = [...parent.children].filter((kid) => kid !== el && !decoNode(kid) && !kid.hasAttribute?.('data-markset-move-slot'))
  let before = null
  for (const kid of kids) {
    const r = kid.getBoundingClientRect()
    if (destMid < r.top + r.height / 2) {
      before = kid
      break
    }
  }
  return { parent, before }
}

function alignMovedElToDest(el, dest) {
  const slot = el.parentElement?.hasAttribute?.('data-markset-move-slot') ? el.parentElement : el
  const host = slot.parentElement
  if (!host) return
  const hr = host.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  const cs = el.ownerDocument.defaultView.getComputedStyle(el)
  const curML = parseFloat(cs.marginLeft) || 0
  const curMT = parseFloat(cs.marginTop) || 0
  const wantX = dest.x + dest.w / 2 - r.width / 2
  const wantY = dest.y + dest.h / 2 - r.height / 2
  const maxLeft = Math.max(0, hr.right - hr.left - r.width - 8)
  const nextML = clampNum(curML + (wantX - r.left), 0, maxLeft)
  el.style.marginLeft = `${Math.round(nextML)}px`
  el.style.marginRight = 'auto'

  const prev = slot.previousElementSibling
  const next = slot.nextElementSibling
  const minTop = (prev ? prev.getBoundingClientRect().bottom : hr.top) + 8
  const r2 = el.getBoundingClientRect()
  const maxTop = next ? next.getBoundingClientRect().top - r2.height - 8 : wantY + r2.height
  const wantTop = clampNum(wantY, minTop, Number.isFinite(maxTop) ? maxTop : wantY)
  const dy = wantTop - r2.top
  if (Math.abs(dy) >= 1) el.style.marginTop = `${Math.round(curMT + dy)}px`
  el.style.marginBottom = '12px'
}

function placeElInFlow(el, dest) {
  detachMoveSlot(el)
  const originParent = el.parentElement
  const originNext = el.nextElementSibling
  const pack = packParent(el)
  const sibling = pack ? destHitsSibling(el, dest, pack) : null
  if (sibling) {
    reorderAmongSiblings(el, dest, pack)
    if (el.parentElement !== originParent || el.nextElementSibling !== originNext) return
  }
  keepCardLook(el)
  const slotAt = findDestSlot(el, dest)
  if (slotAt?.parent) slotAt.parent.insertBefore(el, slotAt.before || null)
  else el.ownerDocument?.body?.append(el)
  ensureMoveSlot(el)
  alignMovedElToDest(el, dest)
}

function resolveRemainingOverlap(el) {
  const slot = el.parentElement?.hasAttribute?.('data-markset-move-slot') ? el.parentElement : el
  const next = slot.nextElementSibling
  if (!next || decoNode(next)) return
  const r = slot.getBoundingClientRect()
  const nr = next.getBoundingClientRect()
  if (r.bottom > nr.top + 2) {
    const cur = parseFloat(slot.style.marginBottom) || 0
    slot.style.marginBottom = `${Math.round(cur + r.bottom - nr.top + 12)}px`
  }
}

function decoNode(el) {
  return Boolean(
    el?.hasAttribute?.('data-markset-shaped-shadow') ||
      el?.hasAttribute?.('data-markset-tombstone') ||
      el?.hasAttribute?.('data-markset-badge-host') ||
      el?.hasAttribute?.('data-markset-edit-badge'),
  )
}

function evidenceChanged(before, after) {
  if (!after) return false
  if (!before) return true
  if (after.connected !== before.connected) return true
  if (after.html !== before.html || after.text !== before.text) return true
  if (after.color !== before.color || after.bg !== before.bg || after.filter !== before.filter) return true
  if (after.transform !== before.transform || after.fontSize !== before.fontSize || after.fontWeight !== before.fontWeight) return true
  if (after.anno !== before.anno || after.shadow !== before.shadow || after.reflect !== before.reflect) return true
  const br = before.rect || { x: 0, y: 0, w: 0, h: 0 }
  const ar = after.rect || { x: 0, y: 0, w: 0, h: 0 }
  if (Math.hypot(ar.x - br.x, ar.y - br.y) > 3) return true
  const ba = Math.max(1, br.w * br.h)
  if (Math.abs(ar.w * ar.h - ba) / ba > 0.04) return true
  return false
}

function evidenceOf(el) {
  if (!el?.isConnected) {
    return {
      connected: false,
      rect: { x: 0, y: 0, w: 0, h: 0 },
      color: '',
      bg: '',
      filter: '',
      transform: '',
      fontSize: '',
      anno: '',
      reflect: '',
      html: '',
      text: '',
    }
  }
  const r = el.getBoundingClientRect()
  const cs = el.ownerDocument.defaultView.getComputedStyle(el)
  return {
    connected: true,
    rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    color: cs.color,
    bg: cs.backgroundColor,
    filter: cs.filter,
    transform: cs.transform,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    anno: el.getAttribute('data-markset-anno') || '',
    reflect: el.style.webkitBoxReflect || '',
    html: el.outerHTML.slice(0, 2800),
    text: String(el.innerText || '').slice(0, 80),
    shadow: el.getAttribute('data-markset-shadow') || '',
  }
}

function verifyKind(kind, befores, afters) {
  if (!afters.length) return false
  if (afters.some((a, i) => evidenceChanged(befores[i], a))) return true
  if (kind.startsWith('delete') && kind !== 'delete-deco' && kind !== 'clear-deco') {
    return afters.some((a, i) => !a.connected || a.rect.w * a.rect.h < Math.max(1, (befores[i]?.rect.w || 0) * (befores[i]?.rect.h || 0)) * 0.25)
  }
  if (kind === 'scheme' || String(kind).startsWith('color')) {
    return afters.some((a, i) => a.color !== befores[i]?.color || a.bg !== befores[i]?.bg || a.filter !== befores[i]?.filter || a.html !== befores[i]?.html)
  }
  if (kind === 'scale-down') {
    return afters.some((a, i) => {
      const ba = Math.max(1, (befores[i]?.rect.w || 0) * (befores[i]?.rect.h || 0))
      const aa = a.rect.w * a.rect.h
      const fs0 = parseFloat(befores[i]?.fontSize) || 0
      const fs1 = parseFloat(a.fontSize) || 0
      return aa < ba * 0.92 || (fs0 && fs1 && fs1 < fs0 * 0.92)
    })
  }
  if (kind === 'scale-up') {
    return afters.some((a, i) => {
      const ba = Math.max(1, (befores[i]?.rect.w || 0) * (befores[i]?.rect.h || 0))
      return a.rect.w * a.rect.h > ba * 1.08 || parseFloat(a.fontSize) > (parseFloat(befores[i]?.fontSize) || 0) * 1.08
    })
  }
  if (kind === 'shadow') {
    return afters.some((a, i) => {
      const b = befores[i]
      if (a.filter !== b?.filter && /drop-shadow/i.test(a.filter || '')) return true
      if ((a.shadow || '') !== (b?.shadow || '')) return true
      if (/data-markset-shaped-shadow/.test(a.html || '') && !/data-markset-shaped-shadow/.test(b?.html || '')) return true
      if (/data-markset-shaped-shadow/.test(a.html || '') && a.html !== b?.html) return true
      return Boolean(a.shadow)
    })
  }
  if (kind === 'reflect') return afters.some((a) => Boolean(a.reflect))
  if (kind === 'frame' || kind === 'box' || kind === 'circle' || kind === 'highlight' || kind === 'bold' || kind === 'underline' || kind === 'wavy' || kind === 'strike' || String(kind).startsWith('line')) {
    return afters.some((a, i) => a.anno !== befores[i]?.anno || a.fontWeight !== befores[i]?.fontWeight || a.html !== befores[i]?.html || Boolean(a.anno))
  }
  if (String(kind).startsWith('nudge') || kind === 'move-nudge' || kind === 'move-layout') {
    return afters.some((a, i) => Math.hypot(a.rect.x - (befores[i]?.rect.x || 0), a.rect.y - (befores[i]?.rect.y || 0)) > 6)
  }
  if (kind === 'clear-deco' || kind === 'delete-deco' || kind === 'clear-anno' || kind === 'soften') {
    return afters.some((a, i) => a.filter !== befores[i]?.filter || a.anno !== befores[i]?.anno || a.reflect !== befores[i]?.reflect || a.html !== befores[i]?.html)
  }
  return afters.some((a, i) => evidenceChanged(befores[i], a))
}

function verifyMove(befores, afters, dests) {
  return afters.some((a, i) => {
    const b = befores[i]
    const dest = dests[i]
    if (!a?.connected || !b) return false
    const moved = Math.hypot(a.rect.x - b.rect.x, a.rect.y - b.rect.y) > 3
    if (moved) return true
    if (!dest) return false
    const beforeDist = Math.hypot(b.rect.x - dest.x, b.rect.y - dest.y)
    const afterDist = Math.hypot(a.rect.x - dest.x, a.rect.y - dest.y)
    return afterDist < beforeDist - 4
  })
}

function textNodesOf(el) {
  const nodes = []
  if (!el) return nodes
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    if (String(walker.currentNode.nodeValue || '').trim()) nodes.push(walker.currentNode)
  }
  return nodes
}

function replaceText(el, fromText, toText) {
  if (!el) return false
  const next = String(toText ?? '')
  if (!next) return false
  const from = String(fromText || '').trim()
  const live = textOf(el)
  if (live === next.replace(/\s+/g, ' ').trim()) return false
  const nodes = textNodesOf(el)
  if (from) {
    let did = false
    for (const node of nodes) {
      if (node.nodeValue.includes(from)) {
        node.nodeValue = node.nodeValue.split(from).join(next)
        did = true
      }
    }
    if (did) return true
  }
  if (nodes.length === 1) {
    nodes[0].nodeValue = next
    return true
  }
  const simple = /^(A|P|H1|H2|H3|H4|H5|H6|SPAN|LI|TD|TH|BUTTON|LABEL|FIGCAPTION|STRONG|EM|B|I|DIV|SECTION)$/.test(el.tagName)
  if (simple || !el.querySelector?.('p, li, h1, h2, h3, h4, ul, ol, table')) {
    el.textContent = next
    return true
  }
  if (nodes.length) {
    nodes[0].nodeValue = next
    for (let i = 1; i < nodes.length; i += 1) nodes[i].nodeValue = ''
    return true
  }
  el.textContent = next
  return true
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
    el.dataset.marksetTint = fill
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

function centerInPaint(el, box) {
  const r = el.getBoundingClientRect()
  const cx = r.x + r.width / 2
  const cy = r.y + r.height / 2
  return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h
}

function currentPaintPolys() {
  try {
    return (drawingPolys() || []).map((p) => toIframePoly(p)).filter((p) => p?.length >= 3)
  } catch {
    return []
  }
}

function paintCover(el, polys) {
  if (!el || !polys?.length) return 0
  return polys.reduce((best, poly) => Math.max(best, polygonCover(el, poly)), 0)
}

function kidInPaint(el, box, polys = currentPaintPolys()) {
  if (!el) return false
  if (polys.length) {
    if (polys.some((poly) => centerInPoly(el, poly))) return true
    return paintCover(el, polys) >= 0.46
  }
  if (!box) return false
  return centerInPaint(el, box) || overlapScore(el, box).coverEl >= 0.5
}

function significantChildren(el) {
  return [...(el?.children || [])].filter((kid) => {
    if (!kid || SKIP.has(kid.tagName) || decoNode(kid) || isTombstone(kid)) return false
    const r = kid.getBoundingClientRect()
    if (r.width < 8 || r.height < 6) return false
    if (isWidgetEl(kid) || isGraphicEl(kid) || isTextEl(kid)) return true
    if (r.width * r.height >= 12 * 10) return true
    return textOf(kid).length >= 2 || kid.children?.length > 0
  })
}

function containsOutsiders(el, box, polys = currentPaintPolys()) {
  if (!el || (!box && !polys.length)) return false
  if (containsStackedStrips(el)) {
    const iframe = frameEl()
    const fw = iframe?.clientWidth || 0
    const strips = significantChildren(el).filter((kid) => {
      if (isChromeStrip(kid)) return true
      const r = kid.getBoundingClientRect()
      return fw && r.width > fw * 0.58 && r.height < 110 && r.height > 16
    })
    const inside = strips.filter((kid) => kidInPaint(kid, box, polys))
    if (inside.length >= 1 && inside.length < strips.length) return true
  }
  const kids = significantChildren(el)
  if (kids.length < 2) return false
  const insiders = kids.filter((kid) => kidInPaint(kid, box, polys))
  const outsiders = kids.filter((kid) => !kidInPaint(kid, box, polys))
  return insiders.length >= 1 && outsiders.length >= 1
}

function keepPaintTargets(els, box) {
  const live = uniqueEls((els || []).filter((el) => el?.isConnected && el !== el.ownerDocument?.body))
  if (!live.length) return []
  if (!box) return dropCoveringAncestors(live)
  const polys = currentPaintPolys()
  const drill = (el) => {
    if (!containsOutsiders(el, box, polys)) return [el]
    const kids = significantChildren(el).filter((kid) => aimedLeaf(kid, box) || kidInPaint(kid, box, polys))
    return kids.length ? kids.flatMap(drill) : []
  }
  const drilled = uniqueEls(live.flatMap(drill)).filter((el) => !containsOutsiders(el, box, polys))
  const inInk = drilled.filter((el) => kidInPaint(el, box, polys))
  if (inInk.length) return dropCoveringAncestors(inInk)
  const aimed = drilled.filter((el) => aimedLeaf(el, box))
  if (aimed.length) return dropCoveringAncestors(aimed)
  const centered = drilled.filter((el) => centerInPaint(el, box) && overlapScore(el, box).coverEl >= 0.28)
  if (centered.length) return dropCoveringAncestors(centered)
  return dropCoveringAncestors(drilled)
}

function staysInPaint(el, box) {
  if (!el || !box) return false
  const polys = currentPaintPolys()
  if (containsOutsiders(el, box, polys)) return false
  if (polys.length) {
    const cover = paintCover(el, polys)
    if (cover < 0.55) return false
    if (!polys.some((poly) => centerInPoly(el, poly)) && cover < 0.78) return false
    return true
  }
  const hit = overlapScore(el, box)
  if (hit.coverEl < 0.6) return false
  if (!centerInPaint(el, box) && hit.coverEl < 0.82) return false
  if (hit.extraTop > Math.max(16, box.h * 0.1)) return false
  if (hit.extraBottom > Math.max(28, box.h * 0.16)) return false
  if (hit.extraLeft > Math.max(28, box.w * 0.1) && hit.extraRight > Math.max(28, box.w * 0.1) && hit.coverEl < 0.78) {
    return false
  }
  return true
}

function aimedLeaf(el, box) {
  const polys = currentPaintPolys()
  if (containsOutsiders(el, box, polys)) return false
  if (polys.length) {
    const cover = paintCover(el, polys)
    if (polys.some((poly) => centerInPoly(el, poly))) return cover >= 0.12
    return cover >= 0.4 || (isGraphicEl(el) && cover >= 0.2)
  }
  const hit = overlapScore(el, box)
  if (centerInPaint(el, box)) return hit.coverEl >= 0.18
  return hit.coverEl >= 0.45 || (isGraphicEl(el) && hit.coverEl >= 0.22)
}

function scanOverlapEls(box) {
  const doc = getDoc()
  const iframe = frameEl()
  if (!doc?.body || !iframe) return []
  const frameArea = Math.max(1, iframe.clientWidth * iframe.clientHeight)
  const polys = currentPaintPolys()
  const out = []
  for (const el of doc.querySelectorAll('[data-markset-id]')) {
    if (SKIP.has(el.tagName) || isTombstone(el) || el === doc.body || el === doc.documentElement) continue
    const hit = overlapScore(el, box)
    if (hit.area > frameArea * 0.82) continue
    if (hit.coverBox < 0.035 && hit.coverEl < 0.1) continue
    if (containsOutsiders(el, box, polys)) continue
    if (polys.length && !kidInPaint(el, box, polys) && hit.coverEl < 0.4) continue
    out.push(hit)
  }
  return out
}

function pickModuleEl(hits, box, frameArea) {
  const paintArea = Math.max(1, box.w * box.h)
  const logo = [...hits]
    .filter((h) => {
      if (!(looksLikeLogo(h.el) || (isGraphicEl(h.el) && h.area < 240 * 110))) return false
      return kidInPaint(h.el, box) || h.coverEl >= 0.28
    })
    .sort((a, b) => a.area - b.area)[0]
  if (logo && paintArea < frameArea * 0.12) return logo.el
  const ranked = hits
    .filter((h) => {
      if (containsStackedStrips(h.el) || (isChromeStrip(h.el) && paintArea < h.area * 0.45)) return false
      return staysInPaint(h.el, box) && h.coverBox >= 0.4 && h.area < frameArea * 0.55 && h.area > paintArea * 0.22
    })
    .sort((a, b) => Math.abs(a.area - paintArea) - Math.abs(b.area - paintArea) || b.coverEl - a.coverEl)
  if (ranked[0]) return ranked[0].el
  const seeds = hits.filter((h) => h.coverEl >= 0.35).sort((a, b) => a.area - b.area).slice(0, 12)
  let best = null
  for (const seed of seeds) {
    let parent = seed.el
    for (let i = 0; i < 6 && parent && parent !== parent.ownerDocument?.body; i += 1) {
      if (containsStackedStrips(parent) || isChromeStrip(parent)) break
      const hit = overlapScore(parent, box)
      if (staysInPaint(parent, box) && hit.coverBox >= 0.45 && hit.area < frameArea * 0.55) {
        if (!best || hit.area > overlapScore(best, box).area) best = parent
      }
      parent = parent.parentElement
    }
  }
  return best || logo?.el || null
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

function leafEls(hits, box) {
  return uniqueEls(
    hits
      .filter((h) => (isGraphicEl(h.el) || isTextEl(h.el)) && h.coverEl >= 0.28 && (!box || aimedLeaf(h.el, box)))
      .sort((a, b) => a.area - b.area)
      .slice(0, 24)
      .map((h) => h.el),
  )
}

function hasMarksetDeco(el) {
  if (!el) return false
  return Boolean(
    el.hasAttribute?.('data-markset-anno') ||
      el.dataset?.marksetShadow ||
      el.dataset?.marksetReflect ||
      el.dataset?.marksetTint ||
      el.dataset?.marksetBg ||
      el.hasAttribute?.('data-markset-shifted') ||
      el.hasAttribute?.('data-markset-scaled'),
  )
}

function decoEls(hits, box, doc) {
  const fromHits = (hits || [])
    .filter((h) => hasMarksetDeco(h.el) && (centerInPaint(h.el, box) || h.coverEl >= 0.35))
    .map((h) => h.el)
  const marked = [...(doc?.body?.querySelectorAll('[data-markset-anno], [data-markset-shadow], [data-markset-reflect], [data-markset-tint], [data-markset-bg], [data-markset-shifted], [data-markset-scaled]') || [])]
    .filter((el) => aimedLeaf(el, box) || overlapScore(el, box).coverEl >= 0.35)
  return uniqueEls([...fromHits, ...marked])
}

function stripDeco(el, { soften = false } = {}) {
  let changed = false
  if (el.hasAttribute('data-markset-anno')) {
    if (soften && el.getAttribute('data-markset-anno') === 'highlight') {
      el.style.background = 'rgba(255, 226, 80, 0.22)'
    } else {
      el.removeAttribute('data-markset-anno')
    }
    changed = true
  }
  if (el.dataset.marksetShadow) {
    const next = soften
      ? 'drop-shadow(3px 4px 4px rgba(36, 24, 14, 0.22))'
      : String(el.style.filter || '').replace(/drop-shadow\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
    el.style.filter = next
    if (!soften) {
      delete el.dataset.marksetShadow
      if (el.getAttribute('data-markset-flow') === 'shadow') adaptLayout(el, 'clear')
    }
    changed = true
  }
  if (el.dataset.marksetReflect && !soften) {
    el.style.webkitBoxReflect = ''
    delete el.dataset.marksetReflect
    if (el.getAttribute('data-markset-flow') === 'reflect') adaptLayout(el, 'clear')
    changed = true
  }
  if (el.dataset.marksetTint && !soften) {
    el.style.filter = String(el.style.filter || '')
      .replace(/sepia\([^)]*\)|saturate\([^)]*\)|hue-rotate\([^)]*\)|brightness\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    delete el.dataset.marksetTint
    changed = true
  }
  if (el.dataset.marksetBg && !soften) {
    el.style.backgroundColor = el.dataset.marksetOrigBg || ''
    delete el.dataset.marksetBg
    changed = true
  }
  return changed
}

function setTextScale(el, factor) {
  let cur = Number(el.dataset.marksetFont)
  if (!Number.isFinite(cur) || cur <= 0) {
    try {
      cur = parseFloat(el.ownerDocument?.defaultView?.getComputedStyle(el)?.fontSize) || 16
    } catch {
      cur = 16
    }
    el.dataset.marksetFont = String(cur)
  }
  const next = Math.max(10, Math.min(96, cur * factor))
  el.style.fontSize = `${next.toFixed(1)}px`
  el.dataset.marksetFont = String(next)
}

function isPrimarilyText(el) {
  return isTextEl(el) && !isGraphicEl(el) && !hasPaintedBg(el)
}

function scaleOne(el, factor) {
  if (isPrimarilyText(el)) setTextScale(el, factor)
  else setElScale(el, factor)
}

function replaceFilterPart(el, kind, nextCss) {
  const raw = String(el.style.filter || '')
  const cleaned = kind === 'shadow'
    ? raw.replace(/drop-shadow\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
    : raw
  el.style.filter = `${cleaned} ${nextCss}`.trim()
}

function nudgeEl(el, dx, dy) {
  const prev = el.style.transform || ''
  const m = prev.match(/translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/)
  const x = (m ? Number(m[1]) : 0) + dx
  const y = (m ? Number(m[2]) : 0) + dy
  const rest = prev.replace(/translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/, '').trim()
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)${rest ? ` ${rest}` : ''}`
  el.setAttribute('data-markset-shifted', '1')
  const pos = el.ownerDocument?.defaultView?.getComputedStyle(el)?.position
  if (!pos || pos === 'static') el.style.position = 'relative'
}

function nudgeDelta(op, label) {
  const t = String(label || op || '')
  const m = t.match(/(\d+)\s*(px|像素)?/)
  const step = m ? Math.min(160, Math.max(8, Number(m[1]))) : 28
  if (op === 'nudge-left' || /往左|向左|左移|向左挪/.test(t)) return [-step, 0]
  if (op === 'nudge-right' || /往右|向右|右移|向右挪/.test(t)) return [step, 0]
  if (op === 'nudge-up' || /往上|向上|上移|往上挪/.test(t)) return [0, -step]
  if (op === 'nudge-down' || /往下|向下|下移|往下挪/.test(t)) return [0, step]
  return [0, 0]
}

function colorModeOf(kind, label) {
  const t = String(label || '')
  if (kind === 'color-bg' || /底色|背景色|背景改成|改背景/.test(t)) return 'bg'
  if (kind === 'color-text' || /字色|文字颜色|字体颜色|只改字/.test(t)) return 'text'
  if (kind === 'color-image' || (/只改(图|logo|图标)/.test(t) && /色/.test(t))) return 'image'
  return 'auto'
}

function colorTargets(els, box, mode) {
  const expanded = uniqueEls(els.flatMap((el) => collectColorable(el)))
  return expanded.filter((el) => {
    if (!aimedLeaf(el, box)) return false
    if (mode === 'bg') return true
    if (mode === 'text') return isPrimarilyText(el)
    if (mode === 'image') return isGraphicEl(el)
    return isGraphicEl(el) || isTextEl(el)
  })
}

function pickSchemeWrap(els, box) {
  const live = uniqueEls((els || []).filter((el) => el?.isConnected && el !== el.ownerDocument?.body))
  if (!live.length) return null
  const frameArea = Math.max(1, (frameEl()?.clientWidth || 1) * (frameEl()?.clientHeight || 1))
  if (box) {
    const parent = commonCoveringParent(live, box, frameArea)
    if (parent && staysInPaint(parent, box)) return parent
  }
  return live.slice().sort((a, b) => areaOf(b) - areaOf(a))[0] || live[0]
}

function applyBgColor(el, name) {
  const fill = colorFill(name) || name
  if (!fill) return
  if (el.dataset.marksetOrigBg == null) el.dataset.marksetOrigBg = el.style.backgroundColor || ''
  el.style.backgroundColor = fill
  el.dataset.marksetBg = fill
}

function pickContentEls(hits, box, frameArea, { large, kind } = {}) {
  let els = []
  if (large) {
    const mod = pickModuleEl(hits, box, frameArea)
    if (mod && staysInPaint(mod, box)) els = [mod]
    if (!els.length) els = blockEls(hits, box)
  }
  if (!els.length) {
    els = leafEls(hits, box)
    if (kind === 'delete-image' || kind === 'color-image') els = els.filter((el) => isGraphicEl(el))
    if (kind === 'delete-text' || kind === 'color-text') els = els.filter((el) => isPrimarilyText(el))
  }
  if (els.length >= 3) {
    const parent = commonCoveringParent(els, box, frameArea)
    if (parent && staysInPaint(parent, box)) els = [parent]
  }
  return uniqueEls(els).filter((el) => staysInPaint(el, box) || aimedLeaf(el, box))
}

function pickScaleEls(hits, box, frameArea, large) {
  const leaves = leafEls(hits, box)
  const graphics = leaves.filter((el) => isGraphicEl(el))
  const texts = leaves.filter((el) => isPrimarilyText(el))
  if (graphics.length && texts.length) {
    const vis = pickVisualEls([...graphics, ...texts], box)
    if (vis.length) return vis
  }
  if (large) {
    const mod = pickModuleEl(hits, box, frameArea)
    if (mod && staysInPaint(mod, box) && graphics.length + texts.length >= 2) return [mod]
  }
  if (graphics.length && !texts.length) {
    const vis = pickVisualEls(graphics, box).filter((el) => aimedLeaf(el, box) || staysInPaint(el, box) || overlapScore(el, box).coverEl >= 0.18)
    return vis.length ? vis : graphics.slice(0, 3)
  }
  if (texts.length && !graphics.length) return texts.slice(0, 8)
  return leaves.slice(0, 8)
}

function pickDecorEls(hits, box, frameArea, large, graphicOnly) {
  if (graphicOnly) {
    const graphics = leafEls(hits, box).filter((el) => isGraphicEl(el))
    const vis = pickVisualEls(graphics, box).filter((el) => aimedLeaf(el, box) || staysInPaint(el, box))
    if (vis.length) return vis
    if (graphics.length) return graphics.slice(0, 3)
  }
  if (large) {
    const mod = pickModuleEl(hits, box, frameArea)
    if (mod && staysInPaint(mod, box)) return [mod]
  }
  const leaves = leafEls(hits, box)
  return leaves.length ? leaves : pickContentEls(hits, box, frameArea, { large, kind: '' })
}

function viewportPolyFromBox(box) {
  const frame = iframeBox()
  if (!frame || !box) return []
  const x = box.x + frame.left
  const y = box.y + frame.top
  return [
    { x, y },
    { x: x + box.w, y },
    { x: x + box.w, y: y + box.h },
    { x, y: y + box.h },
  ]
}

function elsFromKnownSpans(box) {
  return uniqueEls(
    getSnapshot()
      .spans.filter((s) => s.webId && (s.kind === 'image' || s.kind === 'text'))
      .map((s) => findByWebId(s.webId))
      .filter((el) => {
        if (!el?.isConnected) return false
        if (!box) return true
        const hit = overlapScore(el, box)
        return hit.coverEl >= 0.08 || centerInPaint(el, box) || hit.coverBox >= 0.04
      }),
  )
}

function fallbackEls(box, kind) {
  const preferGraphic = /scale|color-image|shadow|reflect|delete-image/.test(String(kind))
  const preferText = /color-text|delete-text/.test(String(kind))
  let els = elsFromKnownSpans(box)
  if (!els.length) {
    els = scanOverlapEls(box)
      .filter((h) => {
        if (!(isGraphicEl(h.el) || isTextEl(h.el) || isWidgetEl(h.el))) return false
        return h.coverEl >= 0.1 || (centerInPaint(h.el, box) && h.coverBox >= 0.03)
      })
      .sort((a, b) => b.coverEl - a.coverEl || a.area - b.area)
      .slice(0, 8)
      .map((h) => h.el)
  }
  if (!els.length && box) {
    const hits = hitWebDoc(viewportPolyFromBox(box), { loose: true })
    els = [...(hits.images?.found || []), ...(hits.texts?.found || [])]
      .map((s) => findByWebId(s.webId))
      .filter(Boolean)
  }
  els = uniqueEls([...els, ...editTargetEls()])
  if (preferGraphic) {
    const vis = pickVisualEls(
      els.filter((el) => isGraphicEl(el) || isWidgetEl(el)),
      box,
    )
    if (vis.length) return keepPaintTargets(vis, box)
  }
  if (preferText) {
    const texts = els.filter((el) => isPrimarilyText(el))
    if (texts.length) return keepPaintTargets(texts, box)
  }
  const vis = pickVisualEls(els, box)
  return keepPaintTargets(vis.length ? vis : els.slice(0, 4), box)
}

export function resolveCircledEls(kind = '') {
  const polys = lassoPolys()
  const box = iframeUnionBox(polys)
  const found = []
  for (const poly of polys) {
    if (!poly?.length) continue
    const hits = hitWebDoc(poly, { loose: true })
    for (const s of [...(hits.images?.found || []), ...(hits.texts?.found || [])]) {
      const el = findByWebId(s.webId)
      if (el?.isConnected) found.push(el)
    }
  }
  if (box) found.push(...elsFromKnownSpans(box))
  found.push(...editTargetEls())
  let els = uniqueEls(found).filter((el) => el?.isConnected && el !== el.ownerDocument?.body)
  if (!els.length && box) els = fallbackEls(box, kind)
  const graphics = els.filter((el) => isGraphicEl(el) || isWidgetEl(el))
  const texts = els.filter((el) => isPrimarilyText(el))
  const k = String(kind)
  if (/delete-image|color-image|shadow|reflect/.test(k)) {
    const vis = pickVisualEls(graphics, box)
    return keepPaintTargets(vis.length ? vis : graphics.slice(0, 3), box)
  }
  if (/delete-text|color-text/.test(k)) return keepPaintTargets(texts.slice(0, 8), box)
  if (k === 'scale-down' || k === 'scale-up') {
    if (graphics.length) {
      const vis = pickVisualEls([...graphics, ...texts], box)
      return keepPaintTargets(vis.length ? vis : graphics.slice(0, 3), box)
    }
    return keepPaintTargets(texts.slice(0, 8), box)
  }
  if (k === 'color' || k === 'color-bg' || k === 'scheme') {
    const vis = pickVisualEls(graphics, box)
    return keepPaintTargets(uniqueEls([...(vis.length ? vis : graphics), ...texts]), box)
  }
  return keepPaintTargets(uniqueEls([...graphics, ...texts, ...els]), box)
}

function gatherEls(kind, title, box, hits, frameArea, large) {
  let els = resolveCircledEls(kind)
  const doc = getDoc()
  if (!els.length) {
    if (kind === 'delete-deco' || kind === 'clear-deco' || kind === 'clear-anno' || kind === 'soften') {
      els = decoEls(hits, box, doc)
      if (kind === 'clear-anno') els = els.filter((el) => el.hasAttribute('data-markset-anno'))
      if (!els.length) els = pickDecorEls(hits, box, frameArea, large, true)
    } else if (kind.startsWith('delete')) {
      if (kind === 'delete-image') {
        els = leafEls(hits, box).filter((el) => isGraphicEl(el) || hasPaintedBg(el))
        if (!els.length) els = pickContentEls(hits, box, frameArea, { large, kind }).filter((el) => isGraphicEl(el) || hasPaintedBg(el))
      } else if (kind === 'delete-text') {
        els = leafEls(hits, box).filter((el) => isPrimarilyText(el))
        if (!els.length) els = pickContentEls(hits, box, frameArea, { large, kind }).filter((el) => isPrimarilyText(el))
      } else {
        els = pickContentEls(hits, box, frameArea, { large, kind })
      }
    } else if (kind === 'color' || kind === 'color-bg' || kind === 'color-text' || kind === 'color-image' || kind === 'scheme') {
      const mode = colorModeOf(kind, title)
      els = leafEls(hits, box)
      if (mode === 'text') els = els.filter((el) => isPrimarilyText(el))
      else if (mode === 'image') els = els.filter((el) => isGraphicEl(el))
      else if (mode === 'bg') {
        const mod = large ? pickModuleEl(hits, box, frameArea) : null
        els = mod && staysInPaint(mod, box) ? [mod] : leafEls(hits, box)
      }
      if (!els.length) els = pickContentEls(hits, box, frameArea, { large, kind })
    } else if (kind === 'scale-down' || kind === 'scale-up') {
      els = pickScaleEls(hits, box, frameArea, large)
    } else if (kind === 'shadow' || kind === 'reflect') {
      els = pickDecorEls(hits, box, frameArea, false, true)
      if (!els.length) els = pickDecorEls(hits, box, frameArea, large, false)
      if (!els.length && kind === 'shadow') {
        const near = nearestToBox(box)
        if (near) els = [near]
      }
    } else if (kind.startsWith('nudge-') || kind === 'move-nudge') {
      els = pickContentEls(hits, box, frameArea, { large, kind: '' })
    } else {
      els = pickDecorEls(hits, box, frameArea, large, false)
    }
  }
  els = uniqueEls(els).filter((el) => el.isConnected && el !== doc?.body)
  if (!els.length) els = fallbackEls(box, kind)
  return keepPaintTargets(
    uniqueEls(els).filter((el) => el?.isConnected && el !== doc?.body),
    box,
  )
}

function elsByStrategy(kind, title, box, hits, frameArea, large, strategy) {
  const base = gatherEls(kind, title, box, hits, frameArea, large)
  if (strategy === 'circled') return base
  if (strategy === 'tight') {
    const vis = pickVisualEls(base, box)
    return vis.length ? vis.slice(0, 2) : base.slice(0, 1)
  }
  if (strategy === 'graphics') {
    const g = base.filter((el) => isGraphicEl(el) || isWidgetEl(el))
    return g.length ? g : base
  }
  if (strategy === 'texts') {
    const t = base.filter((el) => isPrimarilyText(el))
    return t.length ? t : base
  }
  if (strategy === 'module') {
    const mod = pickModuleEl(hits, box, frameArea)
    return mod ? [mod] : base.slice(0, 1)
  }
  if (strategy === 'fallback') return fallbackEls(box, kind)
  return base
}

function nearestToBox(box) {
  if (!box) return null
  const doc = getDoc()
  const iframe = frameEl()
  if (!doc) return null
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const limit = Math.max(160, Math.max(box.w, box.h) + 180)
  const frameArea = Math.max(1, (iframe?.clientWidth || 1) * (iframe?.clientHeight || 1))
  let best = null
  let bestD = limit
  for (const el of doc.querySelectorAll('[data-markset-id]')) {
    if (SKIP.has(el.tagName) || isTombstone(el) || isTombstone(el.parentElement)) continue
    if (el === doc.body || el === doc.documentElement) continue
    if (el.hasAttribute('data-markset-shaped-shadow')) continue
    if (!isGraphicEl(el) && !isWidgetEl(el) && !isTextEl(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width * r.height > frameArea * 0.55) continue
    const d = Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy)
    if (d < bestD) {
      best = el
      bestD = d
    }
  }
  return best
}

function paintStrokes() {
  return (getPaintMarks() || []).filter((m) => m?.points?.length >= 6 && !isHandwritingPaint(m))
}

function moduleCoveredByPaint(el, box) {
  if (!el || !box) return false
  const hit = overlapScore(el, box)
  return centerInPaint(el, box) && hit.coverEl >= 0.52
}

function paintIsAroundModule(el, box) {
  if (!el || !box) return true
  const hit = overlapScore(el, box)
  const r = el.getBoundingClientRect()
  const pcx = box.x + box.w / 2
  const pcy = box.y + box.h / 2
  const ecx = r.left + r.width / 2
  const ecy = r.top + r.height / 2
  const beside = Math.hypot(pcx - ecx, pcy - ecy) > Math.max(r.width, r.height) * 0.4
  if (!centerInPaint(el, box) && hit.coverEl < 0.72) return true
  if (hit.coverEl < 0.42) return true
  if (beside && hit.coverEl < 0.62) return true
  return false
}

function decideShadow(els, box, extraPts) {
  const marks = paintStrokes()
  if (marks.length >= 2) {
    const roles = classifyPaintRoles(marks)
    if (roles.dests.length && roles.sources.length) {
      const srcBox = iframeUnionBox(polysOfMarks(roles.sources))
      const host =
        (els || []).find((el) => moduleCoveredByPaint(el, srcBox)) ||
        nearestToBox(srcBox) ||
        els?.[0]
      return { shaped: true, pts: roles.dests[roles.dests.length - 1].points, host }
    }
  }
  const shapePts = pickShadowStroke(els, extraPts)
  const pbox = shapePts?.length ? aabb(toIframePoly(shapePts)) : box
  const covered = pbox ? (els || []).filter((el) => moduleCoveredByPaint(el, pbox)) : []
  const host =
    (pbox ? covered.sort((a, b) => overlapScore(b, pbox).area - overlapScore(a, pbox).area)[0] : null) ||
    els?.[0] ||
    (pbox ? nearestToBox(pbox) : null)
  if (pbox && host && moduleCoveredByPaint(host, pbox) && !paintIsAroundModule(host, pbox)) {
    return { shaped: false, pts: shapePts, host }
  }
  if (shapePts?.length >= 6) return { shaped: true, pts: shapePts, host }
  return { shaped: false, pts: shapePts, host }
}

export function peekShadowLabel() {
  const box = iframeUnionBox(drawingPolys())
  const host = box ? nearestToBox(box) : null
  const d = decideShadow(host ? [host] : [], box, null)
  return d.shaped ? '按笔迹在周边加上阴影' : '给圈中模块加上投影'
}

function pickShadowStroke(els, extraPts) {
  const marks = paintStrokes()
  if (!marks.length && extraPts?.length >= 6) return extraPts
  if (!marks.length) return extraPts || null
  if (marks.length === 1) return marks[0].points
  const el = els?.[0]
  const r = el?.getBoundingClientRect?.()
  let best = marks[marks.length - 1]
  let bestScore = -1
  marks.forEach((m, idx) => {
    const poly = toIframePoly(m.points)
    const box = aabb(poly)
    let wrap = false
    if (r) {
      const hit = intersectBoxes(box, { x: r.left, y: r.top, w: r.width, h: r.height })
      const coverEl = hit ? (hit.w * hit.h) / Math.max(1, r.width * r.height) : 0
      wrap = coverEl > 0.72 && box.w * box.h > r.width * r.height * 0.85
    }
    const score = (wrap ? 0 : 10) + idx + pathLength(m.points) / 120
    if (score >= bestScore) {
      best = m
      bestScore = score
    }
  })
  return best.points
}

function shadowPathPts(screenPts) {
  const poly = toIframePoly(screenPts)
  if (!poly.length) return []
  if (poly.length < 8) return strokeToPolygon(poly, 14)
  const box = aabb(poly)
  const closed = dist(poly[0], poly[poly.length - 1]) < Math.max(16, Math.max(box.w, box.h) * 0.28)
  if (!closed && poly.length < 16) return strokeToPolygon(poly, Math.max(8, Math.min(26, Math.max(box.h, box.w) * 0.22)))
  const step = Math.max(1, Math.floor(poly.length / 56))
  const pts = poly.filter((_, i) => i % step === 0 || i === poly.length - 1)
  if (dist(pts[0], pts[pts.length - 1]) > 2) pts.push({ x: pts[0].x, y: pts[0].y })
  return pts
}

function attachShapedShadow(el, screenPts) {
  if (!el?.isConnected || !screenPts?.length) return false
  const hull = shadowPathPts(screenPts)
  if (hull.length < 3) return false
  const box = aabb(hull)
  if (box.w < 8 && box.h < 8) return false
  const r = el.getBoundingClientRect()
  const doc = el.ownerDocument
  const svgNS = 'http://www.w3.org/2000/svg'
  el.querySelectorAll('[data-markset-shaped-shadow]').forEach((node) => node.remove())
  const svg = doc.createElementNS(svgNS, 'svg')
  svg.setAttribute('data-markset-shaped-shadow', '1')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('viewBox', `0 0 ${Math.max(12, box.w)} ${Math.max(12, box.h)}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.style.cssText = [
    'position:absolute',
    `left:${Math.round(box.x - r.left)}px`,
    `top:${Math.round(box.y - r.top)}px`,
    `width:${Math.max(12, box.w)}px`,
    `height:${Math.max(12, box.h)}px`,
    'pointer-events:none',
    'z-index:0',
    'overflow:visible',
  ].join(';')
  const fid = `markset-shadow-blur-${Math.random().toString(36).slice(2, 8)}`
  const defs = doc.createElementNS(svgNS, 'defs')
  const filter = doc.createElementNS(svgNS, 'filter')
  filter.setAttribute('id', fid)
  filter.setAttribute('x', '-40%')
  filter.setAttribute('y', '-40%')
  filter.setAttribute('width', '180%')
  filter.setAttribute('height', '180%')
  const blur = doc.createElementNS(svgNS, 'feGaussianBlur')
  blur.setAttribute('stdDeviation', String(Math.max(2, Math.min(10, Math.round(Math.max(box.w, box.h) * 0.045)))))
  filter.append(blur)
  defs.append(filter)
  const shape = doc.createElementNS(svgNS, 'path')
  const d = hull
    .map((p, i) => `${i ? 'L' : 'M'}${Math.round(p.x - box.x)} ${Math.round(p.y - box.y)}`)
    .join(' ')
  shape.setAttribute('d', `${d} Z`)
  shape.setAttribute('fill', 'rgba(36, 24, 14, 0.4)')
  shape.setAttribute('filter', `url(#${fid})`)
  svg.append(defs, shape)
  const pos = doc.defaultView?.getComputedStyle(el)?.position
  if (!pos || pos === 'static') el.style.position = 'relative'
  el.style.overflow = 'visible'
  for (const child of [...el.children]) {
    if (child.hasAttribute('data-markset-shaped-shadow')) continue
    const cpos = doc.defaultView?.getComputedStyle(child)?.position
    if (!cpos || cpos === 'static') child.style.position = 'relative'
    if (!child.style.zIndex) child.style.zIndex = '1'
  }
  adaptLayout(el, 'shadow')
  el.insertBefore(svg, el.firstChild)
  el.dataset.marksetShadow = 'shape'
  return true
}

function inferCssShadow(pts, el) {
  if (!pts?.length || !el) return 'drop-shadow(6px 10px 8px rgba(36, 24, 14, 0.45))'
  const box = aabb(toIframePoly(pts))
  const r = el.getBoundingClientRect()
  const ox = Math.round(Math.max(-36, Math.min(36, box.x + box.w / 2 - (r.left + r.width / 2))))
  const oy = Math.round(Math.max(-20, Math.min(40, box.y + box.h / 2 - (r.top + r.height * 0.6))))
  const blur = Math.round(Math.max(6, Math.min(28, Math.max(box.w, box.h) * 0.22)))
  return `drop-shadow(${ox}px ${oy}px ${blur}px rgba(36, 24, 14, 0.4))`
}

function applyOpToEls(els, kind, { color, title, box, dx, dy, scheme, paint }) {
  let count = 0
  const mode = colorModeOf(kind, title)
  if (kind === 'delete-deco' || kind === 'clear-deco' || kind === 'clear-anno' || kind === 'soften') {
    for (const el of els) {
      if (stripDeco(el, { soften: kind === 'soften' })) count += 1
    }
  } else if (kind.startsWith('delete')) {
    for (const el of els) {
      leaveTombstone(el)
      count += 1
    }
  } else if (kind === 'scheme') {
    const sch = scheme || COLOR_SCHEMES[0]
    const colors = (sch?.colors || [color || '粉色']).filter(Boolean)
    const paper = sch?.paper || colors[0]
    const wrap = pickSchemeWrap(els, box)
    if (wrap) {
      applyBgColor(wrap, paper)
      if (!wrap.style.borderRadius) wrap.style.borderRadius = '14px'
      if (!wrap.style.boxShadow) wrap.style.boxShadow = '0 10px 28px rgba(40, 24, 16, 0.12)'
      wrap.dataset.marksetScheme = sch?.id || '1'
      count += 1
    }
    let ci = 0
    for (const el of els) {
      const name = colors[ci % colors.length]
      applyColor(el, name, isGraphicEl(el) || isWidgetEl(el) ? 'image' : 'text')
      for (const child of collectColorable(el)) {
        if (child === el) continue
        if (box && !aimedLeaf(child, box) && !centerInPaint(child, box)) continue
        applyColor(child, name, isGraphicEl(child) || isWidgetEl(child) ? 'image' : 'text')
      }
      ci += 1
      count += 1
    }
  } else if (kind === 'color' || kind === 'color-bg' || kind === 'color-text' || kind === 'color-image') {
    const name = color || '红色'
    let painted = mode === 'bg' ? keepPaintTargets(els, box) : colorTargets(els, box, mode)
    if (!painted.length) painted = keepPaintTargets(els, box)
    for (const el of painted) {
      if (mode === 'bg') applyBgColor(el, name)
      else {
        applyColor(el, name, isGraphicEl(el) ? 'image' : 'text')
        for (const child of collectColorable(el)) {
          if (child === el) continue
          if (box && !aimedLeaf(child, box) && !centerInPaint(child, box)) continue
          applyColor(child, name, isGraphicEl(child) ? 'image' : 'text')
        }
      }
      count += 1
    }
  } else if (kind === 'shadow') {
    const decision = decideShadow(els, box, paint)
    const host = decision.host || els[0]
    if (decision.shaped && decision.pts?.length >= 6 && host && attachShapedShadow(host, decision.pts)) {
      count += 1
      lastShadowJob = {
        shaped: true,
        pts: decision.pts,
        css: '',
        hostId: host.getAttribute('data-markset-id') || '',
      }
      console.log('[markset shadow] shape')
    } else {
      const targets = host ? uniqueEls([host, ...els]) : els
      const css = inferCssShadow(decision.pts, host || targets[0])
      for (const el of targets) {
        replaceFilterPart(el, 'shadow', inferCssShadow(decision.pts, el))
        el.dataset.marksetShadow = '1'
        adaptLayout(el, 'shadow')
        count += 1
      }
      if (count && host) {
        lastShadowJob = {
          shaped: false,
          pts: decision.pts,
          css,
          hostId: host.getAttribute('data-markset-id') || '',
        }
      }
      if (count) console.log('[markset shadow] css drop-shadow')
    }
  } else if (kind === 'reflect') {
    for (const el of els) {
      el.style.webkitBoxReflect = 'below 8px linear-gradient(transparent 20%, rgba(0,0,0,.45))'
      el.dataset.marksetReflect = '1'
      adaptLayout(el, 'reflect')
      count += 1
    }
  } else if (kind === 'scale-down' || kind === 'scale-up') {
    const factor = kind === 'scale-down' ? 0.72 : 1.28
    for (const el of els) {
      scaleOne(el, factor)
      count += 1
    }
  } else if (kind.startsWith('nudge-') || kind === 'move-nudge') {
    const delta = (dx || dy) ? [dx, dy] : nudgeDelta(kind, title)
    if (!delta[0] && !delta[1]) return { count: 0, reason: '写明往哪挪：往左 / 往右 / 往上 / 往下' }
    for (const el of els) {
      nudgeEl(el, delta[0], delta[1])
      count += 1
    }
  } else {
    const anno = annoKind(kind)
    for (const el of els) {
      el.setAttribute('data-markset-anno', anno)
      count += 1
    }
  }
  return { count }
}

export function executeCircledOp(op, { color = '', label = '', onBefore, dx = 0, dy = 0, scheme = null, paint = null } = {}) {
  const doc = getDoc()
  const iframe = frameEl()
  if (!doc?.body || !iframe) return { ok: false, reason: '没有导入的网页' }
  const box = iframeUnionBox(drawingPolys())
  if (!box || box.w < 6 || box.h < 6) return { ok: false, reason: '没有可用的圈。请再圈一次要改的地方' }
  stampIds(doc)
  const frameArea = Math.max(1, iframe.clientWidth * iframe.clientHeight)
  const hits = scanOverlapEls(box)
  const paintArea = box.w * box.h
  const large = paintArea > frameArea * 0.07 || Math.max(box.w, box.h) > 200
  const kind = String(op || '')
  const title = label || kind
  const html = snapshotWebHtml()
  const strategies = ['circled', 'tight', 'graphics', 'texts', 'module', 'fallback']
  const seen = new Set()
  for (const strategy of strategies) {
    if (strategy !== 'circled') restoreWebHtml(html)
    const raw = (() => {
      const picked = elsByStrategy(kind, title, box, scanOverlapEls(box), frameArea, large, strategy)
      if (kind !== 'scheme') return picked
      const wrap = pickSchemeWrap(picked, box)
      return wrap ? uniqueEls([wrap, ...picked]) : picked
    })()
    const els = keepPaintTargets(raw, box)
    if (!els.length) continue
    const key = `${strategy}:${els.map((el) => el.getAttribute('data-markset-id') || el.tagName).join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    const beforeEv = els.map((el) => evidenceOf(el))
    const before = els.map((el) => snapshotNode(el))
    const applied = applyOpToEls(els, kind, { color, title, box, dx, dy, scheme, paint })
    if (applied.reason && !applied.count) continue
    if (!applied.count) continue
    const afterEv = els.map((el) => evidenceOf(el))
    const accepted = verifyKind(kind, beforeEv, afterEv) || afterEv.some((a, i) => evidenceChanged(beforeEv[i], a))
    if (!accepted) continue
    onBefore?.(title)
    const after = before.map((shot) => {
      const live = shot.webId ? findByWebId(shot.webId) : null
      if (!live?.isConnected) return { ...shot, removed: true }
      return snapshotNode(live)
    })
    recordWebEdit(title, before, after)
    fitHeight()
    console.log(`[markset exec] ${kind} n=${applied.count} via=${strategy} ${els.map((el) => el.tagName).join(',')}`)
    const removed = kind.startsWith('delete') && kind !== 'delete-deco'
    const shaped = kind === 'shadow' && els.some((el) => el?.getAttribute?.('data-markset-shadow') === 'shape')
    return {
      ok: true,
      count: applied.count,
      message: removed
        ? `已删除圈中内容，共 ${applied.count} 处。可还原这一处`
        : shaped
          ? '已按你画的形状在周边加上阴影。可还原这一处'
          : kind === 'shadow'
            ? '已给圈中模块加上投影。可还原这一处'
            : `已改圈中内容，共 ${applied.count} 处。可还原这一处`,
    }
  }
  restoreWebHtml(html)
  return { ok: false, reason: '试了几种改法，改完比对仍达不到要求。圈和批注还留着，可换一项或把圈贴紧再试' }
}

function writebackOp(kind, commandText) {
  const t = String(commandText || '')
  if (kind === 'delete' || kind === 'delete-text' || kind === 'delete-image' || kind === 'delete-deco') return kind
  if (/去掉(阴影|倒影|框|装饰|标注|高亮)|取消(阴影|倒影|框)/.test(t)) return 'clear-deco'
  if (/倒影|镜像|反射/.test(t) || kind === 'reflect') return 'reflect'
  if (/阴影|投影|影子/.test(t) || kind === 'shadow') return 'shadow'
  if (/缩小|变小|小一点/.test(t) || kind === 'scale-down') return 'scale-down'
  if (/放大|变大|大一点/.test(t) || kind === 'scale-up') return 'scale-up'
  if (/底色|背景色|改背景/.test(t)) return 'color-bg'
  if (/往左|向左|左移/.test(t)) return 'nudge-left'
  if (/往右|向右|右移/.test(t)) return 'nudge-right'
  if (/往上|向上|上移/.test(t)) return 'nudge-up'
  if (/往下|向下|下移/.test(t)) return 'nudge-down'
  return ''
}

function isRewriteInstruction(text) {
  return /润色|写得更长|写得更短|更口语|更正式|保持原意|扩写|精简|改措辞|通顺/.test(String(text || ''))
}

function explicitReplacement(text) {
  const t = String(text || '').trim()
  const m = t.match(/^(?:请)?(?:把这段|把这些字|把圈中(?:的)?文字|将这段)?(?:文字)?(?:改成|换成|改为|改写为)[:：]?\s*[「『“"'']?(.+?)[」』”"'']?$/)
  if (!m?.[1]) return ''
  const next = m[1].trim()
  if (!next || next.length > 120 || isRewriteInstruction(next)) return ''
  return next
}

function rewritePrompt(kind, commandText) {
  const t = String(commandText || '').trim()
  if (kind === 'longer') return t || '把这段写得更长一些，保持原意和关键信息'
  if (kind === 'shorter') return t || '把这段写得更短一些，保持原意'
  if (kind === 'spoken') return t || '改成更口语，保持原意'
  if (kind === 'formal') return t || '改成更正式，保持原意'
  if (t) return t
  return '润色这段，保持原意和关键信息，不要解释'
}

function dropCoveringAncestors(els) {
  return (els || []).filter((el) => el && !(els || []).some((o) => o && o !== el && el.contains(o)))
}

function collectRewriteEls() {
  const box = iframeUnionBox(drawingPolys())
  const iframe = frameEl()
  const frameArea = Math.max(1, (iframe?.clientWidth || 1) * (iframe?.clientHeight || 1))
  const hits = box ? scanOverlapEls(box) : []
  const usable = (el) => el && isTextEl(el) && !isImageEl(el) && textOf(el).length >= 2
  let els = []
  if (box) {
    els = leafEls(hits, box).filter(usable)
    if (!els.length) els = hits.map((h) => h.el).filter(usable)
    if (!els.length) {
      els = pickContentEls(hits, box, frameArea, { large: false, kind: 'color-text' }).filter(usable)
    }
    els = els.filter((el) => aimedLeaf(el, box) || staysInPaint(el, box) || (centerInPaint(el, box) && overlapScore(el, box).coverEl >= 0.28))
  }
  if (!els.length) {
    els = circledEditSpans()
      .map((s) => findByWebId(s.webId))
      .filter(usable)
  }
  if (!els.length && hits.length) {
    els = hits.map((h) => h.el).filter((el) => usable(el) && (aimedLeaf(el, box) || centerInPaint(el, box)))
  }
  return keepPaintTargets(els, box).slice(0, 8)
}

export async function rewriteCircledText(commandText, { onBefore, kind = 'polish' } = {}) {
  if (!isWebDocActive()) return { ok: false, reason: '没有导入的网页' }
  const els = collectRewriteEls()
  if (!els.length) {
    return { ok: false, reason: '圈中没有可改的文字。请把圈贴在标题或段落上' }
  }
  const instruction = rewritePrompt(kind, commandText)
  const local = explicitReplacement(instruction)
  onBefore?.(local ? '替换文字' : '润色网页文字')
  const before = els.map((el) => snapshotNode(el))
  let count = 0
  let usedModel = false
  const page = String(meta.title || '').trim()
  for (const el of els) {
    const original = textOf(el)
    if (!original || original.length < 2) continue
    let next = local
    if (!next) {
      usedModel = true
      console.log(`[markset rewrite] 调用模型 ${els.length} 处「${original.slice(0, 24)}」指令「${instruction.slice(0, 36)}」`)
      const data = await rewriteText(
        [
          instruction,
          page ? `这段文字出现在网页「${page}」上` : '',
          '只改这一段可见文字，保持原语言，不要解释，不要把指令写进正文。',
        ]
          .filter(Boolean)
          .join('。'),
        original,
      )
      next = String(data?.text || '').trim()
    }
    if (!next || next === original || isRewriteInstruction(next)) continue
    if (replaceText(el, original, next)) count += 1
  }
  if (!count) {
    return {
      ok: false,
      reason: usedModel
        ? '模型已调用，但没有改出不同的文字。可把要求写具体一点，例如：更正式、更短，或写「改成……」'
        : '没有改到圈中的文字',
    }
  }
  const after = before.map((shot) => {
    const live = shot.webId ? findByWebId(shot.webId) : null
    return live ? snapshotNode(live) : { ...shot, removed: true }
  })
  recordWebEdit(local ? '替换文字' : '润色文字', before, after)
  ping()
  fitHeight()
  console.log(`[markset rewrite] ok n=${count} model=${usedModel}`)
  return {
    ok: true,
    count,
    message: usedModel
      ? `已调用模型改写圈中文字，共 ${count} 处。可还原这一处`
      : `已换成指定文字，共 ${count} 处。可还原这一处`,
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
  const snap = getSnapshot()
  const scope = snap.scope || 'inside'
  const commandText = inferCommandText(snap.commandText, web.filter((s) => s.kind === 'text'))
  const parsed = parseCommand(commandText)
  const rewriteLike = kind === 'rewrite' || kind === 'unify'
  const routed = writebackOp(kind, commandText)
  if (routed || (parsed.color && kind !== 'rewrite' && kind !== 'replace' && !isRewriteInstruction(commandText))) {
    const op = routed || 'color'
    const result = executeCircledOp(op, {
      color: parsed.color,
      label: commandText || op,
      onBefore,
    })
    if (!result.ok) {
      notify(result.reason || '没圈到可改的网页内容。请把圈画在要改的文字或图片上')
      return false
    }
    ping()
    fitHeight()
    notify(result.message)
    return true
  }
  if (kind === 'rewrite' || isRewriteInstruction(commandText)) {
    try {
      const result = await rewriteCircledText(commandText, { onBefore, kind })
      notify(result.ok ? result.message : result.reason)
      return result.ok
    } catch (err) {
      notify(
        err?.code === 'client-gate' || err?.code === 'no_client_gate' || err?.code === 'calls_disabled'
          ? '服务器禁止调用：把 .env 里 MARKSET_ALLOW_MODEL_CALLS 改为 1 并重启'
          : err?.message || '改写失败',
      )
      return false
    }
  }
  if (!web.length) {
    notify('没圈到可改的网页内容。请把圈画在要改的文字或图片上')
    return false
  }

  const paintBox = iframeUnionBox(drawingPolys())
  let items = web
    .map((s) => ({ span: s, el: findByWebId(s.webId) }))
    .filter((x) => {
      if (!x.el) return false
      if (!paintBox) return true
      return aimedLeaf(x.el, paintBox) || staysInPaint(x.el, paintBox) || overlapScore(x.el, paintBox).coverEl >= 0.28
    })
  if (!items.length) {
    items = web.map((s) => ({ span: s, el: findByWebId(s.webId) })).filter((x) => x.el)
  }

  if ((kind === 'rewrite' || kind === 'unify' || kind === 'replace') && !commandText && !parsed.color) {
    notify('先写下新名字或选出颜色')
    return false
  }

  const useModel = rewriteLike && items.some((x) => x.span.kind === 'text')
  onBefore?.(kind === 'delete' ? '删网页内容' : '改网页')

  const before = items.map((x) => snapshotNode(x.el))
  let count = 0
  const rewritten = new Set()
  for (const { span, el } of items) {
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

function insertHostBox() {
  const doc = getDoc()
  const fromDraw = iframeUnionBox(drawingPolys())
  const fromAll = iframeUnionBox((getPaintMarks() || []).map((m) => m.points).filter((p) => p?.length >= 3))
  const box = fromDraw || fromAll || lastPaintBox
  if (!doc?.body || !box) return null
  lastPaintBox = box
  try {
    const pos = doc.defaultView?.getComputedStyle(doc.body)?.position
    if (!pos || pos === 'static') doc.body.style.position = 'relative'
  } catch {
    doc.body.style.position = 'relative'
  }
  return { doc, box }
}

export function insertHostScreenBox() {
  const host = insertHostBox()
  const frame = iframeBox()
  if (!host || !frame) return null
  const z = iframeZoom()
  const b = host.box
  return {
    x: frame.left + b.x * z,
    y: frame.top + b.y * z,
    w: b.w * z,
    h: b.h * z,
  }
}

export function insertAroundCopy() {
  const host = insertHostBox()
  const doc = getDoc()
  const bits = []
  const pageTitle = clipScene(meta.title || doc?.title, 48)
  if (pageTitle) bits.push(`页面标题「${pageTitle}」`)
  let hostName = ''
  try {
    hostName = meta.sourceUrl ? new URL(meta.sourceUrl, 'https://local.invalid').hostname : ''
    if (hostName === 'local.invalid') hostName = ''
  } catch {
    hostName = ''
  }
  if (hostName) bits.push(`站点 ${hostName}`)
  if (!host) return bits.join('。')
  const pad = Math.max(72, Math.min(240, Math.max(host.box.w, host.box.h)))
  const around = {
    x: host.box.x - pad,
    y: host.box.y - pad,
    w: host.box.w + pad * 2,
    h: host.box.h + pad * 2,
  }
  const hits = scanOverlapEls(around)
  const seen = new Set()
  const headings = []
  const copies = []
  for (const hit of hits) {
    const t = clipScene(textOf(hit.el), 72)
    if (!t || t.length < 2 || seen.has(t)) continue
    seen.add(t)
    if (/^H[1-6]$/.test(hit.el.tagName)) headings.push(t)
    else if (isPrimarilyText(hit.el)) copies.push(t)
  }
  if (headings.length) bits.push(`附近标题「${headings.slice(0, 4).join(' / ')}」`)
  if (copies.length) bits.push(`周围文字「${copies.slice(0, 8).join('；')}」`)
  bits.push('插入位置是用户圈出的空白，文案或配图需贴合周围页面的主题、语气和风格')
  return bits.join('。')
}

export function insertWebText(text) {
  const host = insertHostBox()
  if (!host) return { ok: false, reason: '请先圈要插入的空白位置' }
  const t = String(text || '').trim()
  if (!t) return { ok: false, reason: '先写下要插入的文字' }
  const { doc, box } = host
  const el = doc.createElement('p')
  el.textContent = t
  el.setAttribute('data-markset-insert', 'text')
  el.style.cssText = [
    `position:absolute`,
    `left:${Math.round(box.x + 16)}px`,
    `top:${Math.round(box.y + Math.max(20, box.h * 0.28))}px`,
    `max-width:${Math.round(Math.max(140, box.w - 32))}px`,
    `margin:0`,
    `padding:4px 6px`,
    `font:20px/1.5 system-ui,sans-serif`,
    `color:#1d1916`,
    `z-index:8`,
  ].join(';')
  doc.body.append(el)
  stampIds(doc)
  const after = snapshotNode(el)
  recordWebEdit('插入文字', [{ ...after, html: '', removed: true }], [after])
  fitHeight()
  return { ok: true, message: '已在圈中空白插入文字。可还原这一处' }
}

export function insertWebStamp(src, screenBox) {
  const doc = getDoc()
  const frame = iframeBox()
  const url = String(src || '').trim()
  if (!doc?.body || !frame || !url || !screenBox) return { ok: false, reason: '没有可放下的图案' }
  const el = doc.createElement('img')
  el.src = url
  el.alt = '画出的图案'
  el.setAttribute('data-markset-insert', 'stamp')
  const x = Math.round(screenBox.x - frame.left)
  const y = Math.round(screenBox.y - frame.top)
  const w = Math.round(Math.max(28, screenBox.w))
  el.style.cssText = [
    `position:absolute`,
    `left:${x}px`,
    `top:${y}px`,
    `width:${w}px`,
    `height:${Math.round(Math.max(28, screenBox.h))}px`,
    `object-fit:contain`,
    `background:transparent`,
    `pointer-events:none`,
    `z-index:6`,
  ].join(';')
  const pos = doc.defaultView?.getComputedStyle(doc.body)?.position
  if (!pos || pos === 'static') doc.body.style.position = 'relative'
  doc.body.append(el)
  stampIds(doc)
  const after = snapshotNode(el)
  recordWebEdit('加上画出的图案', [{ ...after, html: '', removed: true }], [after])
  el.addEventListener('load', fitHeight, { once: true })
  fitHeight()
  return { ok: true, message: '已把画出的图案放到页面上。可还原这一处' }
}

export function insertWebImage(src) {
  const host = insertHostBox()
  if (!host) return { ok: false, reason: '请先圈要插入的空白位置' }
  const url = String(src || '').trim()
  if (!url) return { ok: false, reason: '先选一张要插入的图' }
  const { doc, box } = host
  const el = doc.createElement('img')
  el.src = url
  el.alt = '插入的图'
  el.setAttribute('data-markset-insert', 'image')
  const w = Math.round(Math.max(72, Math.min(360, box.w * 0.56)))
  el.style.cssText = [
    `position:absolute`,
    `left:${Math.round(box.x + Math.max(12, (box.w - w) / 2))}px`,
    `top:${Math.round(box.y + Math.max(16, box.h * 0.22))}px`,
    `width:${w}px`,
    `height:auto`,
    `max-width:${Math.round(box.w - 24)}px`,
    `z-index:8`,
  ].join(';')
  doc.body.append(el)
  stampIds(doc)
  const after = snapshotNode(el)
  recordWebEdit('插入图片', [{ ...after, html: '', removed: true }], [after])
  el.addEventListener('load', fitHeight, { once: true })
  fitHeight()
  return { ok: true, message: '已在圈中空白插入图片。可还原这一处' }
}

function rasterizeEl(el) {
  try {
    const img = el?.tagName === 'IMG' ? el : el?.querySelector?.('img')
    if (img?.src?.startsWith('data:')) return img.src
    if (!img) return ''
    const w = img.naturalWidth || Math.round(img.getBoundingClientRect().width)
    const h = img.naturalHeight || Math.round(img.getBoundingClientRect().height)
    if (!w || !h) return img.src || ''
    const canvas = (img.ownerDocument || document).createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d').drawImage(img, 0, 0)
    return canvas.toDataURL('image/png')
  } catch {
    const img = el?.tagName === 'IMG' ? el : el?.querySelector?.('img')
    return img?.src || ''
  }
}

function clipScene(text, n = 72) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n)
}

function imageRole(el, r, frameW) {
  const blob = `${el?.id || ''} ${el?.className || ''} ${el?.getAttribute?.('alt') || ''} ${el?.getAttribute?.('aria-label') || ''}`.toLowerCase()
  if (looksLikeLogo(el) || /logo|brand|icon/.test(blob)) return '网站Logo或图标'
  if (r.width < 44 && r.height < 44) return '小图标'
  if (frameW && r.width > frameW * 0.55 && r.height > 72) return '页眉或主视觉大图'
  if (r.y < 130) return '页顶配图'
  const wrap = el.closest?.('header, nav, footer, aside, main, article, figure')
  const tag = wrap?.tagName || ''
  if (tag === 'HEADER' || tag === 'NAV') return '导航或页眉配图'
  if (tag === 'FOOTER') return '页脚配图'
  if (tag === 'ASIDE') return '侧栏配图'
  if (tag === 'FIGURE') return '正文插图'
  return '网页配图'
}

function nearbyCopy(el) {
  const root = el.closest?.('section, article, header, main, figure, li, div') || el.parentElement
  const heading = root?.querySelector?.('h1, h2, h3, h4')
  const bits = []
  const h = clipScene(heading?.innerText, 48)
  if (h) bits.push(`附近标题「${h}」`)
  const around = clipScene(
    [el.previousElementSibling?.innerText, el.nextElementSibling?.innerText, root && root !== el ? root.innerText : '']
      .filter(Boolean)
      .join(' '),
    80,
  )
  if (around && around !== h) bits.push(`周围文字「${around}」`)
  return bits
}

function imageScenePrompt(el) {
  const doc = getDoc()
  const frame = iframeBox()
  const pageTitle = clipScene(meta.title || doc?.title, 40)
  let host = ''
  try {
    host = meta.sourceUrl ? new URL(meta.sourceUrl, 'https://local.invalid').hostname : ''
    if (host === 'local.invalid') host = ''
  } catch {
    host = ''
  }
  const bits = [`应用场景：网页「${pageTitle || '未命名页面'}」${host ? `（${host}）` : ''}上的配图`]
  if (!el) {
    bits.push('放在用户圈出的空白位置，作为该页插图')
    const around = insertAroundCopy()
    if (around) bits.push(around)
    bits.push('风格需能融入当前网页，构图干净，不要大段文字或水印')
    return bits.join('。')
  }
  const r = el.getBoundingClientRect()
  bits.push(`用途是${imageRole(el, r, frame?.width)}`)
  bits.push(`位置比例约 ${Math.max(1, Math.round(r.width))}×${Math.max(1, Math.round(r.height))}`)
  const alt = clipScene(el.getAttribute?.('alt') || el.querySelector?.('img')?.getAttribute?.('alt'), 36)
  if (alt) bits.push(`原图说明「${alt}」`)
  bits.push(...nearbyCopy(el))
  bits.push('请生成适合这个网页位置、能和周围内容放在一起的图，不要大段文字或水印')
  return bits.join('。')
}

export function circledImageSeed() {
  const el = resolveCircledEls('color-image').find((node) => isGraphicEl(node) || isImageEl(node) || hasPaintedBg(node))
  if (!el) {
    const box = insertHostBox()?.box
    return {
      imageDataUrl: '',
      width: Math.round(box?.w || 0),
      height: Math.round(box?.h || 0),
      scene: imageScenePrompt(null),
    }
  }
  const r = el.getBoundingClientRect()
  return {
    imageDataUrl: rasterizeEl(el),
    width: Math.round(r.width),
    height: Math.round(r.height),
    scene: imageScenePrompt(el),
  }
}

function putImageOnEl(el, src) {
  if (!el || !src) return null
  if (el.tagName === 'IMG') {
    el.removeAttribute('srcset')
    el.src = src
    return el
  }
  if (el.tagName === 'SVG' || el.tagName === 'CANVAS' || el.tagName === 'PICTURE') {
    const img = el.ownerDocument.createElement('img')
    img.src = src
    img.alt = el.getAttribute('aria-label') || el.getAttribute('alt') || '生成的图'
    const r = el.getBoundingClientRect()
    img.style.width = `${Math.max(12, Math.round(r.width))}px`
    img.style.height = `${Math.max(12, Math.round(r.height))}px`
    img.style.objectFit = 'cover'
    el.replaceWith(img)
    stampIds(el.ownerDocument)
    return img
  }
  const inner = el.querySelector?.('img')
  if (inner) {
    inner.removeAttribute('srcset')
    inner.src = src
    return inner
  }
  el.style.backgroundImage = `url("${src}")`
  if (!el.style.backgroundSize) el.style.backgroundSize = 'cover'
  if (!el.style.backgroundRepeat) el.style.backgroundRepeat = 'no-repeat'
  return el
}

export function applyGeneratedWebImage(src) {
  const url = String(src || '').trim()
  if (!url) return { ok: false, reason: '没有生成出图片' }
  const scene = describePaintScene()
  if (scene.blank || scene.kind === 'blank' || scene.fill < 0.18) return insertWebImage(url)
  const els = uniqueEls(resolveCircledEls('color-image').filter((el) => isGraphicEl(el) || isImageEl(el) || hasPaintedBg(el)))
  if (!els.length) return insertWebImage(url)
  const before = els.map((el) => snapshotNode(el))
  const after = []
  for (const el of els) {
    const node = putImageOnEl(el, url)
    if (node?.isConnected) after.push(snapshotNode(node))
  }
  if (!after.length) return insertWebImage(url)
  recordWebEdit('换成生成的图', before, after)
  fitHeight()
  return { ok: true, message: '已用生成的图换上。可还原这一处' }
}

function fileName() {
  const raw = String(meta.title || 'markset-page').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'markset-page'
  return `${raw.slice(0, 40)}.html`
}

function cleanExportDoc(raw) {
  const parsed = new DOMParser().parseFromString(raw, 'text/html')
  parsed.getElementById(SKIN_ID)?.remove()
  parsed.getElementById(BADGE_HOST)?.remove()
  parsed.querySelectorAll('[data-markset-badge-host],[data-markset-edit-badge],[data-markset-tombstone]').forEach((el) => el.remove())
  const keepSkin = parsed.createElement('style')
  keepSkin.textContent = `
[data-markset-anno="underline"] { text-decoration: underline 2px; text-underline-offset: 3px; }
[data-markset-anno="wavy"] { text-decoration: underline wavy 2px #3c6fd4; text-underline-offset: 3px; }
[data-markset-anno="strike"], [data-markset-anno="line-strike"] { text-decoration: line-through 2px; }
[data-markset-anno="highlight"] { background: rgba(255, 226, 80, 0.55); }
[data-markset-anno="bold"] { font-weight: 700; }
[data-markset-anno="box"], [data-markset-anno="frame"] { outline: 2px solid #3c6fd4; outline-offset: 3px; }
[data-markset-anno="circle"] { outline: 2px solid #3c6fd4; border-radius: 999px; outline-offset: 4px; }
[data-markset-scaled] { transform-origin: center center; }
`
  parsed.head?.append(keepSkin)
  const dropAttrs = [
    'data-markset-id',
    'data-markset-orig-w',
    'data-markset-orig-h',
    'data-markset-orig-bg',
    'data-markset-mar-b',
    'data-markset-mar-r',
    'data-markset-zoom',
    'data-markset-overflow',
    'data-markset-font',
  ]
  parsed.querySelectorAll('*').forEach((el) => {
    dropAttrs.forEach((name) => el.removeAttribute(name))
    if (el.dataset) {
      delete el.dataset.marksetOrigW
      delete el.dataset.marksetOrigH
      delete el.dataset.marksetOrigBg
      delete el.dataset.marksetMarB
      delete el.dataset.marksetMarR
      delete el.dataset.marksetZoom
      delete el.dataset.marksetOverflow
      delete el.dataset.marksetFont
    }
  })
  return `<!DOCTYPE html>\n${parsed.documentElement.outerHTML}`
}

export function exportWebDoc() {
  if (!isWebDocActive()) return false
  const html = cleanExportDoc(snapshotWebHtml())
  if (!html.trim()) return false
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = fileName()
  a.click()
  URL.revokeObjectURL(a.href)
  return true
}
