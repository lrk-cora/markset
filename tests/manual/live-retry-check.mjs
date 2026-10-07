// Explicit live verification: one model plan and one shared image-generation job.
// Not part of npm test. Uses only synthetic input, never the user's imported page.
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '@playwright/test'

const base = 'http://127.0.0.1:5173'
const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date()).replace(/[^\d]/g, '')
const outputDir = path.resolve('test-results', `retry-verification-${stamp}`)
await mkdir(outputDir, { recursive: true })
const health = await fetch(`${base}/api/health`).then((response) => response.json())
const report = { startedAt: new Date().toISOString(), retryPolicy: health.retryPolicy, cases: [] }
const persist = () => writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2))
const post = async (route, payload, id, timeoutMs) => {
  const response = await fetch(`${base}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(id ? { 'Idempotency-Key': id } : {}) },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
  })
  return { status: response.status, data: await response.json() }
}
console.log(JSON.stringify({ event: 'start', outputDir, retryPolicy: health.retryPolicy }))
await Promise.all([
  (async () => {
    const start = Date.now()
    const result = { id: 'model-plan' }
    try {
      const response = await post('/api/brush-intent', {
        targets: [{ webId: 'test-heading', kind: 'text', text: 'Demo heading', screenRect: { x: 40, y: 40, w: 260, h: 50 } }],
        strokes: [], pageText: 'Demo heading', userInstruction: '把标题文字颜色改成红色，不修改文字内容。',
      }, null, health.retryPolicy.analysis.timeoutMs + 5000)
      Object.assign(result, { status: response.status, code: response.data.code || '', intentType: response.data.intent?.type || '', ok: response.status === 200 && response.data.intent?.type === 'color', requestId: response.data.requestId || '' })
    } catch (error) { Object.assign(result, { ok: false, code: error.name, error: error.message }) }
    result.elapsedMs = Date.now() - start
    report.cases.push(result)
    await persist()
    console.log(JSON.stringify({ event: 'result', ...result }))
  })(),
  (async () => {
    const id = randomUUID(), start = Date.now()
    const result = { id: 'image-shared-job', requestId: id }
    try {
      const payload = { prompt: 'A product photograph of exactly one white ceramic coffee mug on a plain pale sage-green background, handle pointing right, centered and fully visible, soft natural light. No text, logos, extra objects or watermark.', width: 600, height: 600 }
      const responses = await Promise.all([post('/api/generate-image', payload, id, 130_000), post('/api/generate-image', payload, id, 130_000)])
      result.elapsedMs = Date.now() - start
      result.statuses = responses.map((response) => response.status)
      result.sameResult = JSON.stringify(responses[0].data) === JSON.stringify(responses[1].data)
      const replayStarted = Date.now()
      const replay = await post('/api/generate-image', payload, id, 5000)
      result.cachedReplayMs = Date.now() - replayStarted
      result.replayMatches = JSON.stringify(replay.data) === JSON.stringify(responses[0].data)
      result.retriesUsed = responses[0].data.retriesUsed
      result.code = responses[0].data.code || ''
      result.ambiguous = Boolean(responses[0].data.ambiguous)
      result.ok = responses.every((response) => response.status === 200) && result.sameResult && result.replayMatches
      if (result.ok) {
        const imageUrl = responses[0].data.imageUrl
        const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/s.exec(imageUrl)
        if (!match) throw new Error('Invalid generated image result')
        const bytes = Buffer.from(match[2], 'base64')
        result.imagePath = path.join(outputDir, `generated.${match[1] === 'jpeg' ? 'jpg' : match[1]}`)
        result.sha256 = createHash('sha256').update(bytes).digest('hex')
        await writeFile(result.imagePath, bytes)
        const browser = await chromium.launch({ channel: 'chrome', headless: true })
        try {
          const page = await browser.newPage()
          Object.assign(result, await page.evaluate(async (url) => { const image = new Image(); image.src = url; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight } }, imageUrl))
        } finally { await browser.close() }
      }
    } catch (error) { Object.assign(result, { ok: false, code: error.name, error: error.message }) }
    result.elapsedMs = Date.now() - start
    report.cases.push(result)
    await persist()
    console.log(JSON.stringify({ event: 'result', ...result }))
  })(),
])
report.finishedAt = new Date().toISOString()
await persist()
console.log(JSON.stringify({ event: 'complete', reportPath: path.join(outputDir, 'report.json'), allPassed: report.cases.every((result) => result.ok) }))
