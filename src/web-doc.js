import { isClientModelGateOn, rewriteText } from './api.js'
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
    at: Date.now(),
    before,
    after: after || [],
    screen: null,
  }
  item.screen = firstLiveAnchor(item.after) || firstLiveAnchor(item.before)
  webEdits = [item, ...webEdits]
  ping()
  return item
}

function firstLiveAnchor(shots) {
  for (const shot of shots || []) {
    if (!shot?.webId || shot.removed) continue
    const r = liveScreenRect({ webId: shot.webId })
    if (r && r.w > 1 && r.h > 1) return { x: r.x + r.w + 6, y: r.y }
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
  const t = Number(at) || 0
  if (!t) return popLastWebEdit()
  webEdits = webEdits.filter((item) => (item.at || 0) < t)
  ping()
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
    if (h.coverEl >= 0.28 && (centerInPaint(h.el, box) || h.coverBox >= 0.08)) return true
    return centerInPaint(h.el, box) && h.coverBox >= 0.05 && (isGraphicEl(h.el) || isWidgetEl(h.el))
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
  if (all.length < 2) return { sources: all, dests: [], all }
  const scored = all.map((m) => {
    const poly = m.points.length >= 3 ? strokeToPolygon(m.points) : m.points
    const box = aabb(m.points)
    const iframe = iframeUnionBox([poly])
    const scene = sceneFromIframeBox(iframe)
    const hits = hitWebDoc(poly, { loose: true })
    const n = (hits.images?.found?.length || 0) + (hits.texts?.found?.length || 0)
    return { mark: m, box, poly, scene, n, blank: scene.blank || scene.fill < 0.2 }
  })
  const dests = scored.filter((s) => s.blank)
  const sources = scored.filter((s) => !s.blank)
  if (dests.length && sources.length) {
    return { sources: sources.map((s) => s.mark), dests: dests.map((s) => s.mark), all }
  }
  scored.sort((a, b) => b.n - a.n || a.box.w * a.box.h - b.box.w * b.box.h)
  const primary = scored[0]
  const extra = scored.slice(1).filter((s) => boxesFar(primary.box, s.box) && s.n <= primary.n)
  if (extra.length) {
    return { sources: [primary.mark], dests: extra.map((s) => s.mark), all }
  }
  return { sources: all, dests: [], all }
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
  return scene.blank || scene.fill < 0.22
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
  const html = snapshotWebHtml()
  const pairs = inferWebLayoutPairs()
  if (!pairs.length) return 0
  const modes = ['transform', 'absolute']
  for (const mode of modes) {
    if (mode !== 'transform') restoreWebHtml(html)
    let n = 0
    const before = []
    const beforeEv = []
    const afterEls = []
    const dests = []
    for (const pair of pairs) {
      const el = findByWebId(pair.webId)
      const dest = toIframeRect(pair.dest)
      if (!el || !dest) continue
      before.push(snapshotNode(el))
      beforeEv.push(evidenceOf(el))
      dests.push(dest)
      moveElToDest(el, dest, mode)
      afterEls.push(el)
      n += 1
    }
    if (!n) continue
    const afterEv = afterEls.map((el) => (el?.isConnected ? evidenceOf(el) : { connected: false, rect: { x: 0, y: 0, w: 0, h: 0 } }))
    if (!verifyMove(beforeEv, afterEv, dests)) continue
    recordWebEdit('挪位置', before, afterEls.map((el) => snapshotNode(el)))
    fitHeight()
    return n
  }
  restoreWebHtml(html)
  return 0
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
    html: el.outerHTML.slice(0, 1800),
    text: String(el.innerText || '').slice(0, 80),
  }
}

function verifyKind(kind, befores, afters) {
  if (!afters.length) return false
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
  if (kind === 'shadow') return afters.some((a, i) => a.filter !== befores[i]?.filter && /drop-shadow/i.test(a.filter))
  if (kind === 'reflect') return afters.some((a) => Boolean(a.reflect))
  if (kind === 'frame' || kind === 'box' || kind === 'circle' || kind === 'highlight' || kind === 'bold' || kind === 'underline' || kind === 'wavy' || kind === 'strike' || String(kind).startsWith('line')) {
    return afters.some((a, i) => a.anno !== befores[i]?.anno || a.fontWeight !== befores[i]?.fontWeight || a.html !== befores[i]?.html)
  }
  if (String(kind).startsWith('nudge') || kind === 'move-nudge' || kind === 'move-layout') {
    return afters.some((a, i) => Math.hypot(a.rect.x - (befores[i]?.rect.x || 0), a.rect.y - (befores[i]?.rect.y || 0)) > 6)
  }
  if (kind === 'clear-deco' || kind === 'delete-deco' || kind === 'clear-anno' || kind === 'soften') {
    return afters.some((a, i) => a.filter !== befores[i]?.filter || a.anno !== befores[i]?.anno || a.reflect !== befores[i]?.reflect || a.html !== befores[i]?.html)
  }
  return afters.some((a, i) => {
    const b = befores[i]
    if (!b) return a.connected
    return (
      a.connected !== b.connected ||
      a.color !== b.color ||
      a.bg !== b.bg ||
      a.filter !== b.filter ||
      a.transform !== b.transform ||
      a.anno !== b.anno ||
      a.fontSize !== b.fontSize ||
      a.fontWeight !== b.fontWeight ||
      Math.hypot(a.rect.x - b.rect.x, a.rect.y - b.rect.y) > 4 ||
      Math.abs(a.rect.w * a.rect.h - b.rect.w * b.rect.h) / Math.max(1, b.rect.w * b.rect.h) > 0.06
    )
  })
}

