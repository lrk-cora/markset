import { aabb, clampBox, intersectBoxes, unionBoxes } from './geometry.js'
import {
  clipMaskToRect,
  invertMask,
  makeMask,
  maskBounds,
  naturalBoxToScreen,
  paintMask,
  rectToPoly,
  screenBoxToNatural,
  screenPolyToNatural,
} from './mask.js'

const listeners = new Set()

const state = {
  spans: [],
  links: [],
  suggest: [],
  commandText: '',
}

let insertUndo = null
let writeUndo = null

function nextMarkId(prefix, used) {
  let n = 1
  while (used.has(`${prefix}${n}`)) n += 1
  return `${prefix}${n}`
}

function emit() {
  for (const fn of listeners) fn(getSnapshot())
}

function withMarks(spans) {
  const used = new Set()
  return spans.map((span) => {
    const prefix = span.kind === 'text' ? 'T' : span.kind === 'slot' ? 'S' : 'I'
    let markId = span.markId
    if (!markId || used.has(markId) || markId[0] !== prefix) {
      markId = nextMarkId(prefix, used)
    }
    used.add(markId)
    return {
      ...span,
      markId,
      willEdit: span.willEdit !== false,
      mode: span.kind === 'image' ? span.mode || 'region' : span.mode,
    }
  })
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getSnapshot() {
  return {
    spans: state.spans.map((s) => ({ ...s })),
    links: [...state.links],
    suggest: state.suggest.map((s) => ({ ...s })),
    commandText: state.commandText,
  }
}

export function toSpec() {
  return {
    spans: state.spans.map((span) => {
      if (span.kind === 'text') {
        return {
          block_id: span.block_id,
          start: span.start,
          end: span.end,
          text: span.text,
          willEdit: span.willEdit !== false,
        }
      }
      if (span.kind === 'slot') {
        return {
          kind: 'slot',
          screenRect: { ...span.screenRect },
          willEdit: span.willEdit !== false,
        }
      }
      return {
        block_id: span.block_id,
        mask: { ...span.mask },
        bbox: { ...span.bbox },
        mode: span.mode || 'region',
        willEdit: span.willEdit !== false,
      }
    }),
    marks: state.spans.map((span) => ({
      id: span.markId,
      anchor: span.anchor ? { ...span.anchor } : null,
      willEdit: span.willEdit !== false,
    })),
    links: [...state.links],
  }
}

export function setAnchors(anchorsById) {
  state.spans = state.spans.map((span) => ({
    ...span,
    anchor: anchorsById[span.markId] ?? span.anchor,
  }))
}

export function replaceSpans(spans) {
  state.spans = withMarks(spans.map((s) => ({ ...s, willEdit: true })))
  state.suggest = []
  emit()
}

function unionTextSpan(a, b, doc) {
  const from = Math.min(a.from, b.from)
  const to = Math.max(a.to, b.to)
  const start = Math.min(a.start ?? 0, b.start ?? 0)
  const end = Math.max(a.end ?? 0, b.end ?? 0)
  return {
    ...a,
    from,
    to,
    start,
    end,
    text: doc ? doc.textBetween(from, to) : a.text,
    willEdit: true,
  }
}

export function appendSpans(spans, doc) {
  if (!spans.length) return
  let next = [...state.spans]
  for (const incoming of spans) {
    if (incoming.kind === 'text') {
      const i = next.findIndex((s) => s.kind === 'text' && s.block_id === incoming.block_id)
      if (i >= 0) {
        next[i] = unionTextSpan(next[i], incoming, doc)
        continue
      }
    }
    next.push({ ...incoming, willEdit: true })
  }
  state.spans = withMarks(next)
  state.suggest = []
  emit()
}

export function removeMark(markId) {
  state.spans = withMarks(state.spans.filter((s) => s.markId !== markId))
  emit()
}

export function toggleWillEdit(markId) {
  state.spans = state.spans.map((s) =>
    s.markId === markId ? { ...s, willEdit: s.willEdit === false } : s,
  )
  emit()
}

function remapTextSpan(span, mapping, doc) {
  const from = mapping.map(span.from, 1)
  const to = mapping.map(span.to, -1)
  if (from >= to || to > doc.content.size) return null
  const $from = doc.resolve(Math.min(from, doc.content.size))
  let contentStart = from
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).attrs?.blockId === span.block_id) {
      contentStart = $from.start(depth)
      break
    }
  }
  return {
    ...span,
    from,
    to,
    start: from - contentStart,
    end: to - contentStart,
    text: doc.textBetween(from, to),
  }
}

