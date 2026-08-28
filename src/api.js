const CALL_HEADER = { 'Content-Type': 'application/json', 'X-MarkSet-Call': '1' }

let clientGate = false

export function setClientModelGate(on) {
  clientGate = Boolean(on)
}

export function isClientModelGateOn() {
  return clientGate
}

export async function fetchHealth() {
  const res = await fetch('/api/health')
  if (!res.ok) throw new Error('health failed')
  return res.json()
}

async function post(path, payload) {
  if (!clientGate) {
    const err = new Error('client-gate')
    err.code = 'client-gate'
    throw err
  }
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

export function rewriteText(instruction, text) {
  return post('/api/rewrite', { instruction, text })
}

export function inpaintImage({ prompt, imageDataUrl, maskDataUrl }) {
  return post('/api/inpaint', { prompt, imageDataUrl, maskDataUrl })
}

export function segmentImage({ imageDataUrl, box, points }) {
  return post('/api/sam', { imageDataUrl, box, points })
}
