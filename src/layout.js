import { aabb } from './geometry.js'
import { layoutPenOf } from './overlay.js'
import { getSnapshot, upsertSpan } from './store.js'

function overlapArea(a, b) {
  if (!a || !b) return 0
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.w, b.x + b.w)
  const bot = Math.min(a.y + a.h, b.y + b.h)
  return Math.max(0, r - x) * Math.max(0, bot - y)
}

function smallestHit(items) {
  const hits = (items || []).filter((c) => c)
  if (!hits.length) return null
  hits.sort((a, b) => {
    const aa = (a.screenRect?.w || 1) * (a.screenRect?.h || 1)
    const ba = (b.screenRect?.w || 1) * (b.screenRect?.h || 1)
    return aa - ba
  })
  return hits[0]
}

function pickLayoutSource(box, texts, images) {
  const textHits = (texts || []).filter((c) => overlapArea(c.screenRect, box) > 12)
  if (textHits.length) return smallestHit(textHits)
  const imageHits = (images || []).filter((c) => overlapArea(c.screenRect, box) > 12)
  return smallestHit(imageHits) || smallestHit(images) || smallestHit(texts)
}

function isImageRegion(span) {
  if (span?.kind !== 'image') return false
  const sr = span.screenRect
  const ir = span.imageRect
  if (!sr || !ir) return Boolean(span.bbox || span.mode === 'region')
  return sr.w * sr.h < ir.w * ir.h * 0.72
}

function moduleScreenRect(view, span) {
  if (span?.webId && span.screenRect) return span.screenRect
  if (span?.kind === 'image' && span.screenRect) return span.screenRect
  if (span?.block_id) {
    const el = view.dom.querySelector(`[data-block-id="${CSS.escape(span.block_id)}"]`)
    const r = el?.getBoundingClientRect()
    if (r?.width) return { x: r.left, y: r.top, w: r.width, h: r.height }
  }
  if (span?.from != null && span?.to != null) {
    try {
      const a = view.coordsAtPos(span.from)
      const b = view.coordsAtPos(span.to)
      return {
        x: Math.min(a.left, b.left),
        y: Math.min(a.top, b.top),
        w: Math.max(24, Math.abs(b.left - a.left)),
        h: Math.max(16, Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top)),
      }
    } catch {
      /* ignore */
    }
  }
  return span?.screenRect || null
}

function farFrom(span, box) {
  const overlap = overlapArea(span?.screenRect, box)
  const boxArea = Math.max(1, (box?.w || 0) * (box?.h || 0))
  if (overlap / boxArea > 0.4) return false
  const a = span?.screenRect
  if (!a || !box) return true
  const dx = box.x + box.w / 2 - (a.x + a.w / 2)
  const dy = box.y + box.h / 2 - (a.y + a.h / 2)
  return Math.hypot(dx, dy) > 36
}

export function collectLayoutPairs(spans = getSnapshot().spans) {
  const byColor = new Map()
  for (const span of spans || []) {
    if (!span.layoutColor) continue
    const g = byColor.get(span.layoutColor) || { sources: [], dests: [] }
    if (span.layoutRole === 'source') {
      if (span.willEdit === false) continue
      g.sources.push(span)
    }
    else if (span.layoutRole === 'dest') g.dests.push(span)
    byColor.set(span.layoutColor, g)
  }
  const pairs = []
  for (const [color, g] of byColor) {
    const src = g.sources[0]
    const dest = g.dests[0]
    if (!src || !dest?.screenRect) continue
    pairs.push({
      color,
      kind: src.kind,
      blockId: src.block_id,
      from: src.from,
      dest: dest.screenRect,
      sourceRect: src.screenRect,
      bbox: src.bbox,
      imageRect: src.imageRect,
      naturalSize: src.naturalSize,
      text: src.text,
      webId: src.webId || null,
      region: isImageRegion(src),
      label: src.kind === 'image' ? '图' : String(src.text || '这段').slice(0, 8),
      pen: layoutPenOf(color)?.label || '这支笔',
    })
  }
  return pairs
}

export function looksLikeLayout(spans) {
  return collectLayoutPairs(spans).length > 0
}

export function hasLayoutWork(spans = getSnapshot().spans) {
  return (spans || []).some((s) => s.layoutColor)
}

export function layoutSourceWaiting(spans = getSnapshot().spans) {
  const colors = new Map()
  for (const span of spans || []) {
    if (!span.layoutColor) continue
    const g = colors.get(span.layoutColor) || { source: false, dest: false }
    if (span.layoutRole === 'source') g.source = true
    if (span.layoutRole === 'dest') g.dest = true
    colors.set(span.layoutColor, g)
  }
  for (const [color, g] of colors) {
    if (g.source && !g.dest) return layoutPenOf(color)?.label || '这支笔'
  }
  return ''
}

