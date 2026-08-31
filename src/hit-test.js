import {
  aabb,
  clientRectBox,
  intersectBoxes,
  pointInPolygon,
  rectIntersectsPolygon,
  subtractBox,
} from './geometry.js'
import {
  makeMask,
  maskBounds,
  naturalBoxToScreen,
  paintMask,
  screenPolyToNatural,
} from './mask.js'
import { COLOR_TERMS, FORBIDDEN_RE, PRODUCT_ALIASES, RELATED_TERMS, isForbiddenSpan } from './forbidden.js'
import { coversTextPos, getSnapshot } from './store.js'

const SMALL_AREA = 24 * 24

function blockInfo(state, pos) {
  const $pos = state.doc.resolve(pos)
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth)
    if (node.attrs?.blockId) {
      return {
        blockId: node.attrs.blockId,
        contentStart: $pos.start(depth),
      }
    }
  }
  return null
}

function mergeCharHits(view, hits) {
  if (!hits.length) return []
  const byBlock = new Map()
  for (const { pos } of hits) {
    const info = blockInfo(view.state, pos)
    const key = info?.blockId ?? `pos:${pos}`
    const cur = byBlock.get(key)
    if (!cur) {
      byBlock.set(key, { info, from: pos, to: pos + 1 })
    } else {
      cur.from = Math.min(cur.from, pos)
      cur.to = Math.max(cur.to, pos + 1)
    }
  }

  return [...byBlock.values()]
    .map((run) => ({
      kind: 'text',
      block_id: run.info?.blockId ?? null,
      start: run.info ? run.from - run.info.contentStart : run.from,
      end: run.info ? run.to - run.info.contentStart : run.to,
      text: view.state.doc.textBetween(run.from, run.to),
      from: run.from,
      to: run.to,
    }))
    .sort((a, b) => a.from - b.from)
}

export function hitText(view, polygon, { skipCovered = false } = {}) {
  const root = view.dom
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const hits = []

  while (walker.nextNode()) {
    const textNode = walker.currentNode
    const value = textNode.nodeValue
    if (!value) continue

    for (let i = 0; i < value.length; i += 1) {
      if (/\s/.test(value[i]) && value[i] !== ' ') continue
      const range = document.createRange()
      range.setStart(textNode, i)
      range.setEnd(textNode, i + 1)
      const rects = [...range.getClientRects()]
      for (const rect of rects) {
        if (rect.width < 0.4 || rect.height < 0.4) continue
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        if (pointInPolygon(cx, cy, polygon) || rectIntersectsPolygon(rect, polygon)) {
          let pos
          try {
            pos = view.posAtDOM(textNode, i)
          } catch {
            continue
          }
          if (skipCovered && coversTextPos(pos)) continue
          hits.push({ pos })
        }
      }
    }
  }

  const found = []
  const suggest = []
  for (const span of mergeCharHits(view, hits)) {
    const n = span.text.replace(/\s/g, '').length
    if (n > 0 && n <= 2) suggest.push({ ...span, suggestReason: 'short' })
    else found.push(span)
  }
  return { found, suggest }
}

export function countOccurrences(hay, needle) {
  if (!needle) return 0
  let n = 0
  let i = 0
  while ((i = hay.indexOf(needle, i)) >= 0) {
    n += 1
    i += needle.length
  }
  return n
}

export function docPlain(view) {
  return view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '')
}

export function needlesFromText(text, docText) {
  const t = String(text || '').trim()
  if (t.replace(/\s/g, '').length < 2) return []
  const found = []
  if (countOccurrences(docText, t) >= 2) found.push(t)
  const maxLen = Math.min(8, t.length)
  for (let len = maxLen; len >= 2; len -= 1) {
    for (let i = 0; i + len <= t.length; i += 1) {
      const sub = t.slice(i, i + len)
      if (!/^[\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9]*$/.test(sub)) continue
      if (countOccurrences(docText, sub) >= 2) found.push(sub)
    }
  }
  const uniq = [...new Set(found)].sort((a, b) => b.length - a.length)
  return uniq.filter((s, i) => !uniq.some((other, j) => j < i && other.includes(s)))
}

