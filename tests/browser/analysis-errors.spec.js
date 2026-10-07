import { test, expect } from '@playwright/test'

async function openMarkedPage(page) {
  await page.goto('/')
  await page.evaluate(async () => {
    const { createImportedPageCache } = await import('/src/imported-page-cache.js')
    await createImportedPageCache().save({ title: 'Failure UI fixture', snapshotHtml: '<!doctype html><html><head><style>body{margin:40px;height:650px}h1{display:inline-block;font:40px system-ui;margin:30px 0;color:#182033}</style></head><body><h1>保留这个标题</h1><p>这段内容不要修改。</p></body></html>' })
  })
  await page.reload()
  await expect(page.locator('#toast')).toContainText('已恢复')
  await page.locator('#btn-brush').click()
  const rect = await page.frameLocator('#web-doc-frame').locator('h1').boundingBox()
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2
  const rx = rect.width / 2 + 12, ry = rect.height / 2 + 12
  await page.mouse.move(cx + rx, cy)
  await page.mouse.down()
  for (let i = 1; i <= 60; i++) await page.mouse.move(cx + rx * Math.cos(i * Math.PI / 30), cy + ry * Math.sin(i * Math.PI / 30))
  await page.mouse.up()
}

test('502 is visible; ink and correction survive; retry does not apply; offline color still works', async ({ page }, testInfo) => {
  const requests = []
  let recover = false
  await page.route('**/api/brush-intent', async (route) => {
    const payload = route.request().postDataJSON()
    requests.push(payload)
    if (!recover) return route.fulfill({ status: 502, json: { code: 'model_gateway_upstream', error: 'test upstream error', requestId: 'browser-502-test' } })
    return route.fulfill({ json: { model: 'test', intent: {
      type: 'note', confidence: 0.8, needsClarification: true, clarifyingQuestion: '调整颜色还是间距？',
      targets: payload.targets, suggestion: { text: '请选择调整方向', alternatives: ['调整颜色', '调整间距'] },
    } } })
  })
  await openMarkedPage(page)
  await expect(page.locator('#inline-error-message')).toBeVisible({ timeout: 12_000 })
  await expect(page.locator('#inline-error-message')).toContainText('502')
  await expect(page.locator('#inline-proposal-kind')).toHaveText('AI 未完成 · 本地方案')
  await expect(page.locator('#btn-inline-retry')).toBeVisible()
  const ink = await page.locator('#paint-layer').innerHTML()
  expect(ink).toContain('polyline')
  const frame = page.frameLocator('#web-doc-frame')
  await page.locator('#inline-custom-intent-input').fill('这个区域看起来柔和一点')
  await page.locator('#btn-inline-primary').click()
  await expect.poll(() => requests.length).toBe(2)
  await expect(page.locator('#inline-error-message')).toBeVisible()
  await expect(page.locator('#inline-custom-intent-input')).toHaveValue('这个区域看起来柔和一点')
  await expect(frame.locator('h1')).toHaveText('保留这个标题')
  expect(await page.locator('#paint-layer').innerHTML()).toBe(ink)
  const screenshot = testInfo.outputPath('visible-502-feedback.png')
  await page.screenshot({ path: screenshot })
  await testInfo.attach('visible-502-feedback', { path: screenshot, contentType: 'image/png' })

  recover = true
  await page.locator('#inline-custom-intent-input').fill('保留文字，只调整视觉风格')
  await page.locator('#btn-inline-retry').click()
  await expect.poll(() => requests.length).toBe(3)
  expect(requests[2].userInstruction).toContain('保留文字，只调整视觉风格')
  await expect(page.locator('#inline-error-message')).toBeHidden()
  await expect(page.locator('#btn-inline-retry')).toBeHidden()
  await expect(frame.locator('h1')).toHaveText('保留这个标题')
  expect(await page.locator('#paint-layer').innerHTML()).toBe(ink)
  await page.locator('#inline-custom-intent-input').fill('改成红色')
  await page.locator('#btn-inline-primary').click()
  await expect(page.locator('#inline-proposal')).toBeHidden()
  await expect(frame.locator('h1')).not.toHaveCSS('color', 'rgb(24, 32, 51)')
  expect(requests.length).toBe(3)
})

test('a non-JSON 502 proxy response still gives a helpful visible failure', async ({ page }) => {
  await page.route('**/api/brush-intent', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad Gateway</h1>' }))
  await openMarkedPage(page)
  await expect(page.locator('#inline-error-message')).toContainText('502', { timeout: 12_000 })
  await expect(page.locator('#inline-error-message')).not.toContainText('<h1>')
  await expect(page.locator('#btn-inline-retry')).toBeEnabled()
})

test('favicon is declared and loads without the previous missing-icon request', async ({ page }) => {
  const failures = []
  page.on('response', (response) => { if (/favicon/u.test(response.url()) && !response.ok()) failures.push(response.status()) })
  await page.goto('/')
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.svg')
  expect((await page.request.get('/favicon.svg')).status()).toBe(200)
  expect(failures).toEqual([])
})

test('a model response beyond the old 14s cutoff is retained without losing ink or applying edits', async ({ page }) => {
  let notifyStarted
  const started = new Promise((resolve) => { notifyStarted = resolve })
  await page.route('**/api/brush-intent', async (route) => {
    const payload = route.request().postDataJSON()
    notifyStarted()
    await new Promise((resolve) => setTimeout(resolve, 15_200))
    await route.fulfill({ json: { model: 'test', intent: {
      type: 'note', confidence: 0.52, targets: payload.targets,
      needsInput: false, needsClarification: true, clarifyingQuestion: '希望调整颜色还是间距？',
      suggestion: { text: '请选择调整方向', alternatives: ['调整颜色', '调整间距'] },
    } } })
  })
  await openMarkedPage(page)
  await started
  const ink = await page.locator('#paint-layer').innerHTML()
  await page.waitForTimeout(14_300)
  await expect(page.locator('#inline-error-message')).toBeHidden()
  expect(await page.locator('#paint-layer').innerHTML()).toBe(ink)
  await expect(page.locator('#inline-proposal-text')).toHaveText('希望调整颜色还是间距？', { timeout: 8000 })
  await expect(page.locator('#inline-error-message')).toBeHidden()
  await expect(page.frameLocator('#web-doc-frame').locator('h1')).toHaveCSS('color', 'rgb(24, 32, 51)')
  expect(await page.locator('#paint-layer').innerHTML()).toBe(ink)
})

test('browser image calls share an in-flight request and supply a stable operation id', async ({ page }) => {
  const ids = []
  await page.route('**/api/generate-image', async (route) => {
    ids.push(route.request().headers()['idempotency-key'])
    await new Promise((resolve) => setTimeout(resolve, 20))
    await route.fulfill({ json: { imageUrl: 'data:image/png;base64,test', requestId: ids.at(-1) } })
  })
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { generateImage } = await import('/src/api.js')
    const first = generateImage({ prompt: 'A test mug' })
    const second = generateImage({ prompt: 'A test mug' })
    const shared = first === second
    await Promise.all([first, second])
    await generateImage({ prompt: 'A test mug' })
    return { shared }
  })
  expect(result.shared).toBe(true)
  expect(ids).toHaveLength(2)
  expect(ids[0]).toMatch(/^[\w-]{36}$/u)
  expect(ids[0]).not.toBe(ids[1])
})
