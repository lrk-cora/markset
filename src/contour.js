import { isClientModelGateOn, segmentImage } from './api.js'
import { aabb, intersectBoxes } from './geometry.js'
import {
  dilateMask,
  intersectMasks,
  loadImageEl,
  makeMask,
  maskCanvasFromDataUrl,
  maskCentroid,
  maskPixelCount,
  paintMask,
  screenPolyToNatural,
} from './mask.js'
import { isTinyImageSpan } from './hit-test.js'
import { getSnapshot, replaceImageSpan, spanWithMaskCanvas } from './store.js'

let snapOn = false
let busy = false

export function isSnapOn() {
  return snapOn
}

export function setSnapOn(on) {
  snapOn = Boolean(on)
}

let skipObjectSnap = false
let packagingHint = false

export function armSkipObjectSnap() {
  skipObjectSnap = true
  packagingHint = true
}

export function peekSkipObjectSnap() {
  return skipObjectSnap
}

export function consumeSkipObjectSnap() {
  if (!skipObjectSnap) return false
  skipObjectSnap = false
  return true
}

export function peekPackagingHint() {
  return packagingHint
}

export function consumePackagingHint() {
  if (!packagingHint) return false
  packagingHint = false
  return true
}

function boxFromLasso(polygon, imageRect, naturalSize) {
  const clip = intersectBoxes(aabb(polygon), imageRect)
  if (!clip) return null
  const sx = naturalSize.w / imageRect.w
  const sy = naturalSize.h / imageRect.h
  const xMin = Math.max(0, Math.floor((clip.x - imageRect.x) * sx))
  const yMin = Math.max(0, Math.floor((clip.y - imageRect.y) * sy))
  const xMax = Math.min(naturalSize.w - 1, Math.ceil((clip.x + clip.w - imageRect.x) * sx))
  const yMax = Math.min(naturalSize.h - 1, Math.ceil((clip.y + clip.h - imageRect.y) * sy))
  if (xMax - xMin < 8 || yMax - yMin < 8) return null
  return { x_min: xMin, y_min: yMin, x_max: xMax, y_max: yMax }
}

function boxFromBbox(bbox, naturalSize) {
  if (!bbox || !naturalSize) return null
  const xMin = Math.max(0, Math.floor(bbox.x))
  const yMin = Math.max(0, Math.floor(bbox.y))
  const xMax = Math.min(naturalSize.w - 1, Math.ceil(bbox.x + bbox.w))
  const yMax = Math.min(naturalSize.h - 1, Math.ceil(bbox.y + bbox.h))
  if (xMax - xMin < 8 || yMax - yMin < 8) return null
  return { x_min: xMin, y_min: yMin, x_max: xMax, y_max: yMax }
}

function pointFromClick(x, y, imageRect, naturalSize) {
  return {
    x: Math.round(((x - imageRect.x) / imageRect.w) * naturalSize.w),
    y: Math.round(((y - imageRect.y) / imageRect.h) * naturalSize.h),
    label: 1,
  }
}

async function elementToPng(img) {
  if (img.src.startsWith('data:image/png')) return img.src
  const image = await loadImageEl(img.src)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth || image.width
  canvas.height = image.naturalHeight || image.height
  canvas.getContext('2d').drawImage(image, 0, 0)
  return canvas.toDataURL('image/png')
}

function seedMask(span, polygon) {
  if (span.maskCanvas) return span.maskCanvas
  if (!polygon || !span.imageRect || !span.naturalSize) return null
  const canvas = makeMask(span.naturalSize)
  paintMask(canvas, screenPolyToNatural(polygon, span.imageRect, span.naturalSize), 'replace')
  return canvas
}

function bgPoints(box, seed) {
  const ctx = seed.getContext('2d')
  const spots = [
    [box.x_min, box.y_min],
    [box.x_max, box.y_min],
    [box.x_min, box.y_max],
    [box.x_max, box.y_max],
  ]
  const points = []
  for (const [x, y] of spots) {
    const px = Math.min(seed.width - 1, Math.max(0, x))
    const py = Math.min(seed.height - 1, Math.max(0, y))
    if (ctx.getImageData(px, py, 1, 1).data[3] < 12) {
      points.push({ x: px, y: py, label: 0 })
    }
  }
  return points
}