function toEditorRect(rect) {
  const host = document.querySelector('#editor .ProseMirror') || document.querySelector('.page')
  if (!host || !rect) return null
  const box = host.getBoundingClientRect()
  const x = Math.round(rect.x - box.left)
  const y = Math.round(rect.y - box.top)
  const w = Math.round(rect.w)
  const h = Math.round(rect.h)
  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    w: Math.max(8, Math.min(w, Math.round(box.width - Math.max(0, x)))),
    h: Math.max(8, Math.min(h, Math.round(box.height - Math.max(0, y)))),
  }
}

function blockEl(view, node, pos) {
  const id = node.attrs?.blockId
  if (id) {
    const el = view.dom.querySelector(`[data-block-id="${CSS.escape(id)}"]`)
    if (el) return el
  }
  return view.nodeDOM(pos)
}

function collectBlockRects(view) {
  const rects = []
  view.state.doc.forEach((node, pos) => {
    if (!['paragraph', 'heading', 'image'].includes(node.type.name)) return
    const el = blockEl(view, node, pos)
    const r = el?.getBoundingClientRect?.()
    if (!r || r.width < 2 || r.height < 2) return
    rects.push({
      pos,
      node,
      screen: { x: r.left, y: r.top, w: r.width, h: r.height },
    })
  })
  return rects
}

function matchPairBlock(rects, pair) {
  if (pair.blockId) {
    const hit = rects.find((r) => r.node.attrs?.blockId === pair.blockId)
    if (hit) return hit
  }
  if (pair.from == null) return null
  return rects.find((r) => r.pos <= pair.from && r.pos + r.node.nodeSize > pair.from) || null
}

function shiftFrom(src, dest) {
  return {
    mode: 'shift',
    dx: Math.round(dest.x - src.x),
    dy: Math.round(dest.y - src.y),
    sx: 1,
    sy: 1,
    x: dest.x,
    y: dest.y,
    w: dest.w,
    h: dest.h,
  }
}

export function applyLayoutMoves(editor) {
  const view = editor?.view
  if (!view) return 0
  const pairs = collectLayoutPairs()
  if (!pairs.length) return 0
  const rects = collectBlockRects(view)
  let tr = view.state.tr
  let n = 0

  for (const pair of pairs) {
    const dest = toEditorRect(pair.dest)
    const hit = dest ? matchPairBlock(rects, pair) : null
    const src = hit ? toEditorRect(pair.sourceRect) || toEditorRect(hit.screen) : null
    if (!hit || !src) continue
    tr = tr.setNodeMarkup(hit.pos, null, {
      ...hit.node.attrs,
      placed: shiftFrom(src, dest),
    })
    n += 1
  }
  if (!n) return 0
  view.dispatch(tr)
  return n
}

export function ingestLayoutStroke(editor, { color, polygon, rawPoints, textHits, imageHits }) {
  const box = aabb(rawPoints?.length ? rawPoints : polygon)
  const texts = textHits?.found || []
  const images = [...(imageHits?.found || []), ...(imageHits?.suggest || [])]
  const content = pickLayoutSource(box, texts, images)
  const spans = getSnapshot().spans
  const existingSrc =
    spans.find((s) => s.layoutColor === color && s.layoutRole === 'source') ||
    spans.find((s) => (s.kind === 'text' || s.kind === 'image') && s.layoutRole !== 'dest' && s.willEdit !== false)
  const pen = layoutPenOf(color)
  const label = pen?.label || '这支笔'
  const wantDest = Boolean(existingSrc && (!content || farFrom(existingSrc, box)))

  if (wantDest) {
    upsertSpan(
      (s) => s.markId === existingSrc.markId || (existingSrc.webId && s.webId === existingSrc.webId),
      {
        layoutColor: color,
        layoutRole: 'source',
      },
    )
    upsertSpan(
      (s) => s.layoutColor === color && s.layoutRole === 'dest',
      {
        kind: 'slot',
        layoutColor: color,
        layoutRole: 'dest',
        screenRect: box,
        poly: polygon,
        paintMark: true,
        why: 'layout-dest',
      },
    )
    return { phase: 'paired', label }
  }

  if (!content) return { phase: 'miss', label }

  const screenRect = moduleScreenRect(editor.view, content) || box
  upsertSpan(
    (s) => s.layoutColor === color && s.layoutRole === 'source',
    {
      ...content,
      layoutColor: color,
      layoutRole: 'source',
      screenRect,
      why: 'layout-source',
    },
  )
  return {
    phase: 'source',
    label,
    kind: content.kind,
    preview: content.kind === 'image' ? '图' : String(content.text || '这段').slice(0, 8),
  }
}