function verifyMove(befores, afters, dests) {
  return afters.some((a, i) => {
    const b = befores[i]
    const dest = dests[i]
    if (!a?.connected || !b) return false
    const moved = Math.hypot(a.rect.x - b.rect.x, a.rect.y - b.rect.y) > 6
    if (!dest) return moved
    const beforeDist = Math.hypot(b.rect.x - dest.x, b.rect.y - dest.y)
    const afterDist = Math.hypot(a.rect.x - dest.x, a.rect.y - dest.y)
    return moved && afterDist < beforeDist - 4
  })
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

function centerInPaint(el, box) {
  const r = el.getBoundingClientRect()
  const cx = r.x + r.width / 2
  const cy = r.y + r.height / 2
  return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h
}

function significantChildren(el) {
  return [...(el?.children || [])].filter((kid) => {
    if (!kid || SKIP.has(kid.tagName)) return false
    const r = kid.getBoundingClientRect()
    return r.width >= 16 && r.height >= 12 && r.width * r.height >= 40 * 20
  })
}

function containsOutsiders(el, box) {
  const kids = significantChildren(el)
  if (kids.length < 2) return false
  const insiders = kids.filter((kid) => centerInPaint(kid, box) || overlapScore(kid, box).coverEl >= 0.5)
  const outsiders = kids.filter((kid) => !centerInPaint(kid, box) && overlapScore(kid, box).coverEl < 0.4)
  return insiders.length >= 1 && outsiders.length >= 1
}

function staysInPaint(el, box) {
  if (!el || !box) return false
  const hit = overlapScore(el, box)
  if (hit.coverEl < 0.6) return false
  if (!centerInPaint(el, box) && hit.coverEl < 0.82) return false
  if (hit.extraTop > Math.max(16, box.h * 0.1)) return false
  if (hit.extraBottom > Math.max(28, box.h * 0.16)) return false
  if (hit.extraLeft > Math.max(28, box.w * 0.1) && hit.extraRight > Math.max(28, box.w * 0.1) && hit.coverEl < 0.78) {
    return false
  }
  if (containsOutsiders(el, box)) return false
  return true
}

function aimedLeaf(el, box) {
  const hit = overlapScore(el, box)
  if (containsOutsiders(el, box)) return false
  if (centerInPaint(el, box)) return hit.coverEl >= 0.18
  return hit.coverEl >= 0.45 || (isGraphicEl(el) && hit.coverEl >= 0.22)
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
    if (vis.length) return vis
  }
  if (preferText) {
    const texts = els.filter((el) => isPrimarilyText(el))
    if (texts.length) return texts
  }
  const vis = pickVisualEls(els, box)
  return vis.length ? vis : els.slice(0, 4)
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
    return vis.length ? vis : graphics.slice(0, 3)
  }
  if (/delete-text|color-text/.test(k)) return texts.slice(0, 8)
  if (k === 'scale-down' || k === 'scale-up') {
    if (graphics.length) {
      const vis = pickVisualEls([...graphics, ...texts], box)
      return vis.length ? vis : graphics.slice(0, 3)
    }
    return texts.slice(0, 8)
  }
  if (k === 'color' || k === 'color-bg' || k === 'scheme') {
    const vis = pickVisualEls(graphics, box)
    return uniqueEls([...(vis.length ? vis : graphics), ...texts]).slice(0, 8)
  }
  return uniqueEls([...graphics, ...texts, ...els]).slice(0, 8)
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
    } else if (kind.startsWith('nudge-') || kind === 'move-nudge') {
      els = pickContentEls(hits, box, frameArea, { large, kind: '' })
    } else {
      els = pickDecorEls(hits, box, frameArea, large, false)
    }
  }
  els = uniqueEls(els).filter((el) => el.isConnected && el !== doc?.body)
  if (!els.length) els = fallbackEls(box, kind)
  return uniqueEls(els).filter((el) => el?.isConnected && el !== doc?.body)
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

