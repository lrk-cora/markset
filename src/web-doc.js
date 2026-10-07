import { rewriteText } from './api.js'
import { colorFill, colorRgb, COLOR_SCHEMES } from './colors.js'
import { aabb, boxHitsPolygon, dist, intersectBoxes, isRegionStroke, looksLikeEnclosingStroke, looksLikeRadialBurst, paintHitPolygon, pathLength, pointInPolygon, strokeToPolygon, unionBoxes } from './geometry.js'
import { collectLayoutPairs } from './layout.js'
import { getInkStrokes } from './ink.js'
import { getPaintMarks, SELECT_COLOR } from './overlay.js'
import { inferCommandText, localNextText, parseCommand } from './plan-local.js'
import { getSnapshot, ping as storePing, targets, upsertSpan } from './store.js'
import { filterExcludedTargets } from './target-selection.js'
import { stripExecutableMarkup } from './passive-document.js'
import { anchorBrushStroke, validLayoutRect } from './brush-layout.js'
import { readPageObservation } from './page-observation.js'
import { checkNodeSpecs, checkStyleDeclarations } from './edit-capabilities.js'
import { auditPlanResult, measurePlanDocument } from './plan-verification.js'
import { planCheckReport } from './plan-check-policy.js'

export function excludeBrushTargets(targets, excludedIds = []) {
  return filterExcludedTargets(targets, excludedIds, findByWebId)
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'BR', 'HR', 'HEAD', 'HTML'])
const SKIN_ID = 'markset-skin'
const MAX_HITS = 4

let meta = { title: '', sourceUrl: '' }
let viewportBound = false
let layoutObserver = null
let layoutFrame = 0
let executionFrame = null
const iframeScrollBound = new WeakSet()
const BADGE_HOST = 'markset-badge-host'

const SKIN = `
html, body { margin: 0 !important; width: 100% !important; min-width: 100% !important; max-width: none !important; height: auto !important; min-height: 100% !important; max-height: none !important; overflow: visible !important; }
img, video { max-width: 100%; height: auto; }
[data-markset-anno="underline"] { text-decoration: underline 2px; text-decoration-skip-ink: none; text-underline-offset: 3px; }
[data-markset-anno="wavy"] { text-decoration: underline wavy 2px #3c6fd4; text-decoration-skip-ink: none; text-underline-offset: 3px; }
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
[data-markset-word][data-markset-scaled] { display: inline; max-width: none; }
[data-markset-flow] { overflow: visible; }
[data-markset-tombstone] { display: none !important; }
[data-markset-shaped-shadow] { pointer-events: none; }
`

function esc(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function ping() { if (!executionFrame) storePing() }

function hostEl() {
  return document.getElementById('web-doc-host')
}

function frameEl() {
  if (executionFrame) return executionFrame
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
  // Trial execution must expose overflow rather than shrink the whole clone
  // to make an invalid layout appear to fit.
  if (executionFrame) return
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
  requestAnimationFrame(refreshWebDocLayout)
  doc.body?.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || ''
    if (/^https?:\/\//i.test(src) && !src.includes('/api/asset?url=')) {
      img.dataset.marksetOriginalSrc = src
    }
    img.addEventListener('error', () => {
      const original = img.dataset.marksetOriginalSrc || img.getAttribute('src') || ''
      if (!/^https?:\/\//i.test(original) || img.dataset.marksetProxyTried === '1') return
      img.dataset.marksetProxyTried = '1'
      img.src = `${window.location.origin}/api/asset?url=${encodeURIComponent(original)}`
      refreshWebDocLayout()
    }, { once: true })
    if (!img.complete) img.addEventListener('load', refreshWebDocLayout, { once: true })
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
    refreshWebDocLayout()
  })
  // CSS grid/sidebar changes do not emit window.resize. Watch the actual
  // canvas width and notify ink only after the imported page has reflowed.
  if (typeof ResizeObserver !== 'undefined') {
    let width = frameEl()?.clientWidth
    layoutObserver = new ResizeObserver(() => {
      const nextWidth = frameEl()?.clientWidth
      if (nextWidth === width) return
      width = nextWidth
      refreshWebDocLayout()
    })
    if (frameEl()) layoutObserver.observe(frameEl())
  }
}

export function refreshWebDocLayout() {
  if (!isWebDocActive()) return
  fitHeight()
  if (layoutFrame) return
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0
    fitHeight()
    window.dispatchEvent(new Event('markset:page-layout'))
    ping()
  })
}

