import { loadImageEl, maskBounds } from './mask.js'
import { targetRgb } from './plan-local.js'

function clampByte(n) {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function scaledMask(maskCanvas, w, h) {
  if (maskCanvas.width === w && maskCanvas.height === h) return maskCanvas
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(maskCanvas, 0, 0, w, h)
  return canvas
}

function fillMasked(image, maskCanvas, fill) {
  const out = document.createElement('canvas')
  out.width = image.naturalWidth || image.width
  out.height = image.naturalHeight || image.height
  const ctx = out.getContext('2d')
  ctx.drawImage(image, 0, 0, out.width, out.height)
  const overlay = document.createElement('canvas')
  overlay.width = out.width
  overlay.height = out.height
  const octx = overlay.getContext('2d')
  octx.fillStyle = fill
  octx.fillRect(0, 0, overlay.width, overlay.height)
  octx.globalCompositeOperation = 'destination-in'
  octx.drawImage(scaledMask(maskCanvas, out.width, out.height), 0, 0)
  ctx.drawImage(overlay, 0, 0)
  return out.toDataURL('image/png')
}

function stampMasked(image, maskCanvas, label) {
  const out = document.createElement('canvas')
  out.width = image.naturalWidth || image.width
  out.height = image.naturalHeight || image.height
  const ctx = out.getContext('2d')
  ctx.drawImage(image, 0, 0, out.width, out.height)
  const mask = scaledMask(maskCanvas, out.width, out.height)
  const box = maskBounds(mask) || { x: 0, y: 0, w: out.width, h: out.height }
  const imgData = ctx.getImageData(0, 0, out.width, out.height)
  const maskData = mask.getContext('2d').getImageData(0, 0, out.width, out.height).data
  const data = imgData.data
  let sr = 0
  let sg = 0
  let sb = 0
  let n = 0
  for (let i = 0; i < data.length; i += 4) {
    if (maskData[i + 3] < 12) continue
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    if (luma > 95) {
      sr += data[i]
      sg += data[i + 1]
      sb += data[i + 2]
      n += 1
    }
  }
  if (n) {
    const gr = sr / n
    const gg = sg / n
    const gb = sb / n
    for (let i = 0; i < data.length; i += 4) {
      if (maskData[i + 3] < 12) continue
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      if (luma < 108) {
        const t = Math.min(1, (108 - luma) / 70)
        data[i] = clampByte(data[i] * (1 - t) + gr * t)
        data[i + 1] = clampByte(data[i + 1] * (1 - t) + gg * t)
        data[i + 2] = clampByte(data[i + 2] * (1 - t) + gb * t)
      }
    }
    ctx.putImageData(imgData, 0, 0)
  }
  const text = String(label || '').trim().slice(0, 8) || '原木杯'
  const size = Math.max(18, Math.round(Math.min(box.w / Math.max(2, text.length), box.h * 0.55)))
  ctx.save()
  ctx.beginPath()
  ctx.rect(box.x, box.y, box.w, box.h)
  ctx.clip()
  ctx.font = `650 ${size}px "Microsoft YaHei", "PingFang SC", "SimHei", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#2a221c'
  ctx.translate(box.x + box.w / 2, box.y + box.h / 2)
  ctx.scale(0.92, 1)
  ctx.fillText(text, 0, 0)
  ctx.restore()
  return out.toDataURL('image/png')
}

function colorizeMasked(image, maskCanvas, rgb) {
  const out = document.createElement('canvas')
  out.width = image.naturalWidth || image.width
  out.height = image.naturalHeight || image.height
  const ctx = out.getContext('2d')
  ctx.drawImage(image, 0, 0, out.width, out.height)
  const mask = scaledMask(maskCanvas, out.width, out.height)
  const imgData = ctx.getImageData(0, 0, out.width, out.height)
  const maskData = mask.getContext('2d').getImageData(0, 0, out.width, out.height).data
  const data = imgData.data
  const [tr, tg, tb] = rgb
  const tLuma = Math.max(18, 0.299 * tr + 0.587 * tg + 0.114 * tb)
  for (let i = 0; i < data.length; i += 4) {
    const a = maskData[i + 3]
    if (a < 12) continue
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const luma = 0.299 * r + 0.587 * g + 0.114 * b
    const scale = luma / tLuma
    const t = (a / 255) * 0.9
    data[i] = clampByte(r * (1 - t) + tr * scale * t)
    data[i + 1] = clampByte(g * (1 - t) + tg * scale * t)
    data[i + 2] = clampByte(b * (1 - t) + tb * scale * t)
  }
  ctx.putImageData(imgData, 0, 0)
  return out.toDataURL('image/png')
}

export async function localPaintMasked(src, maskCanvas, commandText, kind, stampText, fact = null) {
  const image = await loadImageEl(src)
  if (kind === 'delete') return fillMasked(image, maskCanvas, '#d4c4b0')
  if (stampText) return stampMasked(image, maskCanvas, stampText)
  return colorizeMasked(image, maskCanvas, targetRgb(commandText, fact))
}
