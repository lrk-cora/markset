// Explicit, paid integration check of Markset's configured image backend.
// Not included in npm test; run against an already-running local service.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from '@playwright/test'

const baseUrl = 'http://127.0.0.1:5173'
const stamp = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium',
}).format(new Date()).replace(/[^\d]/g, '')
const outputDir = path.resolve('test-results', `image-stability-${stamp}`)
await mkdir(outputDir, { recursive: true })
const health = await fetch(`${baseUrl}/api/health`).then((res) => res.json())
if (!health.allowCalls || !health.imageGeneration) throw new Error('Image backend is not enabled/configured')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage()
const prompt = 'A product photograph of exactly one white ceramic coffee mug on a plain pale sage-green background. The handle points to the right. Soft daylight from the left, subtle shadow, mug centered and fully visible, generous empty space. No writing, logos, watermark, coffee beans, plants, or extra objects.'
const scenarios = [
  ...[1, 2, 3].map((n) => ({ id: `repeat-${n}`, label: `相同提示词，第 ${n} 次`, payload: { prompt, width: 600, height: 600 } })),
  { id: 'landscape-context', label: '横向配图＋网页上下文', payload: {
    prompt: '为这块网页生成一张极简咖啡产品摄影配图：只要一只白色陶瓷咖啡杯，杯柄朝右，淡鼠尾草绿背景，主体放在画面右半边，左边留白，不要任何文字、标志或额外物品。',
    pageContext: '精品咖啡品牌介绍页。白色和淡绿色配色，简洁自然，展示一款白色陶瓷咖啡杯。图片左侧需要留白，用于网页自己叠加文字。',
    width: 900, height: 500,
  } },
]
const report = {
  startedAt: new Date().toISOString(), configuredModel: health.imageModel,
  sampleSize: scenarios.length, scope: 'Live API calls only; no changes to the user page',
  cases: [],
}
const persist = () => writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ event: 'start', outputDir, configuredModel: health.imageModel, samples: scenarios.length }))
try {
  for (const scenario of scenarios) {
    if (report.cases.some((result) => [401, 403, 429].includes(result.status))) {
      report.cases.push({ id: scenario.id, label: scenario.label, skipped: true, reason: 'Stopped after authentication/rate-limit failure' })
      await persist()
      continue
    }
    if (scenario.id === 'landscape-context' && !report.cases.some((result) => result.ok)) {
      report.cases.push({ id: scenario.id, label: scenario.label, skipped: true, reason: 'No baseline image succeeded' })
      await persist()
      continue
    }
    const start = Date.now()
    const result = { id: scenario.id, label: scenario.label, prompt: scenario.payload.prompt, requestedWidth: scenario.payload.width, requestedHeight: scenario.payload.height }
    console.log(JSON.stringify({ event: 'request', id: result.id }))
    const progress = setInterval(() => console.log(JSON.stringify({ event: 'waiting', id: result.id, elapsedSeconds: Math.round((Date.now() - start) / 1000) })), 30_000)
    try {
      const response = await fetch(`${baseUrl}/api/generate-image`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MarkSet-Call': '1' },
        body: JSON.stringify(scenario.payload), signal: AbortSignal.timeout(150_000),
      })
      result.status = response.status
      const data = await response.json().catch(() => ({}))
      result.apiElapsedMs = Date.now() - start
      result.model = data.model || ''
      if (!response.ok) {
        result.ok = false
        result.code = data.code || `http_${response.status}`
        result.error = String(data.error || 'Generation failed').slice(0, 240)
      } else {
        const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(data.imageUrl || '')
        if (!match) throw new Error('API did not return a self-contained supported image')
        const bytes = Buffer.from(match[2], 'base64')
        const extension = match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1]
        result.imagePath = path.join(outputDir, `${scenario.id}.${extension}`)
        result.bytes = bytes.length
        result.sha256 = createHash('sha256').update(bytes).digest('hex')
        await writeFile(result.imagePath, bytes)
        // Browser decode catches truncated/invalid images rather than trusting HTTP 200.
        const decoded = await page.evaluate(async (url) => {
          const image = new Image()
          image.src = url
          await image.decode()
          return { width: image.naturalWidth, height: image.naturalHeight }
        }, data.imageUrl)
        result.width = decoded.width
        result.height = decoded.height
        const ratio = decoded.width / decoded.height
        result.expectedOrientation = scenario.id === 'landscape-context' ? 'landscape' : 'square'
        result.orientationMatches = result.expectedOrientation === 'landscape' ? ratio > 1.2 : Math.abs(ratio - 1) < 0.05
        result.ok = decoded.width > 0 && decoded.height > 0 && result.model === health.imageModel && result.orientationMatches
        if (!result.ok) result.code = 'image_validation_failed'
      }
    } catch (error) {
      result.ok = false
      result.code = error.name === 'TimeoutError' ? 'client_deadline' : error.name
      result.error = String(error.message || 'Request failed').slice(0, 240)
    } finally {
      clearInterval(progress)
      result.elapsedMs = Date.now() - start
      report.cases.push(result)
      await persist()
      console.log(JSON.stringify({ event: 'result', ...result, prompt: undefined }))
    }
  }
} finally {
  await browser.close()
  const attempted = report.cases.filter((result) => !result.skipped)
  const successful = attempted.filter((result) => result.ok)
  const times = successful.map((result) => result.apiElapsedMs).sort((a, b) => a - b)
  report.finishedAt = new Date().toISOString()
  report.summary = {
    attempted: attempted.length, successful: successful.length, skipped: report.cases.filter((result) => result.skipped).length,
    successRate: attempted.length ? successful.length / attempted.length : null,
    minSuccessMs: times[0] ?? null, maxSuccessMs: times.at(-1) ?? null,
    meanSuccessMs: times.length ? Math.round(times.reduce((sum, value) => sum + value, 0) / times.length) : null,
    uniqueImages: new Set(successful.map((result) => result.sha256)).size,
    limitation: 'Small operational sample; cannot establish long-term reliability or prove semantic image quality.',
  }
  await persist()
  console.log(JSON.stringify({ event: 'complete', reportPath: path.join(outputDir, 'report.json'), ...report.summary }))
}
