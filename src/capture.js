import { aabb, dist, looksLikeArrowGesture, looksLikeRadialBurst, looksLikeUnderlineGesture, pathLength } from './geometry.js'
import { loadImageEl } from './mask.js'
import { getSnapshot } from './store.js'
import { getInkStrokes, inkToDataUrl } from './ink.js'
import { getPaintMarks } from './overlay.js'
import { describeCircledHits, insertHostScreenBox, isWebDocActive } from './web-doc.js'

function markLine(span) {
  const id = span.markId ? `#${String(span.markId).replace(/^#/, '')}` : '(no-id)'
  if (span.kind === 'text') return `${id} text ${span.block_id || ''} ${span.text || ''}`.trim()
  if (span.kind === 'image') {
    const box = span.bbox ? `${span.bbox.x},${span.bbox.y},${span.bbox.w}x${span.bbox.h}` : ''
    const web = span.webId ? `web:${span.webId}` : ''
    return `${id} image ${span.block_id || ''} ${web} ${box}`.trim()
  }
  return `${id} ${span.kind}`
}

function pageFrame() {
  const iframe = document.getElementById('web-doc-frame')
  const host = document.getElementById('web-doc-host')
  if (iframe && host && !host.hidden) return iframe.getBoundingClientRect()
  const page = document.querySelector('.page')
  return page?.getBoundingClientRect() || null
}

async function captureImportedPage({ quality = 0.74, pixelRatio = 0.8 } = {}) {
  const iframe = document.getElementById('web-doc-frame')
  const host = document.getElementById('web-doc-host')
  const doc = iframe?.contentDocument
  if (!doc?.body || host?.hidden) return ''
  try {
    const { toJpeg } = await import('html-to-image')
    return await toJpeg(doc.body, {
      quality,
      pixelRatio,
      backgroundColor: '#ffffff',
      cacheBust: false,
      filter: (node) => node?.tagName !== 'SCRIPT' && node?.tagName !== 'LINK',
    })
  } catch {
    return ''
  }
}

async function captureDemoPage() {
  const page = document.querySelector('.page')
  if (!page) return ''
  try {
    const { toJpeg } = await import('html-to-image')
    return await toJpeg(page, {
      quality: 0.74,
      pixelRatio: 0.7,
      backgroundColor: '#fffaf2',
      cacheBust: false,
      filter: (node) => node?.tagName !== 'SCRIPT',
    })
  } catch {
    return ''
  }
}

function importedPageText() {
  const iframe = document.getElementById('web-doc-frame')
  const host = document.getElementById('web-doc-host')
  const doc = iframe?.contentDocument
  if (!doc?.body || host?.hidden) return ''
  return String(doc.body.innerText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000)
}

function drawStrokes(ctx, points, color, width, frame, scaleX, scaleY) {
  if (!points || points.length < 2 || !frame) return
  ctx.beginPath()
  ctx.moveTo((points[0].x - frame.left) * scaleX, (points[0].y - frame.top) * scaleY)
  for (let i = 1; i < points.length; i += 1) {
    ctx.lineTo((points[i].x - frame.left) * scaleX, (points[i].y - frame.top) * scaleY)
  }
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.stroke()
}

async function compositePageAndStrokes(pageDataUrl) {
  if (!pageDataUrl) return ''
  const frame = pageFrame()
  if (!frame || frame.width < 8 || frame.height < 8) return pageDataUrl
  try {
    const image = await loadImageEl(pageDataUrl)
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth || image.width
    canvas.height = image.naturalHeight || image.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    const scaleX = canvas.width / frame.width
    const scaleY = canvas.height / frame.height
    const paintW = Math.max(4, canvas.width / 140)
    const inkW = Math.max(5, canvas.width / 120)
    for (const mark of getPaintMarks()) {
      ctx.globalAlpha = 0.78
      drawStrokes(ctx, mark.points, mark.color || '#3c6fd4', paintW, frame, scaleX, scaleY)
    }
    ctx.globalAlpha = 1
    for (const stroke of getInkStrokes()) {
      drawStrokes(ctx, stroke, '#111111', inkW, frame, scaleX, scaleY)
    }
    return canvas.toDataURL('image/jpeg', 0.86)
  } catch {
    return pageDataUrl
  }
}

function allStrokePoints() {
  const pts = []
  for (const mark of getPaintMarks()) {
    if (mark.points?.length) pts.push(...mark.points)
  }
  for (const stroke of getInkStrokes()) {
    if (stroke?.length) pts.push(...stroke)
  }
  return pts
}