export function beginInsertUndo(editor) {
  insertUndo = {
    json: editor.getJSON(),
    spans: state.spans.map((s) => ({ ...s })),
    commandText: state.commandText,
  }
}

export function canUndoInsert() {
  return Boolean(insertUndo) || Boolean(writeUndo)
}

export function undoLastInsert(editor) {
  if (writeUndo) return undoLastWrite(editor)
  if (!insertUndo) return false
  const snapshot = insertUndo
  insertUndo = null
  editor.commands.setContent(snapshot.json)
  state.spans = snapshot.spans.map((s) => ({ ...s }))
  state.commandText = snapshot.commandText
  emit()
  return true
}

export function beginWriteUndo(editor) {
  writeUndo = {
    json: editor.getJSON(),
    spans: state.spans.map((s) => ({ ...s })),
    commandText: state.commandText,
  }
}

export function undoLastWrite(editor) {
  if (!writeUndo) return false
  const snapshot = writeUndo
  writeUndo = null
  editor.commands.setContent(snapshot.json)
  state.spans = snapshot.spans.map((s) => ({ ...s }))
  state.commandText = snapshot.commandText
  emit()
  return true
}

export function remapAllTextSpans(mapping, doc) {
  state.spans = state.spans
    .map((span) => (span.kind === 'text' ? remapTextSpan(span, mapping, doc) : span))
    .filter(Boolean)
}

export function ping() {
  emit()
}

export function finishInsert({ slotId, mapping, doc, added }) {
  let next = state.spans.filter((s) => s.markId !== slotId)
  if (mapping && doc) {
    next = next
      .map((span) => (span.kind === 'text' ? remapTextSpan(span, mapping, doc) : span))
      .filter(Boolean)
  }
  if (added?.length) next = [...next, ...added.map((s) => ({ ...s, willEdit: true }))]
  state.spans = withMarks(next)
  emit()
}

export function refreshImageLayout(view) {
  if (!view) return false
  let changed = false
  state.spans = state.spans.map((span) => {
    if (span.kind !== 'image' || !span.block_id) return span
    const img = view.dom.querySelector(`img[data-block-id="${span.block_id}"]`)
    if (!img) return span
    const br = img.getBoundingClientRect()
    const imageRect = { x: br.left, y: br.top, w: br.width, h: br.height }
    const prev = span.imageRect
    if (
      prev &&
      Math.abs(prev.x - imageRect.x) < 0.5 &&
      Math.abs(prev.y - imageRect.y) < 0.5 &&
      Math.abs(prev.w - imageRect.w) < 0.5 &&
      Math.abs(prev.h - imageRect.h) < 0.5
    ) {
      return span
    }
    changed = true
    const screenRect =
      span.bbox && span.naturalSize
        ? naturalBoxToScreen(span.bbox, imageRect, span.naturalSize)
        : imageRect
    return { ...span, imageRect, screenRect }
  })
  return changed
}

export function targets() {
  return state.spans.filter((s) => s.willEdit !== false)
}

export function updateTextRange(markId, from, to, doc) {
  state.spans = state.spans.map((span) => {
    if (span.markId !== markId || span.kind !== 'text') return span
    if (from >= to) return span
    const $from = doc.resolve(Math.min(from, doc.content.size))
    let contentStart = span.from
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).attrs?.blockId === span.block_id) {
        contentStart = $from.start(depth)
        break
      }
    }
    return {
      ...span,
      from,
      to,
      start: from - contentStart,
      end: to - contentStart,
      text: doc.textBetween(from, to),
    }
  })
  emit()
}