function setHtml(html) {
  const iframe = frameEl()
  const doc = iframe?.contentDocument
  if (!iframe || !doc) return false
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  if (!parsed.documentElement) return false
  stripExecutableMarkup(parsed)
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
  page.classList.remove('is-guide')
  page.classList.add('is-import', 'is-web-doc')
  const guide = document.getElementById('start-guide')
  if (guide) guide.hidden = true
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
  const ph = doc.createElement('span')
  if (id) ph.setAttribute('data-markset-id', id)
  ph.setAttribute('data-markset-tombstone', '1')
  ph.setAttribute('aria-hidden', 'true')
  ph.hidden = true
  // An undo anchor is not a layout item. A zero-width inline-block still
  // occupies a row/gap in flex and grid layouts after removing a module.
  ph.style.cssText = 'display:none !important;'
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
  if (shot.documentBody != null) {
    const body = getDoc()?.body
    if (body) body.innerHTML = shot.documentBody
    return
  }
  if (shot.absent) { findByWebId(shot.webId)?.remove(); return }
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
    if (shot.hadStyle === false) cur.removeAttribute('style')
    else if (shot.cssText != null) cur.setAttribute('style', shot.cssText)
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
    hadStyle: el.hasAttribute('style'),
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
  return `<span${id} data-markset-tombstone="1" aria-hidden="true" hidden style="display:none !important;"></span>`
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

export function applyBrushColor(targets, color) {
  const name = String(color || '').trim()
  if (!name) return { ok: false, reason: '没有指定颜色' }
  const live = []
  for (const target of targets || []) {
    const el = target?.webId ? findByWebId(target.webId) : null
    if (!el || !['text', 'image'].includes(target.kind) || el === getDoc()?.body || el === getDoc()?.documentElement) continue
    if (live.some((parent) => parent === el || parent.contains(el))) continue
    for (let i = live.length - 1; i >= 0; i -= 1) if (el.contains(live[i])) live.splice(i, 1)
    live.push(el)
  }
  if (!live.length) return { ok: false, reason: '找不到仍在页面上的标记对象' }
  const before = live.map((el) => snapshotNode(el))
  try {
    for (const root of live) {
      const graphic = isGraphicEl(root)
      applyColor(root, name, graphic ? 'image' : 'text')
      for (const child of collectColorable(root)) {
        if (child === root) continue
        applyColor(child, name, isGraphicEl(child) ? 'image' : 'text')
      }
      root.setAttribute('data-markset-edited', '1')
    }
  } catch {
    before.forEach(applyShot)
    return { ok: false, reason: '着色失败，网页已恢复原样' }
  }
  const after = live.map((el) => snapshotNode(el))
  recordWebEdit(`改为${name}`, before, after)
  fitHeight()
  ping()
  return { ok: true, count: live.length, message: `已将 ${live.length} 个标记对象改为${name}` }
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
    : webEdits.find((item) => item.keep !== false)
      ? [webEdits.find((item) => item.keep !== false)]
      : []
  for (const item of recent) {
    if (item.keep === false) continue
    for (const shot of item.before || []) applyShot(shot)
    item.keep = false
  }
  if (t) webEdits = webEdits.filter((item) => (item.at || 0) < t)
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
let paintRoleBusy = false

export function rememberPaintBox(polygon, { union = false, subtract = false } = {}) {
  const box = iframeUnionBox([polygon])
  if (!box || box.w < 6 || box.h < 6) return lastPaintBox
  if (subtract) return lastPaintBox
  lastPaintBox = union && lastPaintBox ? unionBoxes(lastPaintBox, box) : box
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

function itemMetrics(el) {
  const r = el.getBoundingClientRect()
  return {
    w: r.width,
    h: r.height,
    img: Boolean(el.querySelector?.('img, svg, picture, canvas, video')),
    text: textOf(el).length,
  }
}

function similarRepeatingSiblings(el) {
  const parent = el?.parentElement
  if (!parent || parent === el.ownerDocument?.body) return []
  const mine = itemMetrics(el)
  if (mine.w < 28 || mine.h < 24) return []
  return significantChildren(parent).filter((sib) => {
    if (sib === el) return false
    const n = itemMetrics(sib)
    const dw = Math.abs(mine.w - n.w) / Math.max(mine.w, n.w, 1)
    const dh = Math.abs(mine.h - n.h) / Math.max(mine.h, n.h, 1)
    if (dw > 0.58 && dh > 0.58) return false
    if (mine.img && n.img) return true
    if (!mine.img && !n.img) return dw < 0.42 && dh < 0.48
    return dw < 0.4 && dh < 0.45
  })
}

function itemTooBig(el) {
  const r = el.getBoundingClientRect()
  const iframe = frameEl()
  const fw = iframe?.clientWidth || 1
  const fh = iframe?.clientHeight || 1
  if (r.width > fw * 0.72) return true
  if (r.height > fh * 0.78) return true
  if (r.width * r.height > 480 * 620) return true
  return false
}

function isRepeatingItem(el) {
  if (!el || el === el.ownerDocument?.body || el === el.ownerDocument?.documentElement) return false
  if (itemTooBig(el) || containsStackedStrips(el) || isChromeStrip(el)) return false
  return similarRepeatingSiblings(el).length >= 1
}

function isCoherentBundle(el) {
  if (!el || itemTooBig(el) || containsStackedStrips(el) || isChromeStrip(el)) return false
  const r = el.getBoundingClientRect()
  if (r.width < 36 || r.height < 36) return false
  const media = [...(el.querySelectorAll?.('img, svg, picture, canvas, video') || [])].filter((n) => areaOf(n) > 400)
  if (media.length !== 1) return false
  const t = textOf(el)
  if (t.length < 1 || t.length > 280) return false
  const imgA = areaOf(media[0])
  const elA = areaOf(el)
  if (imgA < elA * 0.16 || imgA > elA * 0.97) return false
  if (significantChildren(el).length > 10) return false
  return true
}

function itemUnitOf(el) {
  let cur = el
  let best = null
  for (let i = 0; i < 8 && cur && cur !== cur.ownerDocument?.body; i += 1) {
    if (isRepeatingItem(cur) || isCoherentBundle(cur)) best = cur
    cur = cur.parentElement
  }
  return best
}

function isItemLevelOp(kind) {
  const k = String(kind || '')
  if (k === 'delete' || k === 'delete-image') return true
  if (k === 'move-layout' || k.startsWith('nudge-')) return true
  if (k === 'scale-up' || k === 'scale-down') return true
  return false
}

function paintTouchesUnit(unit, box, seeds) {
  if (!unit) return false
  if (!box) return seeds.some((el) => el === unit || unit.contains(el))
  const hit = overlapScore(unit, box)
  if (centerInPaint(unit, box) || hit.coverEl >= 0.28 || hit.coverBox >= 0.16) return true
  const vis = unit.querySelector?.('img, svg, picture, canvas, video')
  if (vis) {
    const vh = overlapScore(vis, box)
    if (centerInPaint(vis, box) || vh.coverEl >= 0.16 || vh.coverBox >= 0.08) return true
  }
  return seeds.some((el) => el === unit || unit.contains(el))
}

function cohereItemTargets(els, box, kind) {
  if (!isItemLevelOp(kind)) return els
  const live = uniqueEls((els || []).filter((el) => el?.isConnected))
  if (!live.length) return live
  const units = []
  for (const el of live) {
    const unit = itemUnitOf(el)
    const pick = unit && paintTouchesUnit(unit, box, live) ? unit : el
    if (!units.includes(pick)) units.push(pick)
  }
  return uniqueEls(units)
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
  return isRegionStroke(pts)
}

function isHandwritingPaint(mark) {
  const pts = mark?.points
  if (pts?.length >= 6 && isRegionStroke(pts)) return false
  if (mark?.role === 'symbol') return true
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
  const anyText = hits.some(
    (h) => isTextEl(h.el) && textOf(h.el).length >= 2 && (h.coverEl >= 0.08 || centerInPaint(h.el, box) || h.coverBox >= 0.04),
  )
  const blank = fill < 0.16 && !coreImages && !coreTexts.length && !anyText
  const kind = blank ? 'blank' : coreImages && (coreTexts.length || anyText) ? 'mixed' : coreImages ? 'image' : coreTexts.length || anyText ? 'text' : 'blank'
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
  const paints = getPaintMarks().filter(
    (m) => m.points?.length >= 3 && m.role !== 'subtract' && !isHandwritingPaint(m),
  )
  const lassos = paints.filter((m) => m.role !== 'symbol' && (looksLikeLassoStroke(m.points) || m.role === 'add'))
  return lassos.length ? lassos : paints
}

export function subtractPolys() {
  return polysOfMarks(
    getPaintMarks().filter((m) => m.role === 'subtract' && m.points?.length >= 3 && !isHandwritingPaint(m)),
  )
}

function spanHitsHoles(span, holes) {
  if (!holes?.length) return false
  const r = span?.screenRect || span?.imageRect
  return Boolean(r && holes.some((poly) => boxHitsPolygon(r, poly)))
}

function classifyPaintRoles(marks = paintLassoMarks()) {
  const all = marks || []
  const key = paintBoxKey(all)
  if (paintRoleCache.key === key && paintRoleCache.val) return paintRoleCache.val
  if (paintRoleBusy) return { sources: all, dests: [], all }
  if (all.length < 2) {
    const val = { sources: all, dests: [], all }
    paintRoleCache = { key, val }
    return val
  }
  paintRoleBusy = true
  try {
    const scored = all.map((m) => {
      const poly = m.points.length >= 3 ? paintHitPolygon(m.points) : m.points
      const box = aabb(m.points)
      const iframe = iframeUnionBox([poly])
      const scene = sceneFromIframeBox(iframe)
      const hits = hitWebDoc(poly, { loose: true })
      const n = (hits.images?.found?.length || 0) + (hits.texts?.found?.length || 0)
      return { mark: m, box, poly, scene, n, blank: scene.blank || scene.fill < 0.28 }
    })
    const isAdd = (s) => s.mark.role === 'add'
    const dests = scored.filter((s) => s.blank && !isAdd(s))
    const sources = scored.filter((s) => !s.blank || isAdd(s))
    let val
    if (dests.length && sources.length) {
      val = { sources: sources.map((s) => s.mark), dests: dests.map((s) => s.mark), all }
    } else {
      scored.sort((a, b) => b.n - a.n || a.box.w * a.box.h - b.box.w * b.box.h)
      const primary = scored[0]
      const extra = scored.slice(1).filter(
        (s) =>
          !isAdd(s) &&
          boxesFar(primary.box, s.box) &&
          (s.n < primary.n || s.scene.fill < primary.scene.fill * 0.7),
      )
      val = extra.length
        ? { sources: [primary.mark], dests: extra.map((s) => s.mark), all }
        : { sources: all, dests: [], all }
    }
    paintRoleCache = { key, val }
    return val
  } finally {
    paintRoleBusy = false
  }
}

function polysOfMarks(marks) {
  const polys = []
  for (const mark of marks || []) {
    if (!mark?.points?.length) continue
    polys.push(mark.points.length >= 3 ? paintHitPolygon(mark.points) : mark.points)
  }
  return polys
}

export function lassoPolys() {
  const roles = classifyPaintRoles()
  const source = roles.sources.length ? roles.sources : roles.all
  const polys = polysOfMarks(source)
  if (polys.length) return polys
  const symbols = getPaintMarks().filter((m) => m.role === 'symbol' && m.points?.length >= 3)
  if (symbols.length) return polysOfMarks(symbols)
  const destIds = new Set(getSnapshot().spans.filter((s) => s.layoutRole === 'dest').map((s) => s.markId))
  for (const span of getSnapshot().spans) {
    if (span.layoutRole === 'dest' || destIds.has(span.markId)) continue
    if (span.poly?.length) polys.push(span.poly)
  }
  return polys
}

function spanPoly(span) {
  const r = liveScreenRect(span)
  if (!r || r.w < 2 || r.h < 2) return null
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ]
}

function editRegionBox() {
  const fromDraw = iframeUnionBox(drawingPolys())
  if (fromDraw && fromDraw.w >= 4 && fromDraw.h >= 4) return fromDraw
  const symbols = polysOfMarks(getPaintMarks().filter((m) => m.role === 'symbol' && m.points?.length >= 3))
  const fromSymbol = iframeUnionBox(symbols)
  if (fromSymbol && fromSymbol.w >= 4 && fromSymbol.h >= 4) return fromSymbol
  const fromSpans = iframeUnionBox(
    getSnapshot()
      .spans.filter((s) => s.webId && s.kind !== 'slot' && s.willEdit !== false)
      .map(spanPoly)
      .filter(Boolean),
  )
  if (fromSpans && fromSpans.w >= 4 && fromSpans.h >= 4) return fromSpans
  return lastPaintBox
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
    const poly = mark.points.length >= 3 ? paintHitPolygon(mark.points) : mark.points
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

// Brush strokes are stored in the imported document's coordinate space rather
// than in the browser viewport. This keeps them attached to the page while it
// scrolls and lets downstream interpreters compare them with DOM geometry.
export function screenToWebDocumentPoint(point) {
  const frame = iframeBox()
  if (!frame || !point) return { x: point?.x || 0, y: point?.y || 0 }
  const z = iframeZoom()
  const scroll = iframeScroll()
  return {
    x: (point.x - frame.left) / z + scroll.x,
    y: (point.y - frame.top) / z + scroll.y,
  }
}

export function webDocumentToScreenPoint(point) {
  const frame = iframeBox()
  if (!frame || !point) return { x: point?.x || 0, y: point?.y || 0 }
  const z = iframeZoom()
  const scroll = iframeScroll()
  return {
    x: frame.left + (point.x - scroll.x) * z,
    y: frame.top + (point.y - scroll.y) * z,
  }
}

export function webDocumentRectToScreen(rect) {
  if (!rect) return null
  const a = webDocumentToScreenPoint({ x: rect.x, y: rect.y })
  const b = webDocumentToScreenPoint({ x: rect.x + (rect.w || 0), y: rect.y + (rect.h || 0) })
  return { x: a.x, y: a.y, w: Math.max(0, b.x - a.x), h: Math.max(0, b.y - a.y) }
}

export function screenToWebDocumentRect(rect) {
  if (!rect) return null
  const a = screenToWebDocumentPoint({ x: rect.x, y: rect.y })
  const b = screenToWebDocumentPoint({ x: rect.x + (rect.w || 0), y: rect.y + (rect.h || 0) })
  return { x: a.x, y: a.y, w: Math.max(0, b.x - a.x), h: Math.max(0, b.y - a.y) }
}

export function resolveBrushLayoutRect(reference) {
  if (!reference) return null
  if (reference.kind === 'page') {
    // Page fallback adapts horizontal position, not the full document height:
    // content reflow far below a free stroke must not move it vertically.
    return { x: 0, y: 0, w: (frameEl()?.clientWidth || 0) / iframeZoom(), h: 1 }
  }
  const rects = (reference.objects || []).flatMap((item) => {
    const el = findByWebId(item.webId)
    if (!el?.isConnected) return []
    if (item.ranges?.length) {
      const entries = normalizedCharEntries(el)
      return item.ranges.flatMap((range) => entries.slice(range.start, range.end)
        .map((entry) => screenToWebDocumentRect(toViewport(entry.rect))).filter(validLayoutRect))
    }
    const rect = screenToWebDocumentRect(toViewport(el.getBoundingClientRect()))
    return validLayoutRect(rect) ? [rect] : []
  })
  // Do not partially warp a multi-object gesture if one object disappears.
  if (!rects.length || (reference.objects || []).some((item) => !findByWebId(item.webId)?.isConnected)) return null
  return rects.reduce((union, rect) => union ? unionBoxes(union, rect) : rect, null)
}

export function attachBrushLayoutAnchor(stroke, hitTargets = []) {
  if (!isWebDocActive() || !stroke.points?.length) return stroke
  const bounds = aabb(stroke.points)
  const objects = hitTargets.flatMap((target) => {
    const rect = screenToWebDocumentRect(liveScreenRect(target))
    if (!validLayoutRect(rect)) return []
    const overlap = intersectBoxes(bounds, rect)
    const coverage = overlap ? overlap.w * overlap.h / (rect.w * rect.h) : 0
    if (coverage >= 0.35) return [{ webId: target.webId }]
    // A short underline/strike follows its exact characters, not an entire
    // paragraph. A blank-area box must not attach to a loose incidental hit.
    if (!stroke.closed && target.markedRanges?.length) {
      return [{ webId: target.webId, ranges: target.markedRanges.map(({ start, end }) => ({ start, end })) }]
    }
    return []
  })
  let reference = objects.length ? { kind: 'objects', objects } : null
  if (!reference) {
    const center = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }
    // Blank marks belong to their local layout container (card/section), so
    // they also follow vertical reflow above them without selecting that DOM.
    let smallest = null
    for (const el of getDoc().body.querySelectorAll('section,article,main,div,li,td')) {
      const rect = screenToWebDocumentRect(toViewport(el.getBoundingClientRect()))
      if (!validLayoutRect(rect) || el.ownerDocument.defaultView.getComputedStyle(el).pointerEvents === 'none') continue
      if (center.x < rect.x || center.x > rect.x + rect.w || center.y < rect.y || center.y > rect.y + rect.h) continue
      if (rect.w < bounds.w * 0.5 || rect.h < bounds.h * 0.5) continue
      if (!smallest || rect.w * rect.h < smallest.area) smallest = { el, area: rect.w * rect.h }
    }
    reference = smallest ? { kind: 'objects', objects: [{ webId: smallest.el.getAttribute('data-markset-id') }] } : { kind: 'page' }
  }
  return anchorBrushStroke(stroke, reference, resolveBrushLayoutRect(reference))
}

export function refreshBrushTargetGeometry(target) {
  const el = findByWebId(target.webId)
  if (!el?.isConnected) return target
  const fresh = spanFromEl(el, target.kind)
  // Preserve user-selected character ranges and explicit exclusions; resizing
  // is not a hit test and must never select extra objects or characters.
  return { ...target, screenRect: fresh.screenRect, documentRect: fresh.documentRect,
    imageRect: fresh.imageRect, charRects: fresh.charRects, context: fresh.context }
}

export function observeBrushPage(group) {
  return readPageObservation(getDoc(), group.targets || [], group.strokes || [], (el) => screenToWebDocumentRect(toViewport(el.getBoundingClientRect())))
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
  const nested = el.querySelector?.('img')
  if (nested && looksLikeCoverGraphic(nested)) return true
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

function coverGraphicOf(el) {
  if (!el?.isConnected) return null
  if (el.tagName === 'IMG' || el.tagName === 'CANVAS' || el.tagName === 'VIDEO' || el.tagName === 'SVG') return el
  if (el.tagName === 'PICTURE') return el.querySelector('img') || el
  const img = el.querySelector?.('img, canvas, video, svg, picture')
  if (img) return img.tagName === 'PICTURE' ? img.querySelector('img') || img : img
  let cur = el
  for (let i = 0; i < 6 && cur && cur !== cur.ownerDocument?.body; i += 1) {
    if (hasPaintedBg(cur) && areaOf(cur) > 80 * 80 && areaOf(cur) < 520 * 720) return cur
    cur = cur.parentElement
  }
  return hasPaintedBg(el) ? el : null
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

function isTextBlock(el) {
  if (!el || !isTextEl(el) || isGraphicEl(el)) return false
  if (/^(P|LI|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|TD|TH|FIGCAPTION|PRE|DT|DD|LABEL)$/.test(el.tagName)) return true
  if (el.tagName === 'A' && textOf(el).length >= 8 && !el.querySelector?.('img, svg, picture, video')) return true
  if (el.tagName === 'DIV' || el.tagName === 'SPAN' || el.tagName === 'SECTION') {
    if (textOf(el).length < 8) return false
    const blocks = [...(el.children || [])].filter((k) => /^(P|UL|OL|DIV|SECTION|ARTICLE|H1|H2|H3|H4)$/.test(k.tagName))
    if (blocks.length >= 2) return false
    return isPrimarilyText(el)
  }
  return false
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
  const inside = pts.filter((p) => pointInPolygon(p.x, p.y, poly))
  if (inside.length) return inside
  return pts.slice(0, 9)
}

function normalizedCharEntries(el) {
  const nodes = visibleTextNodes(el)
  const raw = []
  for (const node of nodes) {
    const value = String(node.nodeValue || '')
    for (let offset = 0; offset < value.length; offset += 1) {
      const range = el.ownerDocument.createRange()
      let rect = null
      try {
        range.setStart(node, offset)
        range.setEnd(node, offset + 1)
        const box = range.getBoundingClientRect()
        if (box.width || box.height) rect = { x: box.x, y: box.y, w: box.width, h: box.height }
      } catch { /* a detached text node can be skipped */ }
      if (!rect) {
        const box = node.parentElement?.getBoundingClientRect?.()
        if (box) rect = { x: box.x, y: box.y, w: box.width, h: box.height }
      }
      raw.push({ node, offset, char: value[offset], rect })
    }
  }
  const entries = []
  let pendingSpace = null
  for (const item of raw) {
    if (/\s/u.test(item.char)) {
      if (entries.length && !pendingSpace) pendingSpace = item
      continue
    }
    if (pendingSpace) {
      entries.push({ char: ' ', node: pendingSpace.node, offset: pendingSpace.offset, rect: pendingSpace.rect })
      pendingSpace = null
    }
    entries.push({ char: item.char, node: item.node, offset: item.offset, rect: item.rect })
  }
  if (entries.length && entries[entries.length - 1].char === ' ') entries.pop()
  return entries
}

function rectToSpan(rect) {
  if (!rect) return null
  const screen = toViewport({ left: rect.x, top: rect.y, width: rect.w, height: rect.h })
  const documentRect = screen ? screenToWebDocumentRect(screen) : null
  return {
    x: rect.x, y: rect.y, w: rect.w, h: rect.h,
    screenRect: screen, documentRect,
  }
}

function markedTextRanges(entries, poly) {
  if (!entries.length || !poly?.length) return []
  const paintBox = aabb(poly)
  const hit = entries.map((entry) => {
    const rect = entry.rect
    if (!rect || !rect.w || !rect.h) return false
    const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
    if (pointInPolygon(center.x, center.y, poly)) return true
    const overlap = intersectBoxes(rect, paintBox)
    // A thin strike-through often intersects only a few pixels of a glyph.
    // The AABB test is intentionally permissive here; the model receives the
    // exact ranges and the executor validates them again before mutation.
    return Boolean(overlap && overlap.w >= Math.min(2, rect.w) && overlap.h >= 1)
  })
  const ranges = []
  let start = -1
  for (let i = 0; i <= hit.length; i += 1) {
    const isHit = i < hit.length && hit[i]
    if (isHit && start < 0) start = i
    if ((!isHit || i === hit.length) && start >= 0) {
      let end = i
      while (end > start && entries[end - 1].char === ' ') end -= 1
      if (end > start) {
        const text = entries.slice(start, end).map((entry) => entry.char).join('')
        if (text.trim()) ranges.push({ start, end, text, coverage: Number(((end - start) / Math.max(1, entries.length)).toFixed(3)) })
      }
      start = -1
    }
  }
  return ranges
}

function spanFromEl(el, kind, markPoly = null) {
  const r = el.getBoundingClientRect()
  const screen = toViewport(r)
  const id = el.getAttribute('data-markset-id') || ''
  const parent = el.parentElement
  const siblings = parent
    ? [...parent.children]
        .filter((node) => node !== el && !decoNode(node) && !isTombstone(node))
        .slice(0, 8)
        .map((node) => ({
          webId: node.getAttribute('data-markset-id') || '',
          tag: node.tagName.toLowerCase(),
          text: textOf(node).slice(0, 90),
          rect: (() => {
            const sr = toViewport(node.getBoundingClientRect())
            return sr ? { x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.w), h: Math.round(sr.h) } : null
          })(),
        }))
    : []
  const computed = el.ownerDocument?.defaultView?.getComputedStyle?.(el)
  const context = {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || '',
    ariaLabel: el.getAttribute('aria-label') || '',
    className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
    parentTag: parent?.tagName?.toLowerCase() || '',
    parentId: parent?.getAttribute?.('data-markset-id') || '',
    display: computed?.display || '',
    layout: computed?.display === 'grid' ? 'grid' : computed?.display === 'flex' ? 'flex' : 'flow',
    siblings,
  }
  if (kind === 'image') {
    const nw = el.naturalWidth || Math.round(r.width)
    const nh = el.naturalHeight || Math.round(r.height)
    return {
      kind: 'image',
      webId: id,
      block_id: `web-img-${id}`,
      screenRect: screen,
      documentRect: screen ? screenToWebDocumentRect(screen) : null,
      imageRect: screen,
      bbox: { x: 0, y: 0, w: nw, h: nh },
      naturalSize: { w: nw, h: nh },
      mode: 'object',
      why: 'web-doc',
      context,
    }
  }
  const fullText = textOf(el)
  const text = fullText.slice(0, 800)
  const entries = normalizedCharEntries(el)
  const charRects = entries.slice(0, 1200).map((entry, index) => ({
    index,
    char: entry.char,
    ...rectToSpan(entry.rect),
  })).filter((entry) => entry.screenRect)
  const markedRanges = markedTextRanges(entries, markPoly)
  return {
    kind: 'text',
    webId: id,
    block_id: `web-${id}`,
    text,
    textTruncated: fullText.length > text.length,
    textLength: fullText.length,
    start: 0,
    end: text.length,
    charRects,
    textFragments: markedRanges.map((range) => ({ start: range.start, end: range.end, text: range.text })),
    markedRanges,
    screenRect: screen,
    documentRect: screen ? screenToWebDocumentRect(screen) : null,
    why: 'web-doc',
    context,
  }
}


/**
 * When a user draws an arrow after marking only one card, include the other
 * visible siblings as candidates. The model can only reason over supplied
 * objects, so this keeps the candidate set complete without letting it invent
 * arbitrary DOM nodes.
 */
export function expandBrushTargets(targets = [], { includePeers = false, max = 8 } = {}) {
  const base = uniqueWebTargets(targets)
  if (!includePeers || !base.length) return base
  const out = [...base]
  const seen = new Set(out.map((target) => target.webId).filter(Boolean))
  for (const target of base) {
    const el = target.webId ? findByWebId(target.webId) : null
    const parent = el?.parentElement
    const computed = parent?.ownerDocument?.defaultView?.getComputedStyle?.(parent)
    const layout = computed?.display === 'grid' ? 'grid' : computed?.display === 'flex' ? 'flex' : ''
    const siblings = parent ? [...parent.children] : []
    const eligible = siblings
      .filter((node) => node !== el && !decoNode(node) && !isTombstone(node))
      .filter((node) => {
        const r = node.getBoundingClientRect()
        return r.width >= 12 && r.height >= 12 && (isImageEl(node) || isTextBlock(node) || isWidgetEl(node) || isGraphicEl(node))
      })
      .filter((node) => layout || node.tagName === el?.tagName)
      .slice(0, Math.max(0, max - out.length))
    for (const node of eligible) {
      const webId = node.getAttribute('data-markset-id')
      if (!webId || seen.has(webId)) continue
      const kind = isImageEl(node) || isGraphicEl(node) ? 'image' : 'text'
      const candidate = spanFromEl(node, kind)
      if (!candidate?.webId) continue
      seen.add(candidate.webId)
      out.push(candidate)
      if (out.length >= max) return out
    }
  }
  return out
}

function uniqueWebTargets(targets = []) {
  const out = []
  const seen = new Set()
  for (const target of targets) {
    if (!target?.webId || seen.has(target.webId)) continue
    seen.add(target.webId)
    out.push(target)
  }
  return out
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

function considerEl(el, frameArea, seen, poly, { minCover = 0.08 } = {}) {
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
  const leaves = items.filter((h) => !items.some((o) => o.el !== h.el && h.el.contains(o.el)))
  const blocks = items.filter((h) => h?.el && isTextBlock(h.el) && (h.inPoly || h.cover >= 0.22))
  if (!blocks.length) return leaves
  return items.filter((h) => {
    if (!h?.el) return false
    if (blocks.some((b) => b.el === h.el)) return true
    if (blocks.some((b) => b.el.contains(h.el))) return false
    return leaves.includes(h)
  })
}

function liftHitsToCoveredBlocks(items, poly, paintBox) {
  const paintArea = Math.max(1, (paintBox?.w || 0) * (paintBox?.h || 0))
  const region = paintArea >= 70 * 48 || Math.min(paintBox?.w || 0, paintBox?.h || 0) >= 36
  if (!region || !items.length) return items
  const out = []
  const seen = new Set()
  for (const h of items) {
    let next = h
    if (h.kind !== 'image' && h.el) {
      let cur = h.el
      let best = h
      for (let i = 0; i < 6 && cur && cur !== cur.ownerDocument?.body; i += 1) {
        if (containsOutsiders(cur, paintBox, [poly])) break
        if (isTextBlock(cur)) {
          const cover = polygonCover(cur, poly)
          const inPoly = centerInPoly(cur, poly)
          const area = areaOf(cur)
          if (area > paintArea * 8) break
          if (cover >= 0.26 || (inPoly && cover >= 0.12)) {
            best = {
              ...h,
              el: cur,
              area,
              kind: 'text',
              cover,
              inPoly,
              overlap: Math.max(h.overlap || 0, cover),
              score: cover + (inPoly ? 0.35 : 0),
            }
          }
        }
        cur = cur.parentElement
      }
      next = best
    }
    const id = next.el?.getAttribute?.('data-markset-id') || next.el
    if (seen.has(id)) continue
    seen.add(id)
    out.push(next)
  }
  return dropAncestors(out)
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
  const paintBox0 = aabb(poly)
  const compact = paintBox0.w * paintBox0.h < 90 * 90 || Math.max(paintBox0.w, paintBox0.h) < 72
  const regionSelect = paintBox0.w * paintBox0.h >= 70 * 48 || Math.min(paintBox0.w, paintBox0.h) >= 36
  const minCover = compact && !regionSelect ? 0.03 : loose ? 0.08 : 0.1
  for (const p of sampleHitPoints(poly)) {
    let stack = []
    try {
      stack = doc.elementsFromPoint(p.x, p.y) || []
    } catch {
      const one = doc.elementFromPoint(p.x, p.y)
      if (one) stack = [one]
    }
    for (const el of stack.slice(0, compact ? 12 : 8)) considerEl(el, frameArea, seen, poly, { minCover })
  }
  if (!seen.size) scanMarked(poly, frameArea, seen, minCover)
  if ((loose || compact) && !seen.size) scanMarked(inflatePoly(poly, compact ? 22 : 8), frameArea, seen, compact ? 0.04 : 0.12)
  const paintArea = Math.max(1, paintBox0.w * paintBox0.h)
  const paintBox = paintBox0
  let items = tightenHits([...seen.values()], poly, { loose: loose || compact })
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
  items = liftHitsToCoveredBlocks(items, poly, paintBox)
  items = items.filter((h) => {
    if (!h?.el || decoNode(h.el)) return false
    if (isGraphicEl(h.el)) return h.inPoly || h.cover >= 0.08 || h.overlap >= 0.12
    if (compact && !regionSelect) return h.inPoly || h.cover >= 0.04 || h.overlap >= 0.08 || h.area <= paintArea * 40
    return h.area <= paintArea * 14 || h.cover >= 0.22 || h.inPoly || isTextBlock(h.el)
  })
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
  if (compact && !regionSelect) items.sort((a, b) => a.area - b.area || b.score - a.score)
  else items.sort((a, b) => (b.inPoly - a.inPoly) || b.cover - a.cover || a.area - b.area)
  items = items.slice(0, regionSelect ? 12 : compact || loose ? 4 : MAX_HITS)
  const images = []
  const texts = []
  for (const hit of items) {
    if (hit.kind === 'image') images.push(spanFromEl(hit.el, 'image', poly))
    else texts.push(spanFromEl(hit.el, 'text', poly))
  }
  return {
    texts: { found: texts, suggest: [] },
    images: { found: images, suggest: [] },
  }
}

export function refreshWebTargetsFromDrawing(polygons = []) {
  const found = []
  const seen = new Set()
  const holes = subtractPolys()
  const add = (span) => {
    if (!span?.webId || seen.has(span.webId)) return
    if (spanHitsHoles(span, holes)) return
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
      if (a.rect.w * a.rect.h > ba * 1.08) return true
      if (parseFloat(a.fontSize) > (parseFloat(befores[i]?.fontSize) || 0) * 1.08) return true
      return /data-markset-scaled/.test(a.html || '') && a.html !== befores[i]?.html
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

function paintPolysForText(box) {
  const polys = currentPaintPolys()
  if (polys.length) return polys
  if (!box) return []
  return [
    [
      { x: box.x, y: box.y },
      { x: box.x + box.w, y: box.y },
      { x: box.x + box.w, y: box.y + box.h },
      { x: box.x, y: box.y + box.h },
    ],
  ]
}

function tokenHitsPaint(rect, polys) {
  if (!rect || rect.width < 1 || rect.height < 1 || !polys?.length) return false
  const box = { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  return polys.some((poly) => pointInPolygon(cx, cy, poly) || boxHitsPolygon(box, poly))
}

function inflateAabb(box, padX, padY = padX) {
  if (!box) return box
  return { x: box.x - padX, y: box.y - padY, w: box.w + padX * 2, h: box.h + padY * 2 }
}

function isCompactWordMark(mark, box) {
  if (!mark || !box) return false
  const markArea = Math.max(1, box.w * box.h)
  const region = editRegionBox()
  if (region) {
    const regionArea = Math.max(1, region.w * region.h)
    if (markArea >= regionArea * 0.28) return false
    if (box.w >= region.w * 0.72 && box.h >= region.h * 0.42) return false
    if (markArea < regionArea * 0.22 && box.h < Math.max(56, region.h * 0.32)) return true
  }
  if (isRegionStroke(mark.points) && box.w >= 100 && box.h >= 48) return false
  if (mark.role === 'select' || mark.role === 'add') return box.w < 130 && box.h < 56
  const aspect = box.w / Math.max(1, box.h)
  if ((aspect > 3.2 && box.h < 36) || (aspect < 0.35 && box.w < 36)) return true
  return box.w < 140 && box.h < 80
}

function userForcesWholeSelection(ask) {
  return /全部|所有|整段|整块|整句|选区|圈里都|圈中都|选中的?(全部|所有|内容|目标)|作用于.{0,12}(全部|所有|选区|目标|内容)/.test(
    String(ask || ''),
  )
}

function userAsksWordLevel(ask) {
  if (userForcesWholeSelection(ask)) return false
  const t = String(ask || '')
  if (/几个词|个别词|其中几个|只改这[个几]|只标这|只要这几个|某一个词|单个词|单个单词|单词上/.test(t)) return true
  if (/画[上有着]?.{0,10}(圈|圆|标|记号|标记)|作用[在于].{0,12}(词|单词)|只(改|标|作用).{0,8}(词|单词)/.test(t)) return true
  if (/[「『“"'][^」』”"']{1,40}[」』”"']/.test(t)) return true
  return false
}

function compactStrokeBox(points) {
  const poly = toIframePoly(points)
  if (!poly?.length) return null
  return aabb(poly)
}

function hasExtraWordMarks() {
  return compactMarkBoxes().length > 0
}

function compactMarkBoxes() {
  const out = []
  const seen = new Set()
  const pushBox = (box, hint) => {
    if (!box) return
    const aspect = box.w / Math.max(1, box.h)
    const lineLike = aspect > 3.2 && box.h < 40
    const padX = lineLike ? 4 : Math.max(4, Math.min(10, Math.max(box.w, box.h) * 0.16))
    const padY = lineLike ? Math.max(12, Math.min(26, box.h + 18)) : Math.max(5, Math.min(12, Math.max(box.w, box.h) * 0.2))
    const next = inflateAabb(box, padX, padY)
    const key = `${Math.round(next.x)}:${Math.round(next.y)}:${Math.round(next.w)}:${Math.round(next.h)}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(next)
  }
  for (const mark of getPaintMarks()) {
    if (!mark?.points || mark.points.length < 3 || mark.role === 'subtract') continue
    const box = compactStrokeBox(mark.points)
    if (!isCompactWordMark(mark, box)) continue
    pushBox(box, mark)
  }
  for (const stroke of getInkStrokes()) {
    if (!stroke || stroke.length < 3) continue
    const fake = { points: stroke, role: 'symbol' }
    const box = compactStrokeBox(stroke)
    if (!isCompactWordMark(fake, box)) continue
    pushBox(box, fake)
  }
  return out
}

function tokenHitsBox(rect, box) {
  if (!rect || !box) return false
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h
}

function phrasesInPaintRegion(el) {
  const box = editRegionBox()
  const polys = paintPolysForText(box)
  if (!el || !polys.length) return []
  const tokens = collectTextTokens(el)
  const hit = tokens.map((t) => t.rects.some((r) => tokenHitsPaint(r, polys)))
  const out = []
  for (let i = 0; i < tokens.length; ) {
    if (!hit[i]) {
      i += 1
      continue
    }
    let j = i + 1
    let text = tokens[i].text
    while (j < tokens.length && hit[j] && tokens[j].node === tokens[i].node && tokens[j].start === tokens[j - 1].end) {
      text += tokens[j].text
      j += 1
    }
    if (text.trim()) out.push(text.trim())
    i = j
  }
  return [...new Set(out)]
}

function wantsNamedWordsOnly(ask, _markName, scope = '') {
  return resolveAnnoWordLevel(ask, scope)
}

let annoScopeHint = ''

export function setAnnoScopeHint(scope) {
  const id = String(scope || '').trim()
  annoScopeHint = id === 'marked' || id === 'word' ? 'marked' : id === 'selection' || id === 'region' ? 'selection' : ''
}

export function inferHabitScope(ask = '') {
  return userAsksWordLevel(ask) ? 'marked' : 'selection'
}

export function resolveAnnoWordLevel(ask, habitScope = '') {
  if (userForcesWholeSelection(ask)) return false
  if (userAsksWordLevel(ask)) return true
  const scope = String(habitScope || annoScopeHint || '').trim()
  if (scope === 'marked' || scope === 'word') return true
  return false
}

function phrasesFromCompactMarks(el) {
  const boxes = compactMarkBoxes()
  if (!el || !boxes.length) return []
  const tokens = collectTextTokens(el)
  const hit = tokens.map((t) => t.rects.some((r) => boxes.some((b) => tokenHitsBox(r, b))))
  const out = []
  for (let i = 0; i < tokens.length; ) {
    if (!hit[i]) {
      i += 1
      continue
    }
    let j = i + 1
    let text = tokens[i].text
    while (j < tokens.length && hit[j] && tokens[j].node === tokens[i].node && tokens[j].start === tokens[j - 1].end) {
      text += tokens[j].text
      j += 1
    }
    if (text.trim()) out.push(text.trim())
    i = j
  }
  return [...new Set(out)]
}

function collectTextTokens(el) {
  const tokens = []
  for (const node of textNodesOf(el)) {
    const raw = node.nodeValue || ''
    let i = 0
    while (i < raw.length) {
      while (i < raw.length && /\s/.test(raw[i])) i += 1
      if (i >= raw.length) break
      let j = i + 1
      const ch = raw[i]
      if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) j = i + 1
      else if (/[A-Za-z0-9]/.test(ch)) {
        while (j < raw.length && /[A-Za-z0-9'’.-]/.test(raw[j])) j += 1
      }
      const range = el.ownerDocument.createRange()
      range.setStart(node, i)
      range.setEnd(node, j)
      tokens.push({ node, start: i, end: j, rects: [...range.getClientRects()], text: raw.slice(i, j) })
      i = j
    }
  }
  return tokens
}

function wrapPaintedWords(el, box) {
  if (!el || el.getAttribute?.('data-markset-word')) return [el]
  if (lassoIsRegionCovering(el, box)) return [el]
  const polys = paintPolysForText(box)
  if (!polys.length) return [el]
  const tokens = collectTextTokens(el)
  if (tokens.length < 2) return [el]
  const hit = tokens.map((t) => t.rects.some((r) => tokenHitsPaint(r, polys)))
  const hitN = hit.filter(Boolean).length
  if (!hitN || hitN >= Math.max(2, tokens.length * 0.78)) return [el]
  const runs = []
  for (let i = 0; i < tokens.length; ) {
    if (!hit[i]) {
      i += 1
      continue
    }
    let j = i + 1
    while (
      j < tokens.length &&
      hit[j] &&
      tokens[j].node === tokens[i].node &&
      tokens[j].start === tokens[j - 1].end
    ) {
      j += 1
    }
    runs.push({ node: tokens[i].node, start: tokens[i].start, end: tokens[j - 1].end })
    i = j
  }
  const spans = []
  const doc = el.ownerDocument
  for (let r = runs.length - 1; r >= 0; r -= 1) {
    const run = runs[r]
    if (!run.node?.parentNode) continue
    const range = doc.createRange()
    try {
      range.setStart(run.node, run.start)
      range.setEnd(run.node, run.end)
      const span = doc.createElement('span')
      span.setAttribute('data-markset-word', '1')
      range.surroundContents(span)
      spans.push(span)
    } catch {
      /* skip ranges that the DOM won't wrap */
    }
  }
  if (spans.length) stampIds(doc)
  return spans.length ? spans.reverse() : [el]
}

function lassoIsRegionCovering(el, box) {
  const marks = getPaintMarks().filter((m) => m.role !== 'subtract' && m.points?.length >= 6)
  const region = marks.some((m) => isRegionStroke(m.points))
  if (!region) {
    if (!box) return false
    return box.w * box.h >= 90 * 56 && Math.min(box.w, box.h) >= 36
  }
  if (!el || !box) return true
  const hit = overlapScore(el, box)
  return hit.coverEl >= 0.18 || hit.coverBox >= 0.1 || centerInPaint(el, box)
}

function narrowToPaintedText(els, box) {
  if (!wantsNamedWordsOnly('', '')) return uniqueEls((els || []).filter((el) => el?.isConnected))
  if (lassoIsRegionCovering(null, box)) return uniqueEls((els || []).filter((el) => el?.isConnected))
  const out = []
  for (const el of els || []) {
    if (!el?.isConnected) continue
    if (!(isTextEl(el) && !isGraphicEl(el))) {
      out.push(el)
      continue
    }
    out.push(...wrapPaintedWords(el, box))
  }
  return uniqueEls(out)
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
    return polysOfMarks(paintLassoMarks())
      .map((p) => toIframePoly(p))
      .filter((p) => p?.length >= 3)
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
    return paintCover(el, polys) >= 0.32
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
  const aimed = drilled.filter((el) => aimedLeaf(el, box))
  const centered = drilled.filter((el) => centerInPaint(el, box) && overlapScore(el, box).coverEl >= 0.28)
  const picked = inInk.length
    ? inInk
    : aimed.length
      ? aimed
      : centered.length
        ? centered
        : drilled
  return liftToCoveredBlocks(dropCoveringAncestors(picked), box)
}

function liftToCoveredBlocks(els, box) {
  const live = uniqueEls((els || []).filter((el) => el?.isConnected))
  if (!live.length || !box) return live
  const paintArea = box.w * box.h
  if (paintArea < 70 * 48 && Math.min(box.w, box.h) < 36) return live
  const polys = currentPaintPolys()
  const out = []
  for (const el of live) {
    if (isGraphicEl(el) && !isPrimarilyText(el)) {
      out.push(el)
      continue
    }
    let cur = el
    let best = el
    for (let i = 0; i < 6 && cur && cur !== cur.ownerDocument?.body; i += 1) {
      if (containsOutsiders(cur, box, polys)) break
      if (isTextBlock(cur)) {
        const cover = polys.length ? paintCover(cur, polys) : overlapScore(cur, box).coverEl
        const area = areaOf(cur)
        if (area > paintArea * 8) break
        if (cover >= 0.26 || (centerInPaint(cur, box) && cover >= 0.12)) best = cur
      }
      cur = cur.parentElement
    }
    out.push(best)
  }
  return uniqueEls(dropCoveringAncestors(out))
}

function staysInPaint(el, box) {
  if (!el || !box) return false
  const polys = currentPaintPolys()
  if (containsOutsiders(el, box, polys)) return false
  if (polys.length) {
    const cover = paintCover(el, polys)
    if (cover < 0.38) return false
    if (!polys.some((poly) => centerInPoly(el, poly)) && cover < 0.62) return false
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
    if (polys.some((poly) => centerInPoly(el, poly))) return cover >= 0.08
    return cover >= 0.28 || (isGraphicEl(el) && cover >= 0.16)
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
  const holes = subtractPolys()
  const box = iframeUnionBox(polys)
  const found = []
  for (const poly of polys) {
    if (!poly?.length) continue
    const hits = hitWebDoc(poly, { loose: true })
    for (const s of [...(hits.images?.found || []), ...(hits.texts?.found || [])]) {
      if (spanHitsHoles(s, holes)) continue
      const el = findByWebId(s.webId)
      if (el?.isConnected) found.push(el)
    }
  }
  if (box) found.push(...elsFromKnownSpans(box))
  found.push(...editTargetEls())
  const notInHoles = (el) => {
    if (!holes.length) return true
    const r = toViewport(el.getBoundingClientRect())
    return !r || !holes.some((poly) => boxHitsPolygon(r, poly))
  }
  let els = uniqueEls(found).filter((el) => el?.isConnected && el !== el.ownerDocument?.body && notInHoles(el))
  if (!els.length && box) els = fallbackEls(box, kind).filter(notInHoles)
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
    } else if (
      kind === 'highlight' ||
      kind === 'bold' ||
      kind === 'underline' ||
      kind === 'wavy' ||
      kind === 'strike' ||
      kind === 'frame' ||
      kind === 'box' ||
      kind === 'circle' ||
      String(kind).startsWith('line')
    ) {
      const asRegion = large || lassoIsRegionCovering(null, box)
      els = pickContentEls(hits, box, frameArea, { large: asRegion, kind: 'color-text' })
      if (!els.length) els = leafEls(hits, box).filter((el) => isPrimarilyText(el))
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
  const worded = applyWordScopedOp(els, kind, { title, color })
  if (worded) return worded
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
  let box = editRegionBox()
  const kind = String(op || '')
  if ((!box || box.w < 8 || box.h < 8) && kind.startsWith('delete')) {
    const pts = getPaintMarks()
      .filter((m) => m.points?.length >= 3 && m.role !== 'subtract')
      .map((m) => m.points)
    const union = iframeUnionBox(pts)
    if (union) box = inflateAabb(union, 32, 32)
  }
  if (kind.startsWith('delete') && box && Math.max(box.w, box.h) < 140) box = inflateAabb(box, 40, 40)
  if (!box || box.w < 4 || box.h < 4) return { ok: false, reason: '没有可用的圈。请再圈一次要改的地方' }
  stampIds(doc)
  const frameArea = Math.max(1, iframe.clientWidth * iframe.clientHeight)
  const hits = scanOverlapEls(box)
  const paintArea = box.w * box.h
  const large = paintArea > frameArea * 0.07 || Math.max(box.w, box.h) > 200
  const title = label || kind
  const html = snapshotWebHtml()
  const strategies = kind.startsWith('delete')
    ? ['circled', 'tight', 'graphics', 'texts', 'module', 'near', 'fallback']
    : ['circled', 'tight', 'graphics', 'texts', 'module', 'fallback']
  const seen = new Set()
  for (const strategy of strategies) {
    if (strategy !== 'circled') restoreWebHtml(html)
    const raw = (() => {
      if (strategy === 'near' && kind.startsWith('delete')) {
        const near = nearestToBox(box)
        return near ? uniqueEls([rewriteHostOf(near) || near]) : []
      }
      const picked = elsByStrategy(kind, title, box, scanOverlapEls(box), frameArea, large, strategy)
      if (kind !== 'scheme') return picked
      const wrap = pickSchemeWrap(picked, box)
      return wrap ? uniqueEls([wrap, ...picked]) : picked
    })()
    const els = (() => {
      let picked = keepPaintTargets(raw, box)
      const wordScoped = resolveAnnoWordLevel(title, annoScopeHint) && isWordScopedTextOp(kind)
      if (isItemLevelOp(kind) && !wordScoped) picked = cohereItemTargets(picked, box, kind)
      else if (
        kind === 'color' ||
        kind === 'color-text' ||
        kind === 'highlight' ||
        kind === 'bold' ||
        kind === 'underline' ||
        kind === 'wavy' ||
        kind === 'strike' ||
        String(kind).startsWith('line') ||
        wordScoped
      ) {
        picked = narrowToPaintedText(picked, box)
      }
      return picked
    })()
    if (!els.length) continue
    const key = `${strategy}:${els.map((el) => el.getAttribute('data-markset-id') || el.tagName).join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    const beforeEv = els.map((el) => evidenceOf(el))
    const before = els.map((el) => snapshotNode(el))
    const applied = applyOpToEls(els, kind, { color, title, box, dx, dy, scheme, paint })
    if (applied.reason && !applied.count) {
      if (resolveAnnoWordLevel(title, annoScopeHint) && isWordScopedTextOp(kind)) {
        return { ok: false, reason: applied.reason }
      }
      continue
    }
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

function unwrapInnerAnno(el) {
  const list = [...(el.querySelectorAll?.('[data-markset-anno], [data-markset-word]') || [])]
  for (const n of list.reverse()) {
    if (!n.parentNode || n === el) continue
    const parent = n.parentNode
    while (n.firstChild) parent.insertBefore(n.firstChild, n)
    parent.removeChild(n)
  }
}

function applyAnnoToSelection(els, kind) {
  let n = 0
  let doc = null
  for (const el of els || []) {
    if (!el?.isConnected) continue
    unwrapInnerAnno(el)
    el.setAttribute('data-markset-anno', kind)
    doc = el.ownerDocument
    n += 1
  }
  if (doc) stampIds(doc)
  return n
}

function collectSelectionTextEls() {
  const box = editRegionBox() || iframeUnionBox(drawingPolys())
  const doc = getDoc()
  const iframe = frameEl()
  if (!doc?.body) return []
  const frameArea = Math.max(1, (iframe?.clientWidth || 1) * (iframe?.clientHeight || 1))
  const hits = box ? scanOverlapEls(box) : []
  let els = []
  if (box) {
    els = gatherEls('highlight', '高亮', box, hits, frameArea, true)
    if (!els.length) els = pickContentEls(hits, box, frameArea, { large: true, kind: 'color-text' })
    if (!els.length) els = leafEls(hits, box)
  }
  const usable = (el) => el && isTextEl(el) && !isImageEl(el) && textOf(el).length >= 2
  const hosts = dropCoveringAncestors(
    uniqueEls(keepPaintTargets(els, box).map((el) => rewriteHostOf(el) || el)).filter(usable),
  )
  if (hosts.length) return hosts.slice(0, 8)
  return dropCoveringAncestors(
    hits.map((h) => rewriteHostOf(h.el) || h.el).filter(usable),
  ).slice(0, 8)
}

function rewriteHostOf(el) {
  if (!el) return null
  const climb = (start) => {
    let p = start
    for (let i = 0; i < 6 && p && p !== p.ownerDocument?.body; i += 1) {
      if (/^(P|LI|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|TD|TH|FIGCAPTION|ARTICLE|LABEL)$/.test(p.tagName) && textOf(p).length >= 2) {
        return p
      }
      if (
        p.tagName === 'DIV' &&
        isPrimarilyText(p) &&
        textOf(p).length >= 8 &&
        textOf(p).length < 900 &&
        significantChildren(p).length <= 4
      ) {
        return p
      }
      p = p.parentElement
    }
    return start
  }
  if (el.getAttribute?.('data-markset-word')) return climb(el.parentElement) || el
  if (el.getAttribute?.('data-markset-anno') && !/^(P|LI|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|ARTICLE)$/.test(el.tagName)) {
    return climb(el.parentElement) || climb(el) || el
  }
  if (/^(SPAN|EM|STRONG|B|I|A|SMALL)$/.test(el.tagName) && textOf(el).length < 80) return climb(el) || el
  return el
}

function collectRewriteEls() {
  return collectSelectionTextEls()
}

function circledTextExcerpt(hosts, box) {
  const bits = []
  for (const el of hosts || []) {
    if (!(isTextEl(el) && !isGraphicEl(el))) continue
    for (const w of wrapPaintedWords(el, box)) {
      if (w.getAttribute?.('data-markset-word')) bits.push(textOf(w))
    }
  }
  return [...new Set(bits.filter(Boolean))].join(' ')
}

function applyRewriteResult(el, original, next, excerpt) {
  const a = String(original || '').replace(/\s+/g, ' ').trim()
  const b = String(next || '').replace(/\s+/g, ' ').trim()
  if (!b || b === a) return false
  if (b.length >= Math.max(12, a.length * 0.42)) return replaceText(el, original, next)
  if (excerpt && a.includes(excerpt) && excerpt !== b) {
    if (replaceText(el, excerpt, b)) return true
    const patched = a.split(excerpt).join(b)
    if (patched !== a) return replaceText(el, original, patched)
  }
  const words = [...(el.querySelectorAll?.('[data-markset-word]') || [])]
  if (words.length === 1 && textOf(words[0]).length >= 1) return replaceText(words[0], textOf(words[0]), b)
  return false
}

async function rewriteSceneExtras() {
  let imageDataUrls = []
  let pageContext = ''
  try {
    pageContext = insertAroundCopy()
  } catch {
    pageContext = ''
  }
  try {
    const { captureInsertScene } = await import('./capture.js')
    const scene = await captureInsertScene()
    imageDataUrls = [scene.aroundImageDataUrl, scene.circledImageDataUrl, scene.pageImageDataUrl].filter(Boolean)
    pageContext = [pageContext, scene.pageText].filter(Boolean).join('\n').slice(0, 1800)
  } catch {
    /* screenshots are optional; instruction still goes to the model */
  }
  return { imageDataUrls, pageContext }
}

async function annotateSceneExtras() {
  const insert = await rewriteSceneExtras()
  try {
    const { captureAnnotationScene } = await import('./capture.js')
    const scene = await captureAnnotationScene()
    const imageDataUrls = [
      scene.inkCloseupDataUrl,
      scene.closeupDataUrl,
      scene.combinedDataUrl,
      ...(insert.imageDataUrls || []),
    ].filter((url, i, arr) => url && arr.indexOf(url) === i)
    return {
      mode: 'annotate',
      imageDataUrls: imageDataUrls.slice(0, 3),
      pageContext: insert.pageContext || String(scene.pageText || '').slice(0, 1800),
    }
  } catch {
    return { ...insert, mode: 'annotate' }
  }
}

export async function rewriteCircledText(commandText, { onBefore, kind = 'polish', imageDataUrls = [], pageContext = '' } = {}) {
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
  const box = iframeUnionBox(drawingPolys())
  const excerpt = wantsNamedWordsOnly(commandText, '') ? circledTextExcerpt(els, box) : ''
  let extras = { imageDataUrls, pageContext, mode: 'rewrite' }
  if (!local && (!extras.imageDataUrls?.length || !extras.pageContext)) {
    const scene = await rewriteSceneExtras()
    extras = {
      mode: 'rewrite',
      imageDataUrls: extras.imageDataUrls?.length ? extras.imageDataUrls : scene.imageDataUrls,
      pageContext: extras.pageContext || scene.pageContext,
    }
  }
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
          excerpt ? `圈中/点名要改的片段：「${excerpt}」。只改这一部分，其余原文一字不动。` : '用户圈的是整块选区，请改写这段的全部可见文字。',
          excerpt
            ? '用户写明了只改其中几个词或几句。返回改完后的整段可见文字，不要只返回被改的词，不要解释，不要把指令写进正文。'
            : '返回改完后的整段可见文字，不要只改个别词，不要解释，不要把指令写进正文。',
        ]
          .filter(Boolean)
          .join('。'),
        original,
        extras,
      )
      next = String(data?.text || '').trim()
    }
    if (!next || next === original || isRewriteInstruction(next)) continue
    if (applyRewriteResult(el, original, next, excerpt || local)) count += 1
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
      ? `已调用模型按圈选和要求改写文字，共 ${count} 处。可还原这一处`
      : `已换成指定文字，共 ${count} 处。可还原这一处`,
  }
}

function wantsWholeAnno(ask, original) {
  const t = String(ask || '')
  if (/整段|整段话|这一段都|这段都|全部标|整段都|整句都/.test(t)) return true
  const a = String(original || '').replace(/\s+/g, '')
  return a.length > 0 && a.length <= 12 && t.length > 0
}

function phrasesFromAsk(ask, original) {
  const src = String(original || '')
  const out = []
  const seen = new Set()
  const add = (raw) => {
    const t = String(raw || '').replace(/\s+/g, ' ').trim()
    if (!t || t.length > src.length * 0.8) return
    const hit = src.includes(t) ? t : src.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))?.[0]
    if (!hit || seen.has(hit)) return
    seen.add(hit)
    out.push(hit)
  }
  for (const m of String(ask || '').matchAll(/[「『“"'']([^」』”"']{1,80})[」』”"']/g)) add(m[1])
  return out
}

function parseAnnotateMarks(raw, original) {
  const src = String(original || '')
  const text = String(raw || '').trim()
  let marks = []
  const json = text.match(/\{[\s\S]*\}/)
  if (json) {
    try {
      const data = JSON.parse(json[0])
      if (Array.isArray(data.marks)) marks = data.marks
      else if (typeof data.marks === 'string') marks = [data.marks]
    } catch {
      /* fall through */
    }
  }
  const out = []
  const seen = new Set()
  for (const item of marks) {
    const t = String(item || '').replace(/\s+/g, ' ').trim()
    if (!t) continue
    const hit = src.includes(t) ? t : src.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))?.[0]
    if (!hit || seen.has(hit)) continue
    seen.add(hit)
    out.push(hit)
  }
  return out
}

function collectTextNodeMap(el) {
  const map = []
  const doc = el.ownerDocument
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let acc = ''
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node.parentElement?.closest?.('[data-markset-anno]')) continue
    const start = acc.length
    acc += node.nodeValue || ''
    map.push({ node, start, end: acc.length })
  }
  return { map, acc }
}

