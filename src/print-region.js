import { DEMO_CUP, getDemoPage } from './editor.js'
import { imageSpanFromNaturalBox, normalizeVisionBox } from './hit-test.js'
import { makeMask, naturalBoxToScreen, paintMask, rectToPoly } from './mask.js'

function regionSpan(view, region, extra = {}) {
  const img = view.dom.querySelector('img[data-block-id="img-1"]')
  if (!img || !region) return null
  const br = img.getBoundingClientRect()
  const nw = img.naturalWidth || Number(img.getAttribute('width')) || 360
  const nh = img.naturalHeight || Number(img.getAttribute('height')) || 360
  const bbox = {
    x: Math.round(nw * region.xRel),
    y: Math.round(nh * region.yRel),
    w: Math.round(nw * region.wRel),
    h: Math.round(nh * region.hRel),
  }
  const canvas = makeMask({ w: nw, h: nh })
  paintMask(canvas, rectToPoly(bbox), 'replace')
  const imageRect = { x: br.left, y: br.top, w: br.width, h: br.height }
  return {
    kind: 'image',
    block_id: 'img-1',
    maskCanvas: canvas,
    bbox,
    mask: { ...bbox },
    naturalSize: { w: nw, h: nh },
    imageRect,
    screenRect: naturalBoxToScreen(bbox, imageRect, { w: nw, h: nh }),
    mode: 'region',
    ...extra,
  }
}

function demo() {
  return DEMO_CUP[getDemoPage()] || DEMO_CUP.a
}

/** Letters on the mug. Stand-in until planner A returns a print bbox. */
export function collectPrintStandIn(view) {
  return regionSpan(view, demo().print, { printStandIn: true })
}

/** Mug body for recoloring. */
export function collectCupBody(view) {
  return regionSpan(view, demo().cup, { cupBody: true })
}

export function resolvePrintRegions(view, planOps) {
  const listed = (planOps || []).filter((op) => op?.args?.print && op.span)
  if (listed.length) return listed.map((op) => op.span)
  const standIn = collectPrintStandIn(view)
  return standIn ? [standIn] : []
}

export function attachImageOpsFromBboxes(view, ops) {
  return (ops || []).map((op) => {
    if (op.span || op.tool !== 'image_inpaint') return op
    const blockId = op.args?.block_id || 'img-1'
    const img =
      view.dom.querySelector(`img[data-block-id="${blockId}"]`) ||
      view.dom.querySelector('img[data-block-id]')
    if (!img) return op
    const nw = img.naturalWidth || Number(img.getAttribute('width')) || 1
    const nh = img.naturalHeight || Number(img.getAttribute('height')) || 1
    const bbox = normalizeVisionBox(op.args?.bbox, { w: nw, h: nh })
    if (!bbox) return op
    const span = imageSpanFromNaturalBox(img, bbox, { printStandIn: Boolean(op.args.print) })
    return span ? { ...op, span } : op
  })
}
