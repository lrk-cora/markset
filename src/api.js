const CALL_HEADER = { 'Content-Type': 'application/json', 'X-MarkSet-Call': '1' }

export function setClientModelGate(_on) {}

export function isClientModelGateOn() {
  return true
}

export async function fetchHealth() {
  const res = await fetch('/api/health')
  if (!res.ok) throw new Error('health failed')
  return res.json()
}

async function post(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: CALL_HEADER,
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `http ${res.status}`)
    err.code = data.code || String(res.status)
    throw err
  }
  return data
}

export function rewriteText(instruction, text, extra = {}) {
  return post('/api/rewrite', { instruction, text, ...extra })
}

export function inpaintImage({ prompt, imageDataUrl, maskDataUrl }) {
  return post('/api/inpaint', { prompt, imageDataUrl, maskDataUrl })
}

export function generateImage({
  prompt,
  imageDataUrl,
  width,
  height,
  replaceExisting,
  contextImageDataUrls,
  pageContext,
}) {
  return post('/api/generate-image', {
    prompt,
    imageDataUrl,
    width,
    height,
    replaceExisting: Boolean(replaceExisting),
    contextImageDataUrls: contextImageDataUrls || [],
    pageContext: pageContext || '',
  })
}

export function segmentImage({ imageDataUrl, box, points }) {
  return post('/api/sam', { imageDataUrl, box, points })
}

export function planOps(payload) {
  return post('/api/plan', payload)
}

export async function planIntent(payload) {
  const res = await fetch('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `http ${res.status}`)
    err.code = data.code || String(res.status)
    throw err
  }
  return data
}

export async function importPage(payload) {
  const headers = { ...CALL_HEADER }
  const res = await fetch('/api/import-page', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload || {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `导入失败 ${res.status}`)
    err.code = data.code || String(res.status)
    throw err
  }
  return data
}