function wrapPhraseInEl(el, phrase, kind, extra = {}) {
  const needle = String(phrase || '')
  if (!needle || !el) return 0
  const { map, acc } = collectTextNodeMap(el)
  if (!map.length) return 0
  let idx = acc.indexOf(needle)
  if (idx < 0) idx = acc.toLowerCase().indexOf(needle.toLowerCase())
  if (idx < 0) return 0
  const end = idx + needle.length
  const startHit = map.find((m) => idx >= m.start && idx < m.end)
  const endHit = [...map].reverse().find((m) => end > m.start && end <= m.end) || map.find((m) => end > m.start && end <= m.end)
  if (!startHit || !endHit) return 0
  const range = el.ownerDocument.createRange()
  try {
    range.setStart(startHit.node, idx - startHit.start)
    range.setEnd(endHit.node, end - endHit.start)
    if (extra.remove) {
      range.deleteContents()
      stampIds(el.ownerDocument)
      return 1
    }
    const span = el.ownerDocument.createElement('span')
    if (extra.scale) {
      span.setAttribute('data-markset-scaled', '1')
      span.setAttribute('data-markset-word', '1')
      span.setAttribute('data-markset-scale', String(extra.scale))
      span.style.fontSize = `${Math.round(Number(extra.scale) * 100)}%`
      span.style.display = 'inline'
    } else if (extra.color) {
      span.setAttribute('data-markset-word', '1')
      span.style.color = extra.color
      span.dataset.marksetTint = extra.color
    } else {
      span.setAttribute('data-markset-anno', kind)
    }
    try {
      range.surroundContents(span)
    } catch {
      const frag = range.extractContents()
      span.appendChild(frag)
      range.insertNode(span)
    }
    stampIds(el.ownerDocument)
    return 1
  } catch {
    return 0
  }
}

