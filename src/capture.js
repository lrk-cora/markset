import { loadImageEl } from './mask.js'
import { getSnapshot } from './store.js'

function markLine(span) {
  const id = span.markId ? `#${String(span.markId).replace(/^#/, '')}` : '(no-id)'
  if (span.kind === 'text') return `${id} text ${span.block_id || ''} ${span.text || ''}`
  if (span.kind === 'image') {
    const box = span.bbox ? `${span.bbox.x},${span.bbox.y},${span.bbox.w}x${span.bbox.h}` : ''
    return `${id} image ${span.block_id || ''} ${box}`
  }
  return `${id} ${span.kind}`
}

/** Payload for planner A. Built locally; not sent unless the model gate is on. */
export async function captureMarkedPage(editor) {
  const snap = getSnapshot()
  const pageText = editor?.view?.state?.doc
    ? editor.view.state.doc.textBetween(0, editor.view.state.doc.content.size, '\n')
    : ''
  const marks = (snap.spans || []).map(markLine).join('\n')
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
