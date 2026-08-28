import { isClientModelGateOn, segmentImage } from './api.js'
import { aabb, intersectBoxes } from './geometry.js'
import { loadImageEl, maskCanvasFromDataUrl } from './mask.js'
import { spanWithMaskCanvas } from './store.js'

let snapOn = false
let busy = false

export function isSnapOn() {
  return snapOn
}

export function setSnapOn(on) {
  snapOn = Boolean(on)
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

function pointFromClick(x, y, imageRect, naturalSize) {
  return {
    x: Math.round(((x - imageRect.x) / imageRect.w) * naturalSize.w),
    y: Math.round(((y - imageRect.y) / imageRect.h) * naturalSize.h),
    label: 1,
  }
}

async function elementToDataUrl(img) {
  if (img.src.startsWith('data:')) return img.src
  const image = await loadImageEl(img.src)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth || image.width
  canvas.height = image.naturalHeight || image.height
  canvas.getContext('2d').drawImage(image, 0, 0)
  return canvas.toDataURL('image/jpeg', 0.92)
}

async function snapOne(span, { polygon, point }) {
  const img =
    document.querySelector(`img[data-block-id="${span.block_id}"]`) ||
    document.querySelector(`#editor img[data-block-id="${span.block_id}"]`)
  if (!img) return span
  const imageDataUrl = await elementToDataUrl(img)
  const payload = { imageDataUrl }
  if (point) payload.points = [pointFromClick(point.x, point.y, span.imageRect, span.naturalSize)]
  else payload.box = boxFromLasso(polygon, span.imageRect, span.naturalSize)
  if (!payload.box && !payload.points) return span
  const { maskDataUrl } = await segmentImage(payload)
  const canvas = await maskCanvasFromDataUrl(maskDataUrl, span.naturalSize)
  if (!canvas) return span
  return spanWithMaskCanvas(span, canvas) || span
}

export function canSnap() {
  return snapOn && isClientModelGateOn() && !busy
}

export async function snapImageHits(imageHits, { polygon, point } = {}, notify) {
  if (!canSnap()) return imageHits
  if (!imageHits.found.length && !imageHits.suggest.length) return imageHits
  busy = true
  notify?.('正在贴物体轮廓…')
  try {
    const found = []
    for (const span of imageHits.found) found.push(await snapOne(span, { polygon, point }))
    const suggest = []
    for (const span of imageHits.suggest) suggest.push(await snapOne(span, { polygon, point }))
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