function wrapScalePhraseInEl(el, phrase, factor) {
  return wrapPhraseInEl(el, phrase, '', { scale: factor })
}

function isWordScopedTextOp(kind) {
  const k = String(kind || '')
  if (k === 'scale-up' || k === 'scale-down') return true
  if (k === 'color' || k === 'color-text') return true
  if (k === 'delete' || k === 'delete-text') return true
  if (k === 'highlight' || k === 'bold' || k === 'underline' || k === 'wavy' || k === 'strike') return true
  if (k === 'frame' || k === 'circle' || k === 'box') return true
  return false
}

function markedPhrasesForEl(el, ask = '') {
  const asked = phrasesFromAsk(ask, textOf(el))
  const underMark = phrasesFromCompactMarks(el)
  return [...new Set([...asked, ...underMark])].filter(Boolean)
}

function applyWordScopedOp(els, kind, { title, color } = {}) {
  if (!resolveAnnoWordLevel(title, annoScopeHint)) return null
  if (!isWordScopedTextOp(kind)) return null
  let count = 0
  const factor = kind === 'scale-down' ? 0.72 : 1.28
  const fill = colorFill(color) || color
  for (const el of els) {
    const marks = markedPhrasesForEl(el, title)
    for (const phrase of marks.sort((a, b) => b.length - a.length)) {
      if (kind === 'scale-up' || kind === 'scale-down') count += wrapScalePhraseInEl(el, phrase, factor)
      else if (kind === 'color' || kind === 'color-text') count += wrapPhraseInEl(el, phrase, '', { color: fill || '#c45c26' })
      else if (kind === 'delete' || kind === 'delete-text') count += wrapPhraseInEl(el, phrase, '', { remove: true })
      else count += wrapPhraseInEl(el, phrase, annoKind(kind) || kind)
    }
  }
  if (count) return { count }
  if (compactMarkBoxes().length || userAsksWordLevel(title) || annoScopeHint === 'marked') {
    return { count: 0, reason: '没对上画了标记的词。请把标记画在要改的词上' }
  }
  return null
}

