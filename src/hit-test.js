import {
  aabb,
  clientRectBox,
  intersectBoxes,
  pointInPolygon,
  rectIntersectsPolygon,
} from './geometry.js'
import { coversTextPos } from './store.js'

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
  hits.sort((a, b) => a.pos - b.pos)
  const runs = []
  let from = hits[0].pos
  let to = hits[0].pos + 1
  for (let i = 1; i < hits.length; i += 1) {
    const pos = hits[i].pos
    if (pos <= to) {
      to = Math.max(to, pos + 1)
    } else {
      runs.push({ from, to })
      from = pos
      to = pos + 1
    }
  }
  runs.push({ from, to })

  return runs.map((run) => {
    const info = blockInfo(view.state, run.from)
    return {
      kind: 'text',
      block_id: info?.blockId ?? null,
      start: info ? run.from - info.contentStart : run.from,
      end: info ? run.to - info.contentStart : run.to,
      text: view.state.doc.textBetween(run.from, run.to),
      from: run.from,
      to: run.to,
    }
  })
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

  return mergeCharHits(view, hits)
}

function imageNaturalBox(img, screenBox) {
  const br = img.getBoundingClientRect()
  const nw = img.naturalWidth || Number(img.getAttribute('width')) || br.width
  const nh = img.naturalHeight || Number(img.getAttribute('height')) || br.height
  const sx = nw / br.width
  const sy = nh / br.height
  return {
    x: (screenBox.x - br.left) * sx,
    y: (screenBox.y - br.top) * sy,
    w: screenBox.w * sx,
    h: screenBox.h * sy,
  }
}

function imageSpanFromClip(img, clip) {
  const bbox = imageNaturalBox(img, clip)
  return {
    kind: 'image',
    block_id: img.getAttribute('data-block-id'),
    mask: { ...bbox },
    bbox,
    screenRect: { ...clip },
  }
}

export function hitImages(view, polygon) {
  const imgs = view.dom.querySelectorAll('img[data-block-id]')
  const found = []
  const suggest = []
  const polyBox = aabb(polygon)

  for (const img of imgs) {
    const br = img.getBoundingClientRect()
    if (!rectIntersectsPolygon(br, polygon)) continue
    const clip = intersectBoxes(polyBox, clientRectBox(br))
    if (!clip) continue
    const span = imageSpanFromClip(img, clip)
    if (clip.w * clip.h < SMALL_AREA) {
      suggest.push(span)
    } else {
      found.push(span)
    }
  }

  return { found, suggest }
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
  const bounds = wordBounds(textNode.nodeValue, range.startOffset)
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