function looksLikeLasso(pts) {
  if (!pts || pts.length < 8) return false
  const box = aabb(pts)
  const peri = 2 * (box.w + box.h)
  const len = pathLength(pts)
  const closed = dist(pts[0], pts[pts.length - 1]) < Math.max(box.w, box.h) * 0.35
  return closed && box.w > 80 && box.h > 60 && len < peri * 2.8
}

function handwritingStrokes() {
  const inks = getInkStrokes().filter((s) => s?.length >= 2)
  if (inks.length) return inks
  return getPaintMarks()
    .map((m) => m.points)
    .filter((s) => s?.length >= 2 && !looksLikeLasso(s))
}

function strokesToBoard(strokes, { color = '#111111', maxSide = 720 } = {}) {
  const pts = (strokes || []).flat()
  if (pts.length < 2) return ''
  const box = aabb(pts)
  const pad = 36
  const rawW = Math.max(48, box.w + pad * 2)
  const rawH = Math.max(48, box.h + pad * 2)
  const scale = Math.min(6, maxSide / Math.max(rawW, rawH, 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(280, Math.round(rawW * scale))
  canvas.height = Math.max(280, Math.round(rawH * scale))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(8, canvas.width / 42)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const stroke of strokes) {
    if (!stroke || stroke.length < 2) continue
    ctx.beginPath()
    ctx.moveTo((stroke[0].x - box.x + pad) * scale, (stroke[0].y - box.y + pad) * scale)
    for (let i = 1; i < stroke.length; i += 1) {
      ctx.lineTo((stroke[i].x - box.x + pad) * scale, (stroke[i].y - box.y + pad) * scale)
    }
    ctx.stroke()
  }
  return canvas.toDataURL('image/png')
}

export function hasDrawnStamp() {
  return handwritingStrokes().some((s) => s.length >= 4)
}

export function looksLikeDrawnPattern() {
  const strokes = handwritingStrokes().filter((s) => s?.length >= 4)
  if (!strokes.length) return false
  if (looksLikeRadialBurst(handwritingStrokes())) return true
  const pts = strokes.flat()
  const box = aabb(pts)
  if (box.w < 36 || box.h < 36) return false
  const len = strokes.reduce((n, s) => n + pathLength(s), 0)
  const peri = 2 * (box.w + box.h)
  const closedish = strokes.some((s) => {
    if (s.length < 8) return false
    return dist(s[0], s[s.length - 1]) < Math.min(box.w, box.h) * 0.28 && pathLength(s) > peri * 0.4
  })
  if (closedish && box.w > 48 && box.h > 48) return true
  if (strokes.length >= 4 && len > peri * 0.9) return true
  if (strokes.length >= 5 && len > peri * 0.45) return true
  if (len > Math.max(box.w, box.h) * 4 && Math.min(box.w, box.h) > 50) return true
  return false
}

export function classifyDrawnGesture() {
  const strokes = handwritingStrokes().filter((s) => s?.length >= 2)
  if (!strokes.length) return { kind: '', shape: '', label: '', hint: '' }
  if (looksLikeRadialBurst(strokes)) {
    return {
      kind: 'stamp',
      shape: 'radial',
      label: '把画出的光芒加到周围',
      hint: '多条线从中心散开，是给 Logo/物体加装饰或光芒。应把画出的图案贴到所画位置，不要当成空白插入文字，也不要当成删除涂鸦。',
    }
  }
  if (looksLikeArrowGesture(strokes)) {
    return {
      kind: 'move-layout',
      shape: 'arrow',
      label: '按箭头把模块挪到指出的位置',
      hint: '箭头表示布局：从模块指向要放到的位置，不是新选区，也不是插入文字。',
    }
  }
  if (looksLikeUnderlineGesture(strokes)) {
    return {
      kind: 'underline',
      shape: 'underline',
      label: '给圈中文字加下划线',
      hint: '横线画在文字下方，表示加下划线。',
    }
  }
  if (looksLikeDrawnPattern()) {
    return {
      kind: 'stamp',
      shape: 'pattern',
      label: '加上画出的图案',
      hint: '用户直接画了要加上的图形，应把该图案贴到所画位置。',
    }
  }
  return { kind: '', shape: '', label: '', hint: '' }
}

export function drawnStampScreenBox() {
  const pts = handwritingStrokes().flat()
  if (pts.length < 2) return null
  const box = aabb(pts)
  return { x: box.x, y: box.y, w: Math.max(28, box.w), h: Math.max(28, box.h) }
}

export function drawnStampDataUrl() {
  const strokes = handwritingStrokes()
  const pts = strokes.flat()
  if (pts.length < 2) return ''
  const box = aabb(pts)
  const pad = 12
  const rawW = Math.max(28, box.w + pad * 2)
  const rawH = Math.max(28, box.h + pad * 2)
  const scale = Math.min(4, 480 / Math.max(rawW, rawH, 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(48, Math.round(rawW * scale))
  canvas.height = Math.max(48, Math.round(rawH * scale))
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = '#1d1916'
  ctx.lineWidth = Math.max(3, canvas.width / 48)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const stroke of strokes) {
    if (!stroke || stroke.length < 2) continue
    ctx.beginPath()
    ctx.moveTo((stroke[0].x - box.x + pad) * scale, (stroke[0].y - box.y + pad) * scale)
    for (let i = 1; i < stroke.length; i += 1) {
      ctx.lineTo((stroke[i].x - box.x + pad) * scale, (stroke[i].y - box.y + pad) * scale)
    }
    ctx.stroke()
  }
  return canvas.toDataURL('image/png')
}

function handwritingBoardDataUrl() {
  return strokesToBoard(handwritingStrokes())
}

function strokeBoardDataUrl() {
  const paints = getPaintMarks().map((m) => m.points).filter((s) => s?.length >= 2)
  const inks = getInkStrokes().filter((s) => s?.length >= 2)
  const pts = [...paints.flat(), ...inks.flat()]
  if (pts.length < 2) return ''
  const box = aabb(pts)
  const pad = 28
  const rawW = Math.max(48, box.w + pad * 2)
  const rawH = Math.max(48, box.h + pad * 2)
  const scale = Math.min(5, 720 / Math.max(rawW, rawH, 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(240, Math.round(rawW * scale))
  canvas.height = Math.max(240, Math.round(rawH * scale))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const draw = (strokes, color, width) => {
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const stroke of strokes) {
      if (!stroke || stroke.length < 2) continue
      ctx.beginPath()
      ctx.moveTo((stroke[0].x - box.x + pad) * scale, (stroke[0].y - box.y + pad) * scale)
      for (let i = 1; i < stroke.length; i += 1) {
        ctx.lineTo((stroke[i].x - box.x + pad) * scale, (stroke[i].y - box.y + pad) * scale)
      }
      ctx.stroke()
    }
  }
  draw(paints, '#3c6fd4', Math.max(6, canvas.width / 70))
  draw(inks, '#111111', Math.max(7, canvas.width / 55))
  return canvas.toDataURL('image/png')
}

async function fitDataUrl(dataUrl, { maxSide = 720, quality = 0.84 } = {}) {
  if (!dataUrl) return ''
  try {
    const image = await loadImageEl(dataUrl)
    const w = image.naturalWidth || image.width
    const h = image.naturalHeight || image.height
    if (w < 4 || h < 4) return dataUrl
    const scale = Math.min(1, maxSide / Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', quality)
  } catch {
    return dataUrl
  }
}

async function cropFromPoints(pageDataUrl, pts, { pad = 36, maxSide = 880 } = {}) {
  const frame = pageFrame()
  if (!pageDataUrl || !frame || !pts || pts.length < 2) return ''
  try {
    const image = await loadImageEl(pageDataUrl)
    const box = aabb(pts)
    const sx = (image.naturalWidth || image.width) / Math.max(1, frame.width)
    const sy = (image.naturalHeight || image.height) / Math.max(1, frame.height)
    let x = (box.x - frame.left - pad) * sx
    let y = (box.y - frame.top - pad) * sy
    let w = (box.w + pad * 2) * sx
    let h = (box.h + pad * 2) * sy
    x = Math.max(0, x)
    y = Math.max(0, y)
    w = Math.min((image.naturalWidth || image.width) - x, Math.max(120, w))
    h = Math.min((image.naturalHeight || image.height) - y, Math.max(120, h))
    if (w < 16 || h < 16) return ''
    const canvas = document.createElement('canvas')
    const outScale = Math.min(3.2, maxSide / Math.max(w, h))
    canvas.width = Math.max(200, Math.round(w * outScale))
    canvas.height = Math.max(200, Math.round(h * outScale))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, x, y, w, h, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.92)
  } catch {
    return ''
  }
}

async function cropCloseup(pageDataUrl) {
  return cropFromPoints(pageDataUrl, allStrokePoints(), { pad: 36, maxSide: 860 })
}

async function cropInkCloseup(pageDataUrl) {
  const pts = handwritingStrokes().flat()
  if (pts.length < 2) return ''
  return cropFromPoints(pageDataUrl, pts, { pad: 48, maxSide: 900 })
}

function uniqueUrls(list) {
  const out = []
  const seen = new Set()
  for (const url of list || []) {
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

function insertCropPoints() {
  const pts = allStrokePoints()
  if (pts.length >= 2) return pts
  const box = insertHostScreenBox()
  if (!box) return []
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ]
}

/** Circled blank plus surrounding page, for insert-text / insert-image generation. */
export async function captureInsertScene() {
  const imported = await captureImportedPage({ quality: 0.84, pixelRatio: 1 })
  const demo = imported ? '' : await captureDemoPage()
  const pageShot = imported || demo
  const combined = await compositePageAndStrokes(pageShot)
  const source = combined || pageShot
  const pts = insertCropPoints()
  const around = await fitDataUrl(await cropFromPoints(source, pts, { pad: 240, maxSide: 960 }), {
    maxSide: 960,
    quality: 0.84,
  })
  const closeup = await fitDataUrl(await cropFromPoints(source, pts, { pad: 28, maxSide: 640 }), {
    maxSide: 640,
    quality: 0.86,
  })
  const page = await fitDataUrl(source, { maxSide: 720, quality: 0.74 })
  return {
    aroundImageDataUrl: around,
    circledImageDataUrl: closeup,
    pageImageDataUrl: page,
    pageText: importedPageText().slice(0, 1800),
  }
}

/** Page + ink + numbered marks for intent understanding. */
export async function captureAnnotationScene(editor) {
  const marked = await captureMarkedPage(editor)
  const imported = await captureImportedPage({ quality: 0.86, pixelRatio: 1.1 })
  const demo = imported ? '' : await captureDemoPage()
  const pageShot = imported || demo || marked.imageDataUrl
  const combined = await compositePageAndStrokes(pageShot)
  const source = combined || pageShot
  const writing = await fitDataUrl(handwritingBoardDataUrl() || inkToDataUrl(), { maxSide: 720, quality: 0.94 })
  const board = await fitDataUrl(strokeBoardDataUrl() || writing, { maxSide: 720, quality: 0.92 })
  const inkCloseup = await fitDataUrl(await cropInkCloseup(source), { maxSide: 900, quality: 0.92 })
  const closeup = await fitDataUrl(await cropCloseup(source), { maxSide: 860, quality: 0.88 })
  const page = await fitDataUrl(source, { maxSide: 720, quality: 0.78 })
  const ocrImages = uniqueUrls([writing])
  const images = uniqueUrls([writing, board, inkCloseup, closeup, page])
  return {
    ...marked,
    pageText: marked.pageText || importedPageText(),
    inkDataUrl: writing || board,
    inkCloseupDataUrl: inkCloseup,
    closeupDataUrl: closeup,
    combinedDataUrl: page,
    ocrImageDataUrls: ocrImages,
    imageDataUrls: images,
  }
}

/** Payload for planner A. Built locally; not sent unless the model gate is on. */
export async function captureMarkedPage(editor) {
  const snap = getSnapshot()
  const pageText = editor?.view?.state?.doc
    ? editor.view.state.doc.textBetween(0, editor.view.state.doc.content.size, '\n')
    : importedPageText()
  const marks = [
    isWebDocActive() ? describeCircledHits() : '',
    (snap.spans || []).map(markLine).join('\n'),
  ]
    .filter(Boolean)
    .join('\n')
  const img = editor?.view?.dom?.querySelector('img[data-block-id]')
  let imageDataUrl = ''
  if (img?.src) {
    try {
      const image = await loadImageEl(img.src.startsWith('data:') ? img.src : img.currentSrc || img.src)
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth || image.width
      canvas.height = image.naturalHeight || image.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
      ctx.lineWidth = Math.max(3, Math.round(canvas.width / 220))
      ctx.font = `600 ${Math.max(18, Math.round(canvas.width / 28))}px sans-serif`
      for (const span of snap.spans || []) {
        if (span.kind !== 'image' || !span.bbox) continue
        ctx.strokeStyle = '#3c6fd4'
        ctx.fillStyle = '#3c6fd4'
        ctx.strokeRect(span.bbox.x, span.bbox.y, span.bbox.w, span.bbox.h)
        ctx.fillText(`#${span.markId || 'I'}`, span.bbox.x + 8, span.bbox.y + Math.max(22, canvas.width / 36))
      }
      imageDataUrl = canvas.toDataURL('image/jpeg', 0.85)
    } catch {
      imageDataUrl = ''
    }
  }
  return { imageDataUrl, marks, pageText }
}