function mergeLinePhrases(original, phrases) {
  const src = String(original || '')
  let start = Infinity
  let end = -1
  for (const p of phrases || []) {
    const needle = String(p || '').trim()
    if (!needle) continue
    let i = src.indexOf(needle)
    if (i < 0) i = src.toLowerCase().indexOf(needle.toLowerCase())
    if (i < 0) continue
    start = Math.min(start, i)
    end = Math.max(end, i + needle.length)
  }
  if (!(start < end)) return (phrases || []).filter(Boolean)
  return [src.slice(start, end)]
}

function applyAnnoPhrases(el, phrases, kind, ask) {
  const original = textOf(el)
  const compact = phrasesFromCompactMarks(el)
  const line = kind === 'underline' || kind === 'wavy' || kind === 'strike'
  const usable = line ? mergeLinePhrases(original, phrases) : (phrases || []).filter((p) => Boolean(String(p || '').trim()))
  const joined = usable.join('').replace(/\s+/g, '')
  const body = original.replace(/\s+/g, '')
  const coverMost = body.length > 0 && joined.length >= body.length * 0.72
  if (coverMost || (!compact.length && wantsWholeAnno(ask, original))) {
    unwrapInnerAnno(el)
    el.setAttribute('data-markset-anno', kind)
    return 1
  }
  if (line && usable.length === 1) {
    unwrapInnerAnno(el)
    return wrapPhraseInEl(el, usable[0], kind)
  }
  let n = 0
  for (const phrase of [...usable].sort((a, b) => b.length - a.length)) {
    n += wrapPhraseInEl(el, phrase, kind)
  }
  return n
}

const ANNO_ACTION = {
  highlight: '高亮',
  bold: '加粗',
  underline: '下划线',
  wavy: '波浪线',
  strike: '删除线',
}

