import { readEventStream } from './event-stream.js'
import { modelTimeoutMetadata } from './model-diagnostics.js'

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

async function post(path, payload, { headers = {}, signal } = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { ...CALL_HEADER, ...headers },
    body: JSON.stringify(payload),
    signal,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data?.error || `http ${res.status}`)
    err.code = data?.code || String(res.status)
    err.status = res.status
    err.requestId = data?.requestId || res.headers.get('X-Request-Id') || ''
    err.ambiguous = Boolean(data?.ambiguous)
    err.taskId = data?.taskId || ''
    throw err
  }
  return data
}

export function rewriteText(instruction, text, extra = {}) {
  return post('/api/rewrite', { instruction, text, ...extra })
}

export function inpaintImage(payload, { requestId = crypto.randomUUID() } = {}) {
  return post('/api/inpaint', payload, { headers: { 'Idempotency-Key': requestId } })
}

const imageRequests = new Map()

export function generateImage({
  prompt,
  mode,
  quality,
  imageDataUrl,
  width,
  height,
  replaceExisting,
  contextImageDataUrls,
  pageContext,
}, { requestId } = {}) {
  const payload = {
    prompt,
    mode,
    quality,
    imageDataUrl,
    width,
    height,
    replaceExisting: Boolean(replaceExisting),
    contextImageDataUrls: contextImageDataUrls || [],
    pageContext: pageContext || '',
  }
  const key = `${requestId || ''}:${JSON.stringify(payload)}`
  if (imageRequests.has(key)) return imageRequests.get(key)
  const id = requestId || crypto.randomUUID()
  const promise = post('/api/generate-image', payload, { headers: { 'Idempotency-Key': id } })
    .finally(() => { if (imageRequests.get(key) === promise) imageRequests.delete(key) })
  imageRequests.set(key, promise)
  return promise
}

export function segmentImage({ imageDataUrl, box, points }) {
  return post('/api/sam', { imageDataUrl, box, points })
}

export function planOps(payload) {
  return post('/api/plan', payload)
}

export async function planBrushIntent(payload, { signal, onProgress } = {}) {
  const res = await fetch('/api/brush-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(onProgress ? { Accept: 'text/event-stream' } : {}) },
    body: JSON.stringify(payload || {}),
    signal,
  })
  let data, streamError = false
  if (res.ok && res.headers.get('content-type')?.includes('text/event-stream')) {
    let terminal = false
    try {
      await readEventStream(res.body, ({ event, data: raw }) => {
        if (terminal) return
        const value = JSON.parse(raw)
        if (event === 'progress') {
          if (['planning','observe','repair','retry','draft'].includes(value.stage)) onProgress?.({
            stage:value.stage, draftSummary:typeof value.draftSummary === 'string' ? value.draftSummary.slice(0,180) : '',
            retry:Math.min(2,Math.max(0,Number(value.retry) || 0)),
          })
        } else if (event === 'result' || event === 'error') { data=value; streamError=event==='error'; terminal=true }
      }, { signal })
      if (!terminal) throw new Error('incomplete-event-stream')
    } catch (error) {
      signal?.throwIfAborted()
      throw Object.assign(new Error('分析连接中断，笔迹和输入已保留'), { code:'model_gateway_unreachable', status:502 })
    }
  } else data = await res.json().catch(() => ({}))
  if (!res.ok || streamError) {
    const err = new Error(typeof data?.error === 'string' ? data.error : 'brush intent failed')
    err.code = data?.code || String(res.status)
    err.status = streamError ? Number(data.status) || 502 : res.status
    err.requestId = data?.requestId || res.headers.get('X-Request-Id') || ''
    err.model = data?.model || ''
    err.routing = data?.routing || null
    err.retriesUsed = Number(data?.retriesUsed) || 0
    err.elapsedMs = Number(data?.elapsedMs) || 0
    err.reason = String(data?.reason || '')
    err.repairsUsed = Number(data?.repairsUsed) || 0
    err.trace = Array.isArray(data?.trace) ? data.trace : []
    err.timings = data?.timings || null
    Object.assign(err, modelTimeoutMetadata(data))
    throw err
  }
  return data || {}
}

export async function checkModelStatus(target = 'all') {
  const signal = AbortSignal.timeout(12_000)
  return post('/api/model-status', { target }, { signal })
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

export function testAnalysisModel() { return post('/api/model-test', {}) }
