import { loadImageEl } from './mask.js'
import { getSnapshot } from './store.js'
import { getInkStrokes, inkToDataUrl } from './ink.js'
import { getPaintMarks } from './overlay.js'
import { describeCircledHits, isWebDocActive } from './web-doc.js'

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

async function captureImportedPage() {
  const iframe = document.getElementById('web-doc-frame')
  const host = document.getElementById('web-doc-host')
  const doc = iframe?.contentDocument
  if (!doc?.body || host?.hidden) return ''
  try {
    const { toJpeg } = await import('html-to-image')
    return await toJpeg(doc.body, {
      quality: 0.74,
      pixelRatio: 0.8,
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
    const paintW = Math.max(3, canvas.width / 170)
    const inkW = Math.max(3, canvas.width / 190)
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

/** Page + ink + numbered marks for intent understanding. */
export async function captureAnnotationScene(editor) {
  const marked = await captureMarkedPage(editor)
  const ink = inkToDataUrl()
  const imported = await captureImportedPage()
  const demo = imported ? '' : await captureDemoPage()
  const combined = await compositePageAndStrokes(imported || demo || marked.imageDataUrl)
  const images = [combined, ink, imported, marked.imageDataUrl].filter(Boolean)
  return {
    ...marked,
    pageText: marked.pageText || importedPageText(),
    inkDataUrl: ink,
    combinedDataUrl: combined,
    imageDataUrls: [...new Set(images)],
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