async function snapOne(span, { polygon, point } = {}) {
  const img =
    document.querySelector(`img[data-block-id="${span.block_id}"]`) ||
    document.querySelector(`#editor img[data-block-id="${span.block_id}"]`)
  if (!img) return span
  const seed = seedMask(span, polygon)
  const imageDataUrl = await elementToPng(img)
  const box = polygon
    ? boxFromLasso(polygon, span.imageRect, span.naturalSize)
    : boxFromBbox(span.bbox, span.naturalSize)
  const points = []
  if (point) {
    points.push(pointFromClick(point.x, point.y, span.imageRect, span.naturalSize))
  } else if (seed) {
    const center = maskCentroid(seed)
    if (center) points.push({ ...center, label: 1 })
  }
  if (box && seed) points.push(...bgPoints(box, seed))
  if (!box && !points.length) return span

  const { maskDataUrl } = await segmentImage({
    imageDataUrl,
    box,
    points: points.length ? points : undefined,
  })
  const sam = await maskCanvasFromDataUrl(maskDataUrl, span.naturalSize)
  if (!sam) return span

  let next = sam
  if (seed) {
    const radius = Math.max(14, Math.round(Math.min(span.naturalSize.w, span.naturalSize.h) * 0.04))
    const clipped = intersectMasks(sam, dilateMask(seed, radius))
    const kept = maskPixelCount(clipped)
    const samN = maskPixelCount(sam)
    if (kept >= 16 && (samN === 0 || kept / samN >= 0.12)) next = clipped
    else return span
  }
  return spanWithMaskCanvas(span, next) || span
}

export function canSnap() {
  return snapOn && isClientModelGateOn() && !busy
}

export async function snapImageHits(imageHits, { polygon, point } = {}, notify) {
  if (!canSnap() || consumeSkipObjectSnap()) return imageHits
  if (!imageHits.found.length && !imageHits.suggest.length) return imageHits
  const snapSpan = async (span) => (isTinyImageSpan(span) ? span : snapOne(span, { polygon, point }))
  busy = true
  notify?.('正在贴物体轮廓…')
  try {
    const found = []
    for (const span of imageHits.found) found.push(await snapSpan(span))
    const suggest = []
    for (const span of imageHits.suggest) suggest.push(await snapSpan(span))
    notify?.('已贴到物体轮廓')
    return { found, suggest }
  } catch (err) {
    const msg =
      err.code === 'calls_disabled'
        ? '服务器禁止调用，仍用套索像素'
        : err.code === 'client-gate' || err.code === 'no_client_gate'
          ? '未允许调用云端模型，仍用套索像素'
          : '轮廓未贴上，仍用套索像素'
    notify?.(msg)
    return imageHits
  } finally {
    busy = false
  }
}

export async function snapExistingMark(markId, notify) {
  if (!isClientModelGateOn()) {
    notify?.('先勾「允许调用云端模型」')
    return false
  }
  if (busy) {
    notify?.('正在贴轮廓，请稍候')
    return false
  }
  const span = getSnapshot().spans.find((s) => s.markId === markId && s.kind === 'image')
  if (!span) return false
  if (isTinyImageSpan(span)) {
    notify?.(`#${markId} 是很小一块，不贴物体（包装上的字请保持鼠标圈的范围）`)
    return false
  }
  busy = true
  notify?.(`正在把 #${markId} 贴到物体…`)
  try {
    const next = await snapOne(span, { polygon: span.polygon })
    if (!replaceImageSpan(markId, next)) throw new Error('写回选区失败')
    notify?.(`#${markId} 已贴到物体`)
    return true
  } catch (err) {
    const msg =
      err.code === 'calls_disabled'
        ? '服务器禁止调用，选区仍是鼠标圈的范围'
        : err.code === 'client-gate' || err.code === 'no_client_gate'
          ? '未允许调用云端模型，选区仍是鼠标圈的范围'
          : `#${markId} 未贴上，仍用鼠标圈的范围`
    notify?.(msg)
    return false
  } finally {
    busy = false
  }
}
