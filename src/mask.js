/** Pixel mask at the image's natural size. White/opaque = selected. */

export function makeMask(naturalSize) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(naturalSize.w))
  canvas.height = Math.max(1, Math.round(naturalSize.h))
  return canvas
}

export function screenPolyToNatural(polygon, imageRect, naturalSize) {
  const sx = naturalSize.w / imageRect.w
  const sy = naturalSize.h / imageRect.h
  return polygon.map((p) => ({
    x: (p.x - imageRect.x) * sx,
    y: (p.y - imageRect.y) * sy,
  }))
}

export function rectToPoly(box) {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ]
}

export function paintMask(canvas, polygonNatural, mode) {
  if (!polygonNatural.length) return
  const ctx = canvas.getContext('2d')
  if (mode === 'replace') ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(polygonNatural[0].x, polygonNatural[0].y)
  for (let i = 1; i < polygonNatural.length; i += 1) {
    ctx.lineTo(polygonNatural[i].x, polygonNatural[i].y)
  }
  ctx.closePath()
  if (mode === 'erase') {
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fill()
  } else {
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#ffffff'
    ctx.fill()
  }
  ctx.restore()
}

/** Stroke along a path (color pen). White/opaque = region to inpaint. */
export function paintStrokeMask(canvas, pointsNatural, width) {
  if (!pointsNatural?.length) return
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.save()
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = Math.max(8, width || 24)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(pointsNatural[0].x, pointsNatural[0].y)
  for (let i = 1; i < pointsNatural.length; i += 1) {
    ctx.lineTo(pointsNatural[i].x, pointsNatural[i].y)
  }
  ctx.stroke()
  ctx.restore()
}

export function strokeWidthFor(naturalSize) {
  const m = Math.min(naturalSize?.w || 1, naturalSize?.h || 1)
  return Math.max(18, Math.round(m * 0.035))
}

/** Flip selected ↔ unselected. White/opaque remains “selected”. */
export function invertMask(canvas) {
  const ctx = canvas.getContext('2d')
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = image.data
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255
    data[i + 1] = 255
    data[i + 2] = 255
    data[i + 3] = data[i + 3] > 12 ? 0 : 255
  }
  ctx.putImageData(image, 0, 0)
}

export function clipMaskToRect(canvas, box) {
  const ctx = canvas.getContext('2d')
  ctx.save()
  ctx.globalCompositeOperation = 'destination-in'
  ctx.fillStyle = '#fff'
  ctx.fillRect(box.x, box.y, box.w, box.h)
  ctx.restore()
}

export function maskBounds(canvas) {
  const w = canvas.width
  const h = canvas.height
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data
  let minX = w
  let minY = h
  let maxX = 0
  let maxY = 0
  let any = false
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4 + 3] > 12) {
        any = true
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (!any) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

export function maskCentroid(canvas) {
  const w = canvas.width
  const h = canvas.height
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data
  let sx = 0
  let sy = 0
  let n = 0
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4 + 3] > 12) {
        sx += x
        sy += y
        n += 1
      }
    }
  }
  if (n < 8) return null
  return { x: Math.round(sx / n), y: Math.round(sy / n) }
}

export function dilateMask(src, radius) {
  const r = Math.max(1, Math.round(radius))
  const out = makeMask({ w: src.width, h: src.height })
  const ctx = out.getContext('2d')
  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      if (dx * dx + dy * dy > r * r) continue
      ctx.drawImage(src, dx, dy)
    }
  }
  return out
}

export function intersectMasks(a, b) {
  const out = makeMask({ w: a.width, h: a.height })
  const ctx = out.getContext('2d')
  ctx.drawImage(a, 0, 0)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(b, 0, 0)
  return out
}

export function maskPixelCount(canvas) {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
  let n = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] > 12) n += 1
  return n
}

export function naturalBoxToScreen(bbox, imageRect, naturalSize) {
  return {
    x: imageRect.x + (bbox.x / naturalSize.w) * imageRect.w,
    y: imageRect.y + (bbox.y / naturalSize.h) * imageRect.h,
    w: (bbox.w / naturalSize.w) * imageRect.w,
    h: (bbox.h / naturalSize.h) * imageRect.h,
  }
}

export function screenBoxToNatural(box, imageRect, naturalSize) {
  return {
    x: ((box.x - imageRect.x) / imageRect.w) * naturalSize.w,
    y: ((box.y - imageRect.y) / imageRect.h) * naturalSize.h,
    w: (box.w / imageRect.w) * naturalSize.w,
    h: (box.h / imageRect.h) * naturalSize.h,
  }
}

/** White = inpaint, black = keep. Opaque RGB PNG, same size as the photo. */
export function maskToFalDataUrl(maskCanvas) {
  const out = document.createElement('canvas')
  out.width = maskCanvas.width
  out.height = maskCanvas.height
  const ctx = out.getContext('2d')
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, out.width, out.height)
  const src = maskCanvas.getContext('2d').getImageData(0, 0, maskCanvas.width, maskCanvas.height)
  const dst = ctx.getImageData(0, 0, out.width, out.height)
  for (let i = 0; i < src.data.length; i += 4) {
    const on = src.data[i + 3] > 12
    dst.data[i] = on ? 255 : 0
    dst.data[i + 1] = on ? 255 : 0
    dst.data[i + 2] = on ? 255 : 0
    dst.data[i + 3] = 255
  }
  ctx.putImageData(dst, 0, 0)
  return out.toDataURL('image/png')
}

export function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image load'))
    image.src = src
  })
}

export async function maskCanvasFromDataUrl(dataUrl, naturalSize) {
  const image = await loadImageEl(dataUrl)
  const canvas = makeMask(naturalSize)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = img.data
  const src = new Uint8ClampedArray(data)
  const total = canvas.width * canvas.height
  let hasAlpha = false
  for (let i = 3; i < src.length; i += 4) {
    if (src[i] < 250) {
      hasAlpha = true
      break
    }
  }

  const apply = (pred) => {
    let lit = 0
    for (let i = 0; i < data.length; i += 4) {
      const on = pred(src[i], src[i + 1], src[i + 2], src[i + 3])
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      data[i + 3] = on ? 255 : 0
      if (on) lit += 1
    }
    return lit
  }

  let lit = hasAlpha
    ? apply((_r, _g, _b, a) => a > 12)
    : apply((r, g, b) => (r + g + b) / 3 > 140)
  if (lit < 16 && !hasAlpha) lit = apply((r, g, b) => (r + g + b) / 3 > 40)
  if (lit > total * 0.78) {
    for (let i = 3; i < data.length; i += 4) data[i] = data[i] ? 0 : 255
    lit = total - lit
  }
  if (lit < 16) return null
  ctx.putImageData(img, 0, 0)
  return canvas
}

export function tintedMaskCanvas(maskCanvas) {
  const out = document.createElement('canvas')
  out.width = maskCanvas.width
  out.height = maskCanvas.height
  const ctx = out.getContext('2d')
  ctx.fillStyle = 'rgba(60, 111, 212, 0.28)'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(maskCanvas, 0, 0)
  return out
}