export async function annotateCircledText(commandText, { onBefore, kind = 'highlight', markName = '', scope = '' } = {}) {
  if (!isWebDocActive()) return { ok: false, reason: '没有导入的网页' }
  if (scope) setAnnoScopeHint(scope)
  const anno = annoKind(kind) === kind ? kind : annoKind(kind)
  const action = ANNO_ACTION[anno] || '标注'
  const els = collectSelectionTextEls()
  if (!els.length) return { ok: false, reason: '圈中没有可标的文字。请把圈贴在标题或段落上' }
  const namedOnly = resolveAnnoWordLevel(commandText, scope)
  const instruction = String(commandText || '').trim() || `给圈中选区的全部文字加上${action}`
  onBefore?.(`${action}圈中文字`)
  const before = els.map((el) => snapshotNode(el))
  let extras = null
  let count = 0
  let usedModel = false
  if (!namedOnly) {
    count = applyAnnoToSelection(els, anno)
  }
  for (const el of namedOnly ? els : []) {
    const original = textOf(el)
    if (!original || original.length < 2) continue
    const asked = phrasesFromAsk(instruction, original)
    const underMark = phrasesFromCompactMarks(el)
    let marks = [...new Set([...asked, ...underMark])]
    if (!marks.length) {
      usedModel = true
      extras = extras || (await annotateSceneExtras())
      const data = await rewriteText(
        [
          instruction,
          `操作是给原文里的个别词加上${action}。`,
          markName ? `附图里的标记是「${markName}」。只找出画了这个标记的单词。` : '附图里画在某些词上的三角形、五角星、下划线、小圈，表示只改这些词。',
          '只返回 JSON：{"marks":["原文里已有的片段"]}。',
          '不要把整段原文放进 marks，除非用户明确说标整段。',
          asked.length ? `用户点名的片段：${asked.map((t) => `「${t}」`).join('、')}` : '',
          underMark.length ? `画标记压到的词（几何提示，以图为准）：${underMark.map((t) => `「${t}」`).join('、')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        original,
        extras,
      )
      const parsed = parseAnnotateMarks(data?.text, original)
      if (parsed.length) marks = parsed
      else if (underMark.length) marks = underMark
    }
    count += applyAnnoPhrases(el, marks, anno, instruction)
  }
  if (!count) {
    return {
      ok: false,
      reason: usedModel
        ? `模型和截图已交给判断，但没有定位到要${action}的文字。可把圈贴紧段落，或写明要改哪几个词`
        : `圈中没有落到文字上。把圈贴紧要改的句子，或把标记画在要${action}的词上`,
    }
  }
  const after = before.map((shot) => {
    const live = shot.webId ? findByWebId(shot.webId) : null
    return live ? snapshotNode(live) : { ...shot, removed: true }
  })
  recordWebEdit(`${action}圈中文字`, before, after)
  ping()
  fitHeight()
  return {
    ok: true,
    count,
    message: namedOnly
      ? `已按要求和标记只给对应的词加上${action}，共 ${count} 处。可还原这一处`
      : `已给圈中文字加上${action}，共 ${count} 处。可还原这一处`,
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

function looksLikeCoverGraphic(el) {
  if (!el) return false
  const r = el.getBoundingClientRect?.() || { width: 0, height: 0 }
  if (r.width < 56 || r.height < 72) return false
  const blob = [
    el.id,
    el.className,
    el.getAttribute?.('alt'),
    el.parentElement?.className,
    el.parentElement?.parentElement?.className,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  if (/cover|book|volume|jacket/.test(blob)) return true
  const ratio = r.height / Math.max(1, r.width)
  if (ratio < 1.12 || ratio > 2.05 || r.width > 420) return false
  const unit = el.closest?.('a, li, article, figure, [class*="card"], [class*="cover"]')
  if (!unit) return false
  const img = unit.querySelector?.('img')
  return !img || img === el || el.contains?.(img)
}

function imageRole(el, r, frameW) {
  const blob = `${el?.id || ''} ${el?.className || ''} ${el?.getAttribute?.('alt') || ''} ${el?.getAttribute?.('aria-label') || ''}`.toLowerCase()
  if (looksLikeLogo(el) || /logo|brand|icon/.test(blob)) return '网站Logo或图标'
  if (looksLikeCoverGraphic(el)) return '书籍或卡片封面，必须铺满封面框'
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
  if (looksLikeCoverGraphic(el)) {
    bits.push(
      '这是替换已有封面：生成铺满该位置的封面画面本身，竖版，不要生成一本小书、不要白边衬底、不要把新图叠在旧封面上',
    )
  } else {
    bits.push('请生成适合这个网页位置、能和周围内容放在一起的图，不要大段文字或水印')
  }
  return bits.join('。')
}

export function circledImageSeed() {
  const box = editRegionBox()
  const raw = uniqueEls([
    ...resolveCircledEls('color-image'),
    ...(box ? scanOverlapEls(box).map((h) => h.el) : []),
  ])
  const el = raw.map((node) => coverGraphicOf(node) || node).find((node) => isImageEl(node) || isGraphicEl(node) || hasPaintedBg(node))
  if (!el) {
    const host = insertHostBox()?.box
    return {
      imageDataUrl: '',
      width: Math.round(host?.w || 0),
      height: Math.round(host?.h || 0),
      scene: imageScenePrompt(null),
    }
  }
  const graphic = coverGraphicOf(el) || el
  const r = graphic.getBoundingClientRect()
  return {
    imageDataUrl: rasterizeEl(graphic),
    width: Math.round(r.width),
    height: Math.round(r.height),
    scene: imageScenePrompt(graphic),
  }
}

export function circledPaintIsPhoto() {
  if (!isWebDocActive()) return false
  const box = editRegionBox()
  const scene = describePaintScene()
  if (scene.kind === 'image') return true
  const raw = uniqueEls([
    ...resolveCircledEls('color-image'),
    ...resolveCircledEls(''),
    ...(box ? scanOverlapEls(box).map((h) => h.el) : []),
  ])
  const fromTree = raw.map((el) => coverGraphicOf(el)).filter((el) => el && (isImageEl(el) || hasPaintedBg(el)))
  let graphic = fromTree.find((el) => looksLikeCoverGraphic(el)) || fromTree[0] || null
  if (!graphic && box) {
    const doc = getDoc()
    for (const img of [...(doc?.querySelectorAll('img, canvas, video, picture') || [])]) {
      const node = img.tagName === 'PICTURE' ? img.querySelector('img') || img : img
      if (!node?.isConnected) continue
      const hit = overlapScore(node, box)
      if (hit.coverEl >= 0.16 || hit.coverBox >= 0.12 || centerInPaint(node, box)) {
        graphic = node
        if (looksLikeCoverGraphic(node)) break
      }
    }
  }
  if (!graphic) return false
  if (looksLikeCoverGraphic(graphic) || graphic.tagName === 'IMG' || graphic.tagName === 'CANVAS' || graphic.tagName === 'VIDEO') {
    if (scene.kind === 'text' && !looksLikeCoverGraphic(graphic)) return false
    return true
  }
  return scene.kind !== 'text'
}

function fitCoverImage(img, slot) {
  if (!img) return img
  const host = slot && slot !== img ? slot : img.parentElement
  img.removeAttribute('srcset')
  img.style.width = '100%'
  img.style.height = '100%'
  img.style.maxWidth = '100%'
  img.style.objectFit = 'cover'
  img.style.display = 'block'
  img.style.position = ''
  img.style.left = ''
  img.style.top = ''
  img.style.zIndex = ''
  if (host) {
    const cs = host.ownerDocument?.defaultView?.getComputedStyle(host)
    if (cs && (!cs.position || cs.position === 'static')) {
      /* keep flow; cover_img already relative in Gutenberg */
    }
  }
  return img
}

function putImageOnEl(el, src) {
  if (!el || !src) return null
  const graphic = coverGraphicOf(el) || el
  if (graphic.tagName === 'IMG') {
    graphic.src = src
    return fitCoverImage(graphic, graphic.parentElement)
  }
  if (graphic.tagName === 'SVG' || graphic.tagName === 'CANVAS' || graphic.tagName === 'VIDEO' || graphic.tagName === 'PICTURE') {
    const img = graphic.ownerDocument.createElement('img')
    img.src = src
    img.alt = graphic.getAttribute('aria-label') || graphic.getAttribute('alt') || '生成的图'
    const r = graphic.getBoundingClientRect()
    img.style.width = `${Math.max(12, Math.round(r.width))}px`
    img.style.height = `${Math.max(12, Math.round(r.height))}px`
    img.style.objectFit = 'cover'
    graphic.replaceWith(img)
    stampIds(el.ownerDocument)
    return fitCoverImage(img, img.parentElement)
  }
  const inner = graphic.querySelector?.('img')
  if (inner) {
    inner.src = src
    return fitCoverImage(inner, graphic)
  }
  graphic.style.backgroundImage = `url("${src}")`
  if (!graphic.style.backgroundSize) graphic.style.backgroundSize = 'cover'
  if (!graphic.style.backgroundRepeat) graphic.style.backgroundRepeat = 'no-repeat'
  graphic.style.backgroundPosition = 'center'
  return graphic
}

function overlappingInsertImages(box) {
  const doc = getDoc()
  if (!doc || !box) return []
  return [...doc.querySelectorAll('[data-markset-insert="image"]')].filter((el) => {
    if (!el.isConnected) return false
    const r = el.getBoundingClientRect()
    const hit = intersectBoxes(box, { x: r.left, y: r.top, w: r.width, h: r.height })
    if (!hit) return false
    return (hit.w * hit.h) / Math.max(1, r.width * r.height) > 0.18
  })
}

export function applyGeneratedWebImage(src) {
  const url = String(src || '').trim()
  if (!url) return { ok: false, reason: '没有生成出图片' }
  const box = editRegionBox()
  const raw = uniqueEls([
    ...resolveCircledEls('color-image'),
    ...(box ? scanOverlapEls(box).map((h) => h.el) : []),
  ])
  let targets = uniqueEls(raw.map((el) => coverGraphicOf(el)).filter(Boolean))
  if (!targets.length) {
    targets = uniqueEls(raw.filter((el) => isImageEl(el) || isGraphicEl(el) || hasPaintedBg(el)))
  }
  if (!targets.length) return insertWebImage(url)
  const overlays = overlappingInsertImages(box)
  const before = uniqueEls([...overlays, ...targets]).map((el) => snapshotNode(el))
  for (const el of overlays) el.remove()
  const after = []
  for (const el of targets) {
    if (!el.isConnected) continue
    const node = putImageOnEl(el, url)
    if (node?.isConnected) after.push(snapshotNode(node))
  }
  if (!after.length) return insertWebImage(url)
  recordWebEdit('换成生成的图', before, after)
  fitHeight()
  return { ok: true, message: '已用生成的图换上封面/配图。可还原这一处' }
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
[data-markset-anno="underline"] { text-decoration: underline 2px; text-decoration-skip-ink: none; text-underline-offset: 3px; }
[data-markset-anno="wavy"] { text-decoration: underline wavy 2px #3c6fd4; text-decoration-skip-ink: none; text-underline-offset: 3px; }
[data-markset-anno="strike"], [data-markset-anno="line-strike"] { text-decoration: line-through 2px; }
[data-markset-anno="highlight"] { background: rgba(255, 226, 80, 0.55); }
[data-markset-anno="bold"] { font-weight: 700; }
[data-markset-anno="box"], [data-markset-anno="frame"] { outline: 2px solid #3c6fd4; outline-offset: 3px; }
[data-markset-anno="circle"] { outline: 2px solid #3c6fd4; border-radius: 999px; outline-offset: 4px; }
[data-markset-scaled] { transform-origin: center center; }
[data-markset-word][data-markset-scaled] { display: inline; max-width: none; }
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


function directChildOf(el, ancestor) {
  let cur = el
  while (cur?.parentElement && cur.parentElement !== ancestor) cur = cur.parentElement
  return cur?.parentElement === ancestor ? cur : null
}

function layoutHostFor(elements) {
  const first = elements[0]
  if (!first) return null
  let cur = first.parentElement
  let best = null
  while (cur && cur !== cur.ownerDocument?.body && cur !== cur.ownerDocument?.documentElement) {
    const children = elements.map((el) => directChildOf(el, cur))
    const unique = new Set(children.filter(Boolean))
    if (unique.size === elements.length && cur.children.length >= elements.length && cur.children.length <= 32) {
      const style = cur.ownerDocument.defaultView?.getComputedStyle(cur)
      const display = style?.display || ''
      if (display !== 'inline' && display !== 'contents') best = { host: cur, units: children }
    }
    cur = cur.parentElement
  }
  return best
}

function layoutDirection(strokes = [], preferred = '', preferredOrder = '') {
  const sign = preferredOrder === 'reverse' ? -1 : 1
  if (preferred === 'vertical') return { axis: 'y', direction: sign }
  if (preferred === 'horizontal') return { axis: 'x', direction: sign }
  let best = null
  for (const stroke of strokes) {
    const points = stroke?.points || []
    if (points.length < 2) continue
    const first = points[0]
    const last = points[points.length - 1]
    const dx = last.x - first.x
    const dy = last.y - first.y
    const length = Math.hypot(dx, dy)
    if (!best || length > best.length) best = { dx, dy, length }
  }
  if (!best) return { axis: 'x', direction: 1 }
  return Math.abs(best.dx) >= Math.abs(best.dy)
    ? { axis: 'x', direction: best.dx >= 0 ? 1 : -1 }
    : { axis: 'y', direction: best.dy >= 0 ? 1 : -1 }
}

export function applyBrushLayoutReorder(targets, strokes = [], preferredDirection = '', preferredOrder = '', targetOrder = []) {
  const ids = []
  const elements = []
  const seen = new Set()
  for (const target of targets || []) {
    const el = target?.webId ? findByWebId(target.webId) : null
    if (!el || seen.has(el)) continue
    seen.add(el)
    ids.push(target.webId)
    elements.push(el)
  }
  if (elements.length < 2) return { ok: false, reason: '至少需要两个对象才能重排' }
  const layout = layoutHostFor(elements)
  if (!layout?.host) return { ok: false, reason: '暂时找不到可以一起排列这些对象的容器' }
  const { host, units } = layout
  const uniqueUnits = [...new Set(units)]
  if (uniqueUnits.length < 2) return { ok: false, reason: '这些对象还不在同一个可排列区域中' }
  const direction = layoutDirection(strokes, preferredDirection, preferredOrder)
  const sorted = [...uniqueUnits].sort((a, b) => {
    if (targetOrder.length) return targetOrder.indexOf(ids[units.indexOf(a)]) - targetOrder.indexOf(ids[units.indexOf(b)])
    const ra = a.getBoundingClientRect()
    const rb = b.getBoundingClientRect()
    const av = direction.axis === 'x' ? ra.left : ra.top
    const bv = direction.axis === 'x' ? rb.left : rb.top
    return (av - bv) * direction.direction
  })
  const before = [snapshotStyle(host), ...uniqueUnits.map((el) => snapshotStyle(el))]
  const hostStyle = host.style
  const previousDisplay = getComputedStyle(host).display
  const useGrid = previousDisplay !== 'flex'
  if (useGrid) {
    hostStyle.display = 'grid'
    hostStyle.gridTemplateColumns = direction.axis === 'x'
      ? `repeat(${Math.min(sorted.length, 4)}, minmax(0, 1fr))`
      : 'minmax(0, 1fr)'
    hostStyle.gridAutoRows = direction.axis === 'y' ? 'auto' : ''
    hostStyle.gridAutoFlow = direction.axis === 'x' ? 'row' : 'column'
  } else {
    hostStyle.display = 'flex'
    hostStyle.flexDirection = direction.axis === 'x' ? 'row' : 'column'
    hostStyle.flexWrap = 'nowrap'
  }
  if (!hostStyle.gap) hostStyle.gap = '16px'
  hostStyle.alignItems = 'stretch'
  for (const [index, el] of sorted.entries()) {
    el.style.order = String(index + 1)
    el.style.minWidth = direction.axis === 'x' ? '0' : ''
    el.style.boxSizing = 'border-box'
  }
  const after = [snapshotStyle(host), ...uniqueUnits.map((el) => snapshotStyle(el))]
  const changed = before.some((shot, index) => shot.cssText !== after[index]?.cssText)
  if (!changed) return { ok: false, reason: '这些对象已经是当前排列' }
  recordWebEdit('重新排列内容', before, after)
  fitHeight()
  ping()
  return { ok: true, count: uniqueUnits.length, message: `已重新排列 ${uniqueUnits.length} 个对象` }
}

function visibleTextNodes(el) {
  const doc = el?.ownerDocument
  if (!doc) return []
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) return NodeFilter.FILTER_REJECT
      if (parent.closest('[hidden], [aria-hidden="true"]')) return NodeFilter.FILTER_REJECT
      const style = doc.defaultView?.getComputedStyle?.(parent)
      return style?.display === 'none' || style?.visibility === 'hidden'
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
    },
  })
  const nodes = []
  let node = walker.nextNode()
  while (node) { nodes.push(node); node = walker.nextNode() }
  return nodes
}

function locateTextBoundary(nodes, offset, isEnd = false) {
  let cursor = 0
  for (const node of nodes) {
    const next = cursor + (node.nodeValue || '').length
    if (offset < next || (isEnd && offset === next)) return { node, offset: Math.max(0, offset - cursor) }
    cursor = next
  }
  const last = nodes[nodes.length - 1]
  return last ? { node: last, offset: (last.nodeValue || '').length } : null
}

export function applyBrushTextReplacement(targets, plan = {}, { dryRun = false } = {}) {
  const replacementText = String(plan?.replacementText || '').trim()
  if (!replacementText) return { ok: false, reason: '需要明确的替换文案' }
  if (Array.isArray(plan?.targetRanges) && plan.targetRanges.length) {
    return applyBrushTextRangeReplacement(targets, plan.targetRanges, replacementText, { dryRun })
  }
  const targetText = String(plan?.targetText || '').trim()
  if (!targetText) return { ok: false, reason: '需要明确的原文和替换文案' }
  const live = []
  const seen = new Set()
  for (const target of targets || []) {
    const el = target?.webId ? findByWebId(target.webId) : null
    if (!el || seen.has(el) || target.kind !== 'text') continue
    seen.add(el)
    const nodes = visibleTextNodes(el)
    const text = nodes.map((node) => node.nodeValue || '').join('')
    let from = 0
    while (from <= text.length) {
      const start = text.indexOf(targetText, from)
      if (start < 0) break
      const begin = locateTextBoundary(nodes, start)
      const finish = locateTextBoundary(nodes, start + targetText.length, true)
      if (begin && finish) live.push({ el, doc: el.ownerDocument, begin, finish })
      from = start + Math.max(1, targetText.length)
    }
  }
  if (live.length !== 1) return { ok: false, reason: live.length ? '原文在所选内容中出现多次，无法确定要改哪一处' : '所选内容中找不到这段原文；网页未被修改' }

  if (dryRun) return { ok: true, count: 1, message: '已确认可以安全局部替换' }

  const before = [snapshotNode(live[0].el)]
  try {
    const { el, doc, begin, finish } = live[0]
    const range = doc.createRange()
    range.setStart(begin.node, begin.offset)
    range.setEnd(finish.node, finish.offset)
    range.deleteContents()
    range.insertNode(doc.createTextNode(replacementText))
    el.setAttribute('data-markset-edited', '1')
  } catch (error) {
    applyShot(before[0])
    return { ok: false, reason: '无法安全修改这段文字，页面保持原样' }
  }
  const after = [snapshotNode(live[0].el)]
  recordWebEdit('局部替换文字', before, after)
  fitHeight()
  ping()
  return { ok: true, count: 1, message: '已局部替换文字' }
}

function collectTextRangeOperations(targets, ranges) {
  const byId = new Map((targets || []).filter((target) => target?.webId).map((target) => [String(target.webId), target]))
  const operations = []
  const seen = new Set()
  for (const item of ranges || []) {
    const target = byId.get(String(item?.targetId || ''))
    const start = Number(item?.start)
    const end = Number(item?.end)
    if (!target || target.kind !== 'text' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return { ok: false, reason: '文字标记范围无效，网页未被修改' }
    const el = findByWebId(target.webId)
    if (!el) return { ok: false, reason: '文字对象已变化，请重新标记' }
    const entries = normalizedCharEntries(el)
    if (end > entries.length) return { ok: false, reason: '文字标记范围已过期，请重新标记' }
    const current = entries.slice(start, end).map((entry) => entry.char).join('')
    const expected = String(item?.expectedText || '').trim()
    if (expected && current !== expected) return { ok: false, reason: `标记文字已变化（原为“${expected}”），网页未被修改` }
    const first = entries[start]
    const last = entries[end - 1]
    if (!first?.node || !last?.node) return { ok: false, reason: '找不到标记文字，网页未被修改' }
    const key = `${target.webId}:${start}:${end}`
    if (seen.has(key)) continue
    seen.add(key)
    operations.push({ target, el, start, end, begin: { node: first.node, offset: first.offset }, finish: { node: last.node, offset: last.offset + 1 } })
  }
  if (!operations.length) return { ok: false, reason: '没有找到可操作的文字范围' }
  const perElement = new Map()
  for (const operation of operations) {
    const list = perElement.get(operation.el) || []
    list.push(operation)
    perElement.set(operation.el, list)
  }
  for (const list of perElement.values()) {
    list.sort((a, b) => a.start - b.start)
    for (let i = 1; i < list.length; i += 1) if (list[i].start < list[i - 1].end) return { ok: false, reason: '文字标记范围重叠，网页未被修改' }
  }
  return { ok: true, operations, perElement }
}

function applyBrushTextRangeReplacement(targets, ranges, replacementText, { dryRun = false } = {}) {
  const collected = collectTextRangeOperations(targets, ranges)
  if (!collected.ok) return collected
  if (dryRun) return { ok: true, count: collected.operations.length, message: '已确认可以安全局部替换' }
  const elements = [...collected.perElement.keys()]
  const before = elements.map((el) => snapshotNode(el))
  try {
    for (const list of collected.perElement.values()) {
      for (const operation of [...list].sort((a, b) => b.start - a.start)) {
        const range = operation.el.ownerDocument.createRange()
        range.setStart(operation.begin.node, operation.begin.offset)
        range.setEnd(operation.finish.node, operation.finish.offset)
        range.deleteContents()
        range.insertNode(operation.el.ownerDocument.createTextNode(replacementText))
      }
      list[0].el.setAttribute('data-markset-edited', '1')
    }
  } catch {
    before.forEach(applyShot)
    return { ok: false, reason: '无法安全替换标记文字，页面保持原样' }
  }
  const after = elements.map((el) => snapshotNode(el))
  recordWebEdit('替换标记文字', before, after)
  fitHeight()
  ping()
  return { ok: true, count: collected.operations.length, message: `已替换 ${collected.operations.length} 处标记文字` }
}

/**
 * Delete only the character ranges selected by the brush. This is deliberately
 * separate from applyBrushDelete: a text element can contain a heading, a
 * sentence and an unmarked word that must all survive the edit.
 */
export function applyBrushTextDeletion(targets, ranges = [], { dryRun = false } = {}) {
  const collected = collectTextRangeOperations(targets, ranges)
  if (!collected.ok) return { ...collected, reason: collected.reason === '没有找到可操作的文字范围' ? '没有找到可删除的文字范围' : collected.reason }
  const { operations, perElement } = collected
  if (dryRun) return { ok: true, count: operations.length, message: '已确认可以安全删除标记文字' }
  const elements = [...perElement.keys()]
  const before = elements.map((el) => snapshotNode(el))
  try {
    for (const list of perElement.values()) {
      for (const operation of [...list].sort((a, b) => b.start - a.start)) {
        const range = operation.el.ownerDocument.createRange()
        range.setStart(operation.begin.node, operation.begin.offset)
        range.setEnd(operation.finish.node, operation.finish.offset)
        range.deleteContents()
      }
      list[0].el.setAttribute('data-markset-edited', '1')
    }
  } catch {
    before.forEach(applyShot)
    return { ok: false, reason: '无法安全删除标记文字，页面保持原样' }
  }
  const after = elements.map((el) => snapshotNode(el))
  recordWebEdit('删除标记文字', before, after)
  fitHeight()
  ping()
  return { ok: true, count: operations.length, message: `已删除 ${operations.length} 处标记文字` }
}

export function applyBrushDelete(targets) {
  const live = []
  const seen = new Set()
  for (const target of targets || []) {
    const el = target?.webId ? findByWebId(target.webId) : null
    if (!el?.isConnected || isTombstone(el)) return { ok: false, reason: '选中对象已变化，请重新标记；网页未被修改' }
    if (el === getDoc()?.body || el === getDoc()?.documentElement) return { ok: false, reason: '不能删除整个网页根节点，请选中具体模块' }
    if (seen.has(el)) continue
    seen.add(el)
    live.push(el)
  }
  if (!live.length) return { ok: false, reason: '找不到仍在页面上的对象' }
  // A parent and its child can both be hit by the same stroke. Snapshot and
  // remove only top-level selected roots so undo cannot duplicate descendants
  // or pair a different object's snapshot with a surviving tombstone.
  const roots = live.filter((el) => !live.some((other) => other !== el && other.contains(el)))
  const before = roots.map((el) => snapshotNode(el))
  const tombstones = []
  try {
    for (const el of roots) {
      const tombstone = leaveTombstone(el)
      if (!tombstone) throw new Error('Target detached during deletion')
      tombstones.push(tombstone)
    }
  } catch {
    before.forEach(applyShot)
    return { ok: false, reason: '移除失败，整组内容已恢复' }
  }
  const after = tombstones.map((el, index) => snapshotNode(el, { removed: true, tombstone: true, webId: before[index]?.webId || el.getAttribute('data-markset-id') || '' }))
  recordWebEdit('移除内容', before, after)
  fitHeight()
  ping()
  return { ok: true, count: roots.length, message: `已移除 ${roots.length} 个对象` }
}

export function applyBrushImageReplacement(targets, src) {
  const url = String(src || '').trim()
  if (!url) return { ok: false, reason: '请输入图片 URL' }
  const live = []
  const seen = new Set()
  for (const target of targets || []) {
    const root = target?.webId ? findByWebId(target.webId) : null
    const el = root?.matches?.('img') ? root : root?.querySelector?.('img')
    if (!el) return { ok: false, reason: '部分图片对象已不存在；整组没有修改' }
    if (seen.has(el)) continue
    seen.add(el)
    live.push(el)
  }
  if (!live.length) return { ok: false, reason: '找不到仍在页面上的图片对象' }
  const before = live.map((el) => snapshotNode(el))
  for (const el of live) {
    el.src = url
    el.removeAttribute('srcset')
    el.setAttribute('data-markset-edited', '1')
  }
  const after = live.map((el) => snapshotNode(el))
  recordWebEdit('替换图片', before, after)
  fitHeight()
  ping()
  return { ok: true, count: live.length, message: `已替换 ${live.length} 张图片` }
}

export function brushOriginalImage(target) {
  const root = findByWebId(target?.webId)
  const img = root?.matches('img') ? root : root?.querySelector('img')
  if (!img) return ''
  const source = img.currentSrc || img.src
  // Imported resources are often proxied; rasterizing also captures blob URLs.
  try {
    const canvas = img.ownerDocument.createElement('canvas')
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
    canvas.getContext('2d').drawImage(img,0,0)
    if (canvas.width && canvas.height) return canvas.toDataURL('image/png')
  } catch {}
  if (/^data:image\//u.test(source)) return source
  try {
    const url = new URL(source, location.href)
    if (url.pathname === '/api/asset') return url.searchParams.get('url') || ''
    if (url.protocol === 'https:' && url.hostname !== location.hostname) return url.href
  } catch {}
  return ''
}

function createEditNodes(doc, specs) {
  return specs.map((spec) => {
    const node = doc.createElement(spec.tag)
    node.setAttribute('data-markset-id', `new-${Date.now()}-${Math.random().toString(36).slice(2,9)}`)
    if (spec.text) node.textContent = spec.text
    for (const [name,value] of Object.entries(spec.attributes || {})) node.setAttribute(name,value)
    if (spec.tag === 'a') { node.setAttribute('rel','noopener'); node.setAttribute('target','_blank') }
    if (spec.tag === 'button') node.setAttribute('type','button')
    for (const [property,value] of Object.entries(spec.styles || {})) node.style.setProperty(property,value)
    if (spec.children?.length) node.append(...createEditNodes(doc,spec.children))
    return node
  })
}

function applyBrushPrimitive(plan) {
  const doc = getDoc()
  const elements = (plan.targets || []).map((target) => findByWebId(target.webId))
  if (!doc || !elements.length || elements.some((el) => !el || el === doc.body || el === doc.documentElement || isTombstone(el))) return { ok:false,reason:'目标组件已经变化或不可修改' }
  if (plan.type === 'style') {
    const reason = checkStyleDeclarations(plan.styles)
    if (reason) return { ok:false,reason }
    for (const [property,value] of Object.entries(plan.styles)) {
      if (value && doc.defaultView.CSS?.supports && !doc.defaultView.CSS.supports(property,value)) return { ok:false,reason:`无效CSS值：${property}=${value}` }
    }
  }
  const before = { documentBody:doc.body.innerHTML }
  try {
    if (plan.type === 'style') for (const el of elements) for (const [property,value] of Object.entries(plan.styles)) el.style.setProperty(property,value)
    else {
      const anchor = findByWebId(plan.insertion?.anchorId)
      if (!anchor || anchor === doc.body || anchor === doc.documentElement || elements.some((el) => el === anchor || el.contains(anchor))) throw new Error('移动锚点非法或会形成父子循环')
      if (elements.some((el,i) => elements.some((other,j) => i!==j && el.contains(other)))) throw new Error('移动目标包含重叠的父子节点')
      if (plan.insertion.placement === 'inside-start') anchor.prepend(...elements)
      else if (plan.insertion.placement === 'inside-end') anchor.append(...elements)
      else if (plan.insertion.placement === 'before') anchor.before(...elements)
      else if (plan.insertion.placement === 'after') anchor.after(...elements)
      else throw new Error('不支持的移动位置')
    }
    if (before.documentBody === doc.body.innerHTML) return { ok:false,reason:'此方案没有产生变化' }
    recordWebEdit(plan.goal || '局部设计调整',[before],[{documentBody:doc.body.innerHTML}]); fitHeight(); ping()
    return { ok:true,count:elements.length,message:plan.suggestion?.text || plan.goal || '已调整标记对象' }
  } catch (error) { applyShot(before); return { ok:false,reason:error.message } }
}

export function applyBrushInsert(targets, plan) {
  const doc = getDoc()
  if (!doc) return { ok: false, reason: '网页尚未加载' }
  const placement = plan.insertion?.placement || (plan.parameters?.bounds ? 'position' : 'after')
  if (!['inside-start','inside-end','before','after','position'].includes(placement)) return {ok:false,reason:'插入方式无效'}
  const anchorId = plan.insertion?.anchorId
  if (anchorId && !(targets || []).some((target) => target.webId === anchorId) && !plan.allowedAnchorIds?.includes(anchorId)) return { ok: false, reason: '插入锚点不在允许的局部模块内' }
  const anchor = anchorId ? findByWebId(anchorId) : null
  if (anchorId && (!anchor || isTombstone(anchor))) return { ok: false, reason: '插入位置已经变化' }
  if (anchor === doc.body || anchor === doc.documentElement) return { ok: false, reason: '请标记具体模块，不要选择网页根节点' }
  if (placement !== 'position' && !anchor) return {ok:false,reason:'缺少明确的插入锚点'}
  const image = plan.contentKind === 'image'
  const content = String(plan.replacementText || '').trim()
  if (plan.nodes?.length) { const reason = checkNodeSpecs(plan.nodes); if (reason) return { ok:false,reason } }
  if (!plan.nodes?.length && (!content || (image && !/^(?:https?:\/\/|data:image\/)/u.test(content)))) return { ok: false, reason: '缺少有效的插入内容' }
  const el = doc.createElement(plan.nodes?.length ? 'div' : image ? 'img' : 'p')
  el.setAttribute('data-markset-id', `insert-${Date.now()}-${Math.random().toString(36).slice(2,7)}`)
  el.setAttribute('data-markset-insert', image ? 'image' : 'text')
  if (image) { el.src = content; el.alt = plan.goal || '配图'; el.style.cssText = 'display:block;max-width:100%;width:min(100%,640px);height:auto;object-fit:contain;margin:16px 0;border-radius:12px' }
  else { el.textContent = content; el.style.cssText = 'font:inherit;color:inherit;margin:16px 0;line-height:1.6' }
  if (plan.nodes?.length) { el.replaceChildren(...createEditNodes(doc,plan.nodes)) }
  if (plan.styles) {
    const reason = checkStyleDeclarations(plan.styles)
    if (reason) return { ok:false,reason }
    for (const [property,value] of Object.entries(plan.styles)) el.style.setProperty(property,value)
  }
  try {
    if (anchor && placement !== 'position') {
      if (placement.startsWith('inside-')) {
        const module = /^(SECTION|ARTICLE|DIV|ASIDE|LI|FIGURE|HEADER|FOOTER|NAV)$/u.test(anchor.tagName) ? anchor : anchor.closest('section,article,div,aside,li,figure')
        if (!module || module === doc.body || module === doc.documentElement) return { ok: false, reason: '该对象不支持内部插入，请选择模块容器或插在对象前后' }
        if (placement === 'inside-start') module.prepend(el); else module.append(el)
      } else if (placement === 'before') anchor.before(el); else anchor.after(el)
    } else {
      const box = plan.parameters?.bounds
      if (!box || ![box.x,box.y,box.w,box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0) return { ok: false, reason: '插入位置无效' }
      el.style.position = 'absolute'; el.style.left = `${box.x}px`; el.style.top = `${box.y}px`
      el.style.width = `${box.w}px`; el.style.maxWidth = `${box.w}px`; el.style.margin = '0'; el.style.boxSizing = 'border-box'
      // The slot, not the generated image's natural aspect ratio, determines
      // page geometry. Contain the whole image without pushing it below the box.
      if (image) {el.style.height=`${box.h}px`;el.style.maxHeight=`${box.h}px`;el.style.objectFit='contain'}
      doc.body.append(el)
      // Evidence uses measured document geometry. A positioned/translated body
      // changes the origin; CSS zoom/scale also changes the measured slot size.
      // Correct this node only, not the imported page's layout or root styles.
      const actual=el.getBoundingClientRect(),scroll=iframeScroll()
      if (actual.width>0 && actual.height>0) {
        const scaleX=actual.width/box.w,scaleY=actual.height/(image ? box.h : el.offsetHeight || actual.height)
        el.style.width=`${box.w/scaleX}px`;el.style.maxWidth=el.style.width
        if (image) {el.style.height=`${box.h/scaleY}px`;el.style.maxHeight=el.style.height}
        el.style.left=`${box.x+(box.x-actual.left-scroll.x)/scaleX}px`
        el.style.top=`${box.y+(box.y-actual.top-scroll.y)/scaleY}px`
      }
    }
    const after = snapshotNode(el)
    recordWebEdit(image ? '添加配图' : '添加内容', [{ ...after, removed: true, absent: true }], [after])
    fitHeight(); ping()
    return { ok: true, count: 1, message: image ? '已添加配图' : '已添加内容',insertions:[{stepIndex:0,webId:el.getAttribute('data-markset-id')}] }
  } catch { el.remove(); return { ok: false, reason: '插入失败，网页没有改变' } }
}

export function applyBrushPlan(plan, strokes = []) {
  const targets = plan.targets || []
  if (plan.type === 'replace') return applyBrushTextReplacement(targets, plan)
  if (plan.type === 'delete') return plan.targetRanges?.length ? applyBrushTextDeletion(targets,plan.targetRanges) : applyBrushDelete(targets)
  if (plan.type === 'color') return applyBrushColor(targets,plan.parameters?.color || plan.color || plan.replacementText)
  if (plan.type === 'style' || plan.type === 'move') return applyBrushPrimitive(plan)
  if (plan.type === 'insert') return applyBrushInsert(targets,plan)
  if (plan.type === 'replace-image') return applyBrushImageReplacement(targets,plan.replacementText)
  if (plan.type === 'reorder') return applyBrushLayoutReorder(targets,strokes,plan.parameters?.direction,plan.parameters?.order,plan.parameters?.targetOrder)
  if (plan.type !== 'batch') return { ok: false, reason: '不支持的执行方案' }
  const doc = getDoc(), edits = webEdits
  if (!doc || !plan.steps?.length) return { ok: false, reason: '缺少分步方案' }
  const before = { documentBody: doc.body.innerHTML }
  try {
    const insertions=[]
    for (const [stepIndex,step] of plan.steps.entries()) {
      if (step.type === 'batch') throw new Error('不能嵌套修改组')
      const result = applyBrushPlan(step, strokes)
      if (!result.ok) throw new Error(result.reason)
      insertions.push(...(result.insertions || []).map(item=>({...item,stepIndex})))
    }
    const after = { documentBody: doc.body.innerHTML }
    webEdits = edits
    recordWebEdit(plan.goal || '组合修改', [before], [after])
    return { ok: true, count: plan.steps.length, message: `已完成 ${plan.steps.length} 项组合修改`,insertions }
  } catch (error) {
    applyShot(before); webEdits = edits; fitHeight(); ping()
    return { ok: false, reason: `整组已回滚：${error.message}` }
  }
}

// Use the SAME executor/undo path in a separate, offscreen document. No preview
// UI or mutation of the user's document/history, and no model code execution.
function waitForTrialLayout(signal) {
  return new Promise((resolve,reject)=>{
    let first,second,timer
    const finish = (error) => {
      clearTimeout(timer); cancelAnimationFrame(first); cancelAnimationFrame(second)
      signal?.removeEventListener('abort',abort)
      if (error) reject(error); else resolve()
    }
    const abort = () => finish(signal.reason || new DOMException('Cancelled','AbortError'))
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort',abort,{once:true})
    // Background tabs can suspend RAF indefinitely. Measuring forces layout;
    // this fallback and abort listener ensure no abandoned validation iframe.
    timer=setTimeout(()=>finish(),120)
    first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>finish())})
  })
}

export async function verifyBrushPlan(plan, strokes = [], { signal } = {}) {
  if (!isWebDocActive()) return { ok:false,issues:[{code:'page-not-loaded'}] }
  const live = frameEl(), original = getDoc(), trial = document.createElement('iframe')
  trial.setAttribute('sandbox','allow-same-origin')
  trial.setAttribute('aria-hidden','true'); trial.tabIndex = -1
  trial.style.cssText = `position:fixed;left:-100000px;top:0;width:${live.clientWidth}px;height:${Math.max(live.clientHeight,640)}px;visibility:hidden;pointer-events:none;border:0`
  let trialEdits = []
  const inTrial = (action) => {
    const previousEdits = webEdits, previousSeq = webEditSeq
    executionFrame=trial; webEdits=trialEdits
    try { return action() } finally { trialEdits=webEdits; executionFrame=null; webEdits=previousEdits; webEditSeq=previousSeq }
  }
  try {
    document.body.append(trial)
    const clone = trial.contentDocument, parsed = new DOMParser().parseFromString(original.documentElement.outerHTML,'text/html')
    stripExecutableMarkup(parsed)
    parsed.querySelectorAll('link,iframe,video,audio,source').forEach((node)=>node.remove())
    parsed.querySelectorAll('img').forEach((img)=>{
      const source = original.querySelector(`[data-markset-id="${CSS.escape(img.getAttribute('data-markset-id') || '')}"]`)
      if (source) { const rect=source.getBoundingClientRect(); img.style.width=`${rect.width}px`; img.style.height=`${rect.height}px` }
      img.removeAttribute('srcset')
      if (!/^data:image\//u.test(img.getAttribute('src') || '')) img.removeAttribute('src')
    })
    // Block network URLs in cloned CSS too, without granting allow-scripts.
    parsed.querySelectorAll('style').forEach((style)=>{ style.textContent=style.textContent.replace(/@import[^;]+;|url\([^)]*\)/giu,'') })
    parsed.querySelectorAll('[style]').forEach((node)=>{ node.setAttribute('style',node.getAttribute('style').replace(/url\([^)]*\)/giu,'')) })
    clone.replaceChild(clone.importNode(parsed.documentElement,true),clone.documentElement)
    await waitForTrialLayout(signal)
    signal?.throwIfAborted()
    const beforeHtml = clone.body.innerHTML, beforeStyle=clone.body.getAttribute('style'), before = measurePlanDocument(clone)
    const testPlan = structuredClone(plan)
    const placeholder = 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#e6e9ef"/></svg>')
    for (const step of testPlan.type === 'batch' ? testPlan.steps : [testPlan]) {
      if (step.imagePrompt && !step.replacementText) step.replacementText=placeholder
    }
    const result = inTrial(()=>applyBrushPlan(testPlan,strokes))
    if (!result.ok) return {ok:false,issues:[{code:'execution-failed',detail:result.reason}],checks:['execution']}
    await waitForTrialLayout(signal)
    signal?.throwIfAborted()
    const report=auditPlanResult(testPlan,before,measurePlanDocument(clone),{insertions:result.insertions})
    inTrial(()=>undoWebEditsSince())
    if (clone.body.innerHTML !== beforeHtml || clone.body.getAttribute('style') !== beforeStyle) return planCheckReport([...report.issues,{code:'undo-mismatch'}],{checks:report.checks})
    report.provisionalImage=Boolean((plan.type === 'batch' ? plan.steps : [plan]).some((step)=>step.imagePrompt && !step.replacementText))
    return report
  } catch (error) {
    if (signal?.aborted) throw error
    return {ok:false,issues:[{code:'verification-failed',detail:error.message}]}
  } finally { trial.remove() }
}
