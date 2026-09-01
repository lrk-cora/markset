import { loadImageEl } from './mask.js'

function sampleHasAlpha(image) {
  const canvas = document.createElement('canvas')
  const w = Math.min(64, image.naturalWidth || image.width || 1)
  const h = Math.min(64, image.naturalHeight || image.height || 1)
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true
  }
  return false
}

function sampleLooksLikeMask(image) {
  const canvas = document.createElement('canvas')
  const w = Math.min(48, image.naturalWidth || image.width || 1)
  const h = Math.min(48, image.naturalHeight || image.height || 1)
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  let n = 0
  let binary = 0
  for (let i = 0; i < data.length; i += 4) {
    n += 1
    const y = (data[i] + data[i + 1] + data[i + 2]) / 3
    const chroma =
      Math.abs(data[i] - data[i + 1]) + Math.abs(data[i + 1] - data[i + 2]) + Math.abs(data[i] - data[i + 2])
    if (chroma < 24 && (y < 28 || y > 227)) binary += 1
  }
  return n > 0 && binary / n > 0.9
}

/**
 * fal fill may return a finished RGB image or an RGBA patch.
 * Composite onto the original using our selection mask (or the result alpha).
 */
export async function resolveInpaintResult(originalUrl, resultUrl, maskCanvas) {
  const orig = await loadImageEl(originalUrl)
  const result = await loadImageEl(resultUrl)
  const out = document.createElement('canvas')
  out.width = orig.naturalWidth || orig.width
  out.height = orig.naturalHeight || orig.height
  const ctx = out.getContext('2d')
  ctx.drawImage(orig, 0, 0, out.width, out.height)

  const tmp = document.createElement('canvas')
  tmp.width = out.width
  tmp.height = out.height
  const tctx = tmp.getContext('2d')
  tctx.drawImage(result, 0, 0, out.width, out.height)

  if (sampleHasAlpha(result) && !sampleLooksLikeMask(result)) {
    ctx.drawImage(tmp, 0, 0)
    return out.toDataURL('image/png')
  }

  tctx.globalCompositeOperation = 'destination-in'
  if (maskCanvas) tctx.drawImage(maskCanvas, 0, 0, out.width, out.height)
  ctx.drawImage(tmp, 0, 0)
  return out.toDataURL('image/png')
}
