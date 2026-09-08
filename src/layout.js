import { pageRelativeRect } from './editor.js'
import { aabb } from './geometry.js'
import { isTinyImageSpan } from './hit-test.js'
import { layoutPenOf } from './overlay.js'
import { getSnapshot, upsertSpan } from './store.js'

function moduleScreenRect(view, span) {
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
  const a = span?.screenRect
  if (!a || !box) return true
  const dx = box.x + box.w / 2 - (a.x + a.w / 2)
  const dy = box.y + box.h / 2 - (a.y + a.h / 2)
  return Math.hypot(dx, dy) > 56
}

export function collectLayoutPairs(spans = getSnapshot().spans) {
  const byColor = new Map()
  for (const span of spans || []) {
    if (!span.layoutColor) continue
    const g = byColor.get(span.layoutColor) || { sources: [], dests: [] }
    if (span.layoutRole === 'source') g.sources.push(span)
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
      label: src.kind === 'image' ? '图' : String(src.text || '这段').slice(0, 8),
      pen: layoutPenOf(color)?.label || '这支笔',
    })
  }
  return pairs
}

export function looksLikeLayout(spans) {
  return collectLayoutPairs(spans).length > 0
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

function findNodePos(editor, pair) {
  let found = null
  editor.state.doc.descendants((node, pos) => {
    if (found != null) return false
    if (pair.blockId && node.attrs?.blockId === pair.blockId) {
      found = pos
      return false
    }
    return true
  })
  if (found != null) return found
  if (pair.from == null) return null
  try {
    const $pos = editor.state.doc.resolve(pair.from)
    for (let d = $pos.depth; d > 0; d -= 1) {
      if ($pos.node(d).isTextblock || $pos.node(d).type.name === 'image') return $pos.before(d)
    }
  } catch {
    /* ignore */
  }
  return null
}

function clampPlacedToPage(placed) {
  const page = document.querySelector('.page')
  const host = document.querySelector('#editor .ProseMirror') || page
  if (!page || !host || !placed) return placed
  const pb = page.getBoundingClientRect()
  const hb = host.getBoundingClientRect()
  const style = getComputedStyle(page)
  const padL = parseFloat(style.paddingLeft) || 0
  const padR = parseFloat(style.paddingRight) || 0
  const padT = parseFloat(style.paddingTop) || 0
  const padB = parseFloat(style.paddingBottom) || 0
  const minX = pb.left + padL - hb.left
  const minY = pb.top + padT - hb.top
  const maxX = pb.right - padR - hb.left
  const maxY = pb.bottom - padB - hb.top
  const roomW = Math.max(48, maxX - minX)
  const roomH = Math.max(24, maxY - minY)
  const w = Math.min(Math.max(48, placed.w || 48), roomW)
  const h = Math.min(Math.max(24, placed.h || 24), roomH)
  const x = Math.min(Math.max(minX, placed.x), maxX - w)
  const y = Math.min(Math.max(minY, placed.y), maxY - h)
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

function snapRect(rect) {
  const x = Math.round(rect.x / 8) * 8
  const y = Math.round(rect.y / 8) * 8
  return { ...rect, x, y }
}

export function ingestLayoutStroke(editor, { color, polygon, rawPoints, textHits, imageHits }) {
  const box = aabb(rawPoints?.length ? rawPoints : polygon)
  const texts = textHits?.found || []
  const images = (imageHits?.found || []).filter((s) => !isTinyImageSpan(s))
  const content = images[0] || texts[0]
  const spans = getSnapshot().spans
  const existingSrc = spans.find((s) => s.layoutColor === color && s.layoutRole === 'source')
  const pen = layoutPenOf(color)
  const label = pen?.label || '这支笔'
  const wantDest = Boolean(existingSrc && (!content || farFrom(existingSrc, box)))

  if (wantDest) {
    const destRect = content?.kind === 'image' && content.screenRect ? content.screenRect : box
    upsertSpan(
      (s) => s.layoutColor === color && s.layoutRole === 'dest',
      {
        kind: 'slot',
        layoutColor: color,
        layoutRole: 'dest',
        screenRect: destRect,
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

export function applyLayoutMoves(editor, { snap = false } = {}) {
  const pairs = collectLayoutPairs()
  if (!pairs.length || !editor) return false
  const dests = pairs.map((p) => (snap ? snapRect(p.dest) : { ...p.dest }))
  if (snap && dests.length > 1) {
    for (let i = 1; i < dests.length; i += 1) {
      if (Math.abs(dests[i].x - dests[0].x) <= 28) dests[i].x = dests[0].x
    }
  }
  let tr = editor.state.tr
  let n = 0
  pairs.forEach((pair, i) => {
    const pos = findNodePos(editor, pair)
    if (pos == null) return
    const node = tr.doc.nodeAt(pos)
    if (!node) return
    const dest = dests[i]
    const placed = pageRelativeRect(dest)
    if (!placed) return
    const srcEl = pair.blockId
      ? editor.view.dom.querySelector(`[data-block-id="${CSS.escape(pair.blockId)}"]`)
      : null
    const srcBox = srcEl?.getBoundingClientRect()
    const next = clampPlacedToPage({
      x: placed.x,
      y: placed.y,
      w: Math.round(srcBox?.width || (pair.kind === 'image' ? node.attrs.width || placed.w : placed.w)),
      h: Math.round(srcBox?.height || placed.h),
    })
    tr = tr.setNodeMarkup(pos, null, { ...node.attrs, placed: next })
    n += 1
  })
  if (!n) return false
  editor.view.dispatch(tr)
  return n
}