function applyOpToEls(els, kind, { color, title, box, dx, dy, scheme }) {
  let count = 0
  const mode = colorModeOf(kind, title)
  if (kind === 'delete-deco' || kind === 'clear-deco' || kind === 'clear-anno' || kind === 'soften') {
    for (const el of els) {
      if (stripDeco(el, { soften: kind === 'soften' })) count += 1
    }
  } else if (kind.startsWith('delete')) {
    for (const el of els) {
      el.remove()
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
        applyColor(child, name, isGraphicEl(child) || isWidgetEl(child) ? 'image' : 'text')
      }
      ci += 1
      count += 1
    }
  } else if (kind === 'color' || kind === 'color-bg' || kind === 'color-text' || kind === 'color-image') {
    const name = color || '红色'
    let painted = mode === 'bg' ? els : colorTargets(els, box, mode)
    if (!painted.length) painted = els
    for (const el of painted) {
      if (mode === 'bg') applyBgColor(el, name)
      else {
        applyColor(el, name, isGraphicEl(el) ? 'image' : 'text')
        for (const child of collectColorable(el)) {
          if (child === el) continue
          applyColor(child, name, isGraphicEl(child) ? 'image' : 'text')
        }
      }
      count += 1
    }
  } else if (kind === 'shadow') {
    for (const el of els) {
      replaceFilterPart(el, 'shadow', 'drop-shadow(6px 10px 8px rgba(36, 24, 14, 0.45))')
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

export function executeCircledOp(op, { color = '', label = '', onBefore, dx = 0, dy = 0, scheme = null } = {}) {
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
  const title = label || kind
  const html = snapshotWebHtml()
  const strategies = ['circled', 'tight', 'graphics', 'texts', 'module', 'fallback']
  const seen = new Set()
  for (const strategy of strategies) {
    if (strategy !== 'circled') restoreWebHtml(html)
    const els = (() => {
      const picked = elsByStrategy(kind, title, box, scanOverlapEls(box), frameArea, large, strategy)
      if (kind !== 'scheme') return picked
      const wrap = pickSchemeWrap(picked, box)
      return wrap ? uniqueEls([wrap, ...picked]) : picked
    })()
    if (!els.length) continue
    const key = `${strategy}:${els.map((el) => el.getAttribute('data-markset-id') || el.tagName).join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    const beforeEv = els.map((el) => evidenceOf(el))
    const before = els.map((el) => snapshotNode(el))
    const applied = applyOpToEls(els, kind, { color, title, box, dx, dy, scheme })
    if (applied.reason && !applied.count) continue
    if (!applied.count) continue
    const afterEv = els.map((el) => evidenceOf(el))
    if (!verifyKind(kind, beforeEv, afterEv)) continue
    onBefore?.(title)
    const after = before.map((shot, i) => {
      const el = els[i]
      if (!el?.isConnected) return { ...shot, removed: true }
      return snapshotNode(el)
    })
    recordWebEdit(title, before, after)
    fitHeight()
    console.log(`[markset exec] ${kind} n=${applied.count} via=${strategy} ${els.map((el) => el.tagName).join(',')}`)
    const removed = kind.startsWith('delete') && kind !== 'delete-deco'
    return {
      ok: true,
      count: applied.count,
      message: removed
        ? `已删除圈中内容，共 ${applied.count} 处。可还原这一处`
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
  const routed = writebackOp(kind, commandText)
  if (routed || (parsed.color && kind !== 'rewrite' && kind !== 'replace')) {
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
  if (!web.length) {
    notify('没圈到可改的网页内容。请把圈画在要改的文字或图片上')
    return false
  }
  if ((kind === 'rewrite' || kind === 'unify' || kind === 'replace') && !commandText && !parsed.color) {
    notify('先写下新名字或选出颜色')
    return false
  }

  const paintBox = iframeUnionBox(drawingPolys())
  const items = web
    .map((s) => ({ span: s, el: findByWebId(s.webId) }))
    .filter((x) => {
      if (!x.el) return false
      if (!paintBox) return true
      return aimedLeaf(x.el, paintBox) || staysInPaint(x.el, paintBox) || overlapScore(x.el, paintBox).coverEl >= 0.45
    })
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
  const box = iframeUnionBox(drawingPolys())
  if (!doc?.body || !box) return null
  try {
    const pos = doc.defaultView?.getComputedStyle(doc.body)?.position
    if (!pos || pos === 'static') doc.body.style.position = 'relative'
  } catch {
    doc.body.style.position = 'relative'
  }
  return { doc, box }
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

function fileName() {
  const raw = String(meta.title || 'markset-page').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'markset-page'
  return `${raw.slice(0, 40)}.html`
}

function cleanExportDoc(raw) {
  const parsed = new DOMParser().parseFromString(raw, 'text/html')
  parsed.getElementById(SKIN_ID)?.remove()
  parsed.getElementById(BADGE_HOST)?.remove()
  parsed.querySelectorAll('[data-markset-badge-host],[data-markset-edit-badge]').forEach((el) => el.remove())
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