export function toggleBackground(markId) {
  let changed = false
  let mode = null
  state.spans = state.spans.map((span) => {
    if (span.kind !== 'image') return span
    if (markId && span.markId !== markId) return span
    if (!markId && span.willEdit === false) return span
    const canvas = seedMask(span)
    invertMask(canvas)
    const next = syncImageFromMask(span, canvas)
    if (!next) {
      invertMask(canvas)
      return span
    }
    changed = true
    mode = span.mode === 'background' ? 'region' : 'background'
    return { ...next, mode }
  })
  if (changed) emit()
  return changed ? mode : null
}

export function setSuggest(items) {
  state.suggest = items?.length ? items : []
  emit()
}

export function setCommandText(text) {
  state.commandText = text
}

export function clearAll() {
  state.spans = []
  state.links = []
  state.suggest = []
  emit()
}

export function hasImage(onlyTargets = false) {
  const list = onlyTargets ? targets() : state.spans
  return list.some((s) => s.kind === 'image')
}

export function hasSlot(onlyTargets = false) {
  const list = onlyTargets ? targets() : state.spans
  return list.some((s) => s.kind === 'slot')
}

export function coversTextPos(pos) {
  return state.spans.some((s) => s.kind === 'text' && pos >= s.from && pos < s.to)
}

function findImageIndex(blockId) {
  return state.spans.findIndex((s) => s.kind === 'image' && s.block_id === blockId)
}

function seedMask(span) {
  if (span.maskCanvas) return span.maskCanvas
  const canvas = makeMask(span.naturalSize || { w: 1, h: 1 })
  if (span.bbox) paintMask(canvas, rectToPoly(span.bbox), 'replace')
  return canvas
}

function syncImageFromMask(span, canvas) {
  const bbox = maskBounds(canvas)
  if (!bbox) return null
  return {
    ...span,
    maskCanvas: canvas,
    bbox,
    mask: { ...bbox },
    screenRect: naturalBoxToScreen(bbox, span.imageRect, span.naturalSize),
  }
}

export function spanWithMaskCanvas(span, canvas) {
  const next = syncImageFromMask(span, canvas)
  return next ? { ...next, mode: span.mode || 'region' } : null
}

export function applyImagePolygon(hit, polygon, mode) {
  const polyN = screenPolyToNatural(polygon, hit.imageRect, hit.naturalSize)
  const i = findImageIndex(hit.block_id)
  if (i < 0) return false

  const cur = state.spans[i]
  const canvas = seedMask(cur)
  paintMask(canvas, polyN, mode === 'erase' ? 'erase' : mode === 'replace' ? 'replace' : 'add')
  const next = syncImageFromMask(cur, canvas)
  if (!next) {
    state.spans = withMarks(state.spans.filter((s) => s.markId !== cur.markId))
    emit()
    return true
  }
  state.spans[i] = next
  emit()
  return true
}

export function unionImageMask(hit, canvas) {
  const i = findImageIndex(hit.block_id)
  if (i < 0 || !canvas) return false
  const cur = state.spans[i]
  const dst = seedMask(cur)
  const ctx = dst.getContext('2d')
  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.drawImage(canvas, 0, 0)
  ctx.restore()
  const next = syncImageFromMask(cur, dst)
  if (!next) return false
  state.spans[i] = next
  emit()
  return true
}

export function unionImageSpan(next, polygon) {
  const poly = polygon || next.polygon
  if (!poly) return false
  return applyImagePolygon(next, poly, 'add')
}

export function eraseImageSpan(next, polygon) {
  const poly = polygon || next.polygon
  if (!poly) return false
  return applyImagePolygon(next, poly, 'erase')
}

export function eraseSlots(polygon) {
  const box = aabb(polygon)
  const before = state.spans.length
  state.spans = withMarks(
    state.spans.filter((span) => {
      if (span.kind !== 'slot') return true
      return !intersectBoxes(span.screenRect, box)
    }),
  )
  if (state.spans.length === before) return false
  emit()
  return true
}

export function updateImageScreenRect(markId, screenRect) {
  state.spans = state.spans.map((span) => {
    if (span.markId !== markId || span.kind !== 'image' || !span.imageRect) return span
    if (span.mode === 'background') return span
    const clamped = clampBox(screenRect, span.imageRect)
    const canvas = seedMask(span)
    clipMaskToRect(canvas, screenBoxToNatural(clamped, span.imageRect, span.naturalSize))
    return syncImageFromMask(span, canvas) || span
  })
  emit()
}