export function uniqueSuggests(items) {
  const seen = new Set()
  const out = []
  for (const span of items || []) {
    if (!span) continue
    const key =
      span.kind === 'text'
        ? `t:${span.from}:${span.to}`
        : `i:${span.block_id}:${Math.round(span.bbox?.x || 0)}:${Math.round(span.bbox?.y || 0)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(span)
  }
  return out
}

function textHit(view, needle, from, to, reason) {
  const info = blockInfo(view.state, from)
  const span = {
    kind: 'text',
    suggestReason: reason,
    block_id: info?.blockId ?? null,
    start: info ? from - info.contentStart : from,
    end: info ? to - info.contentStart : to,
    text: needle,
    from,
    to,
  }
  if (isForbiddenSpan(span)) return null
  return span
}

export function findSameText(view, needle, occupied = []) {
  const compact = String(needle || '').replace(/\s/g, '')
  if (compact.length < 2) return []
  const overlaps = (from, to) =>
    occupied.some((s) => s.kind === 'text' && from < s.to && to > s.from) || coversTextPos(from)
  const found = []
  view.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const value = node.text
    let searchFrom = 0
    while (searchFrom < value.length) {
      const i = value.indexOf(needle, searchFrom)
      if (i < 0) break
      const from = pos + i
      const to = from + needle.length
      searchFrom = i + Math.max(1, needle.length)
      if (overlaps(from, to)) continue
      const span = textHit(view, needle, from, to, compact.length <= 2 ? 'short' : 'same')
      if (span) found.push(span)
    }
  })
  return found
}

export function collectDuplicateSuggests(view) {
  const occupied = getSnapshot().spans.filter((s) => s.kind === 'text')
  const hay = docPlain(view)
  const set = new Set()
  for (const span of occupied) {
    for (const needle of needlesFromText(span.text, hay)) set.add(needle)
  }
  const dups = []
  for (const needle of [...set].sort((a, b) => b.length - a.length)) {
    dups.push(...findSameText(view, needle, occupied))
  }
  return uniqueSuggests(dups)
}

export function collectSemanticSuggests(view) {
  const occupied = getSnapshot().spans.filter((s) => s.kind === 'text')
  const selected = occupied.map((s) => s.text || '').join('')
  const hay = docPlain(view)
  const hits = []
  for (const term of RELATED_TERMS) {
    if (selected.includes(term) && needlesFromText(selected, hay).some((n) => n.includes(term) && n !== term)) {
      continue
    }
    if (!hay.includes(term)) continue
    if (selected === term) continue
    const found = findSameText(view, term, occupied).map((s) => ({ ...s, suggestReason: 'semantic' }))
    hits.push(...found)
  }
  return uniqueSuggests(hits)
}

export function collectAliasSuggests(view) {
  const occupied = getSnapshot().spans.filter((s) => s.kind === 'text')
  const needles = new Set()
  for (const span of occupied) {
    const t = String(span.text || '')
    for (const [canon, aliases] of Object.entries(PRODUCT_ALIASES)) {
      if (t.includes(canon) || t === canon) aliases.forEach((a) => needles.add(a))
      if (aliases.some((a) => t === a || t.includes(a))) needles.add(canon)
    }
  }
  const hits = []
  for (const needle of needles) {
    hits.push(
      ...findSameText(view, needle, occupied).map((s) => ({ ...s, suggestReason: 'print' })),
    )
  }
  return uniqueSuggests(hits)
}

export function collectContradictionSuggests(view) {
  const occupied = getSnapshot().spans.filter((s) => s.kind === 'text')
  const hits = []
  for (const term of COLOR_TERMS) {
    hits.push(
      ...findSameText(view, term, occupied)
        .filter((s) => s.block_id !== 'p-note')
        .map((s) => ({ ...s, suggestReason: 'contradiction' })),
    )
  }
  return uniqueSuggests(hits)
}

export function mergeSuggests(view, extra = []) {
  return uniqueSuggests([...(extra || []), ...collectDuplicateSuggests(view)])
}

export function isTinyImageSpan(span) {
  return Boolean(
    span?.kind === 'image' && span.screenRect && span.screenRect.w * span.screenRect.h < 96 * 96,
  )
}

export function looksLikePriceBleed(spans) {
  return spans.some((s) => s.kind === 'text' && (/[¥￥]/.test(s.text) || FORBIDDEN_RE.test(s.text)))
}

export function imageSpanFromPolygon(img, polygon) {
  const br = img.getBoundingClientRect()
  if (!rectIntersectsPolygon(br, polygon)) return null
  const imageRect = { x: br.left, y: br.top, w: br.width, h: br.height }
  const nw = img.naturalWidth || Number(img.getAttribute('width')) || br.width
  const nh = img.naturalHeight || Number(img.getAttribute('height')) || br.height
  const naturalSize = { w: nw, h: nh }
  const canvas = makeMask(naturalSize)
  paintMask(canvas, screenPolyToNatural(polygon, imageRect, naturalSize), 'replace')
  const bbox = maskBounds(canvas)
  if (!bbox) return null
  return {
    kind: 'image',
    block_id: img.getAttribute('data-block-id'),
    maskCanvas: canvas,
    mask: { ...bbox },
    bbox,
    screenRect: naturalBoxToScreen(bbox, imageRect, naturalSize),
    imageRect,
    naturalSize,
    mode: 'region',
    polygon,
  }
}

function imageSpanFromClip(img, clip) {
  return imageSpanFromPolygon(img, [
    { x: clip.x, y: clip.y },
    { x: clip.x + clip.w, y: clip.y },
    { x: clip.x + clip.w, y: clip.y + clip.h },
    { x: clip.x, y: clip.y + clip.h },
  ])
}

export function hitImages(view, polygon) {
  const imgs = view.dom.querySelectorAll('img[data-block-id]')
  const found = []
  const suggest = []

  for (const img of imgs) {
    const span = imageSpanFromPolygon(img, polygon)
    if (!span) continue
    if (span.screenRect.w * span.screenRect.h < SMALL_AREA) suggest.push(span)
    else found.push(span)
  }

  return { found, suggest }
}

export function hitPageSlot(polygon, view) {
  const page = document.querySelector('.page')
  if (!page) return null
  const pageBox = clientRectBox(page.getBoundingClientRect())
  const clip = intersectBoxes(aabb(polygon), pageBox)
  if (!clip || clip.w < 28 || clip.h < 28) return null

  const occupied = []
  const root = view?.dom ?? page
  for (const el of root.querySelectorAll('[data-block-id]')) {
    occupied.push(clientRectBox(el.getBoundingClientRect()))
  }

  let pieces = [clip]
  for (const box of occupied) {
    pieces = pieces.flatMap((piece) => subtractBox(piece, box))
  }
  pieces = pieces.filter((p) => p.w >= 28 && p.h >= 28)
  if (!pieces.length) return null
  pieces.sort((a, b) => b.w * b.h - a.w * a.h)

  return {
    kind: 'slot',
    screenRect: pieces[0],
    pageBox,
  }
}

function rangeFromPoint(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y)
  const pos = document.caretPositionFromPoint?.(x, y)
  if (!pos) return null
  const range = document.createRange()
  range.setStart(pos.offsetNode, pos.offset)
  range.collapse(true)
  return range
}

function longestRepeatedCovering(local, index, hay) {
  if (!local) return null
  const maxLen = Math.min(8, local.length)
  for (let len = maxLen; len >= 2; len -= 1) {
    const startMin = Math.max(0, index - len + 1)
    const startMax = Math.min(index, local.length - len)
    for (let start = startMin; start <= startMax; start += 1) {
      const sub = local.slice(start, start + len)
      if (!/^[\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9]*$/.test(sub)) continue
      if (countOccurrences(hay, sub) >= 2) return [start, start + len]
    }
  }
  return null
}

function isWordChar(ch) {
  return /[A-Za-z0-9\u4e00-\u9fff]/.test(ch ?? '')
}

function wordBounds(text, index) {
  if (index < 0 || index > text.length) return null
  const at = Math.min(index, Math.max(0, text.length - 1))
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const parts = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)]
    const useful = (part) => /[A-Za-z0-9\u4e00-\u9fff]/.test(part.segment)
    const covering = parts.find((p) => at >= p.index && at < p.index + p.segment.length)
    const hit =
      (covering && useful(covering) && covering) ||
      parts.find((p) => p.index >= at && useful(p)) ||
      [...parts].reverse().find((p) => p.index <= at && useful(p))
    if (hit) return [hit.index, hit.index + hit.segment.length]
  }
  if (!isWordChar(text[at])) {
    let i = at
    while (i > 0 && !isWordChar(text[i])) i -= 1
    if (!isWordChar(text[i])) return null
    return wordBounds(text, i)
  }
  let a = at
  let b = at + 1
  while (a > 0 && isWordChar(text[a - 1])) a -= 1
  while (b < text.length && isWordChar(text[b])) b += 1
  return [a, b]
}

export function hitWordAt(view, x, y) {
  const range = rangeFromPoint(x, y)
  if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null
  if (!view.dom.contains(range.startContainer)) return null
  const textNode = range.startContainer
  const covering = longestRepeatedCovering(textNode.nodeValue, range.startOffset, docPlain(view))
  const bounds = covering || wordBounds(textNode.nodeValue, range.startOffset)
  if (!bounds) return null
  let from
  let to
  try {
    from = view.posAtDOM(textNode, bounds[0])
    to = view.posAtDOM(textNode, bounds[1])
  } catch {
    return null
  }
  if (from >= to) return null
  return mergeCharHits(view, Array.from({ length: to - from }, (_, i) => ({ pos: from + i })))[0]
}

export function blockRange(doc, span) {
  const $pos = doc.resolve(span.from)
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).attrs?.blockId === span.block_id) {
      const start = $pos.start(depth)
      return { start, end: start + $pos.node(depth).content.size }
    }
  }
  return { start: span.from, end: span.to }
}

export function hitImageAt(view, x, y, size = 48) {
  const el = document.elementFromPoint(x, y)
  const img = el?.closest?.('img[data-block-id]')
  if (!img || !view.dom.contains(img)) return null
  const br = img.getBoundingClientRect()
  const box = {
    x: Math.max(br.left, x - size / 2),
    y: Math.max(br.top, y - size / 2),
    w: size,
    h: size,
  }
  box.w = Math.min(box.x + box.w, br.right) - box.x
  box.h = Math.min(box.y + box.h, br.bottom) - box.y
  if (box.w < 4 || box.h < 4) return null
  return imageSpanFromClip(img, box)
}
