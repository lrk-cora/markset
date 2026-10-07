import { test, expect } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'

// Native sandbox errors are CDP Log entries, not JS exceptions. Listening only
// to pageerror or console.error misses the error shown in the user's DevTools.
async function observe(page, testInfo) {
  const entries = []
  const exceptions = []
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Log.enable')
  cdp.on('Log.entryAdded', ({ entry }) => entries.push(entry))
  page.on('pageerror', (error) => exceptions.push(error.message))
  // Tests use local documents only; never invoke paid model/image endpoints or
  // proxy external assets. This does not suppress browser security logs.
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.hostname !== 'localhost') return route.abort()
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 })
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/import-page') return route.abort()
    return route.continue()
  })
  const sandboxErrors = () => entries.filter((entry) => /Blocked script execution.*sandboxed/u.test(entry.text))
  return {
    sandboxErrors,
    async check() {
      // Include queued load/error events and animation frames after mounting.
      await page.waitForTimeout(300)
      await testInfo.attach('native-browser-errors', {
        body: JSON.stringify({ sandboxErrors: sandboxErrors(), exceptions }, null, 2),
        contentType: 'application/json',
      })
      expect(sandboxErrors()).toEqual([])
      expect(exceptions).toEqual([])
      await expect(page.locator('#web-doc-frame')).toHaveAttribute('sandbox', 'allow-same-origin')
    },
  }
}

async function restore(page, html) {
  await page.goto('/')
  await page.evaluate(async (snapshotHtml) => {
    const { createImportedPageCache } = await import('/src/imported-page-cache.js')
    await createImportedPageCache().save({ title: 'Browser regression fixture', snapshotHtml })
  }, html)
  await page.reload()
  await expect(page.locator('.page.is-web-doc')).toBeVisible()
  await expect(page.locator('#toast')).toContainText('已恢复')
}

test('fresh startup and reload do not attempt sandboxed script execution', async ({ page }, testInfo) => {
  const logs = await observe(page, testInfo)
  await page.goto('/')
  await expect(page.locator('#btn-import-html')).toBeVisible()
  await page.reload()
  await logs.check()
})

const samplesDir = new URL('../../samples/', import.meta.url)
for (const name of readdirSync(samplesDir).filter((name) => name.endsWith('.html'))) {
  test(`cached sample restores without sandbox errors: ${name}`, async ({ page }, testInfo) => {
    const logs = await observe(page, testInfo)
    await restore(page, readFileSync(new URL(name, samplesDir), 'utf8'))
    await logs.check()
  })
}

test('legacy executable markup is stripped before mounting, but DOM edits and undo still work', async ({ page }, testInfo) => {
  const logs = await observe(page, testInfo)
  await restore(page, '<!doctype html><html><head><script>window.__unsafeExecuted=true</script></head><body onload="window.__unsafeExecuted=true"><h1 id="heading">保留标题</h1><p>保留相邻段落</p><svg><script>window.__unsafeExecuted=true</script></svg><iframe srcdoc="test"></iframe></body></html>')
  const result = await page.evaluate(async () => {
    const web = await import('/src/web-doc.js')
    const doc = document.getElementById('web-doc-frame').contentDocument
    const title = doc.getElementById('heading')
    const target = { webId: title.getAttribute('data-markset-id'), kind: 'text' }
    const original = doc.body.innerHTML
    const removed = web.applyBrushDelete([target])
    const titleGone = !doc.getElementById('heading')
    web.undoWebEditsSince()
    const restored = doc.body.innerHTML === original
    web.restoreWebHtml(web.snapshotWebHtml())
    return {
      removed: removed.ok, titleGone, restored,
      runnableNodes: doc.querySelectorAll('script,iframe,[onload]').length,
      executed: Boolean(doc.defaultView.__unsafeExecuted),
    }
  })
  expect(result).toEqual({ removed: true, titleGone: true, restored: true, runnableNodes: 0, executed: false })
  await logs.check()
})

test('positive control: the logger captures the exact native sandbox error and the script cannot run', async ({ page }, testInfo) => {
  const logs = await observe(page, testInfo)
  await page.goto('/')
  await page.evaluate(() => {
    const doc = document.getElementById('web-doc-frame').contentDocument
    const script = doc.createElement('script')
    script.textContent = 'window.__unsafeExecuted=true'
    doc.body.append(script)
  })
  await expect.poll(() => logs.sandboxErrors().length).toBe(1)
  expect(logs.sandboxErrors()[0].source).toBe('security')
  expect(await page.locator('#web-doc-frame').evaluate((frame) => Boolean(frame.contentWindow.__unsafeExecuted))).toBe(false)
})

// Reproduce a user-reported document without copying it into the repository or
// reading the user's browser profile. Uses the real file picker/API/cache path.
const diagnosticFile = process.env.MARKSET_DIAGNOSTIC_HTML
test('reported HTML: import through the UI, refresh, capture, and edit/undo', async ({ page }, testInfo) => {
  test.skip(!diagnosticFile, 'Set MARKSET_DIAGNOSTIC_HTML to the reported local HTML file')
  const logs = await observe(page, testInfo)
  await page.goto('/')
  const picker = page.waitForEvent('filechooser')
  await page.locator('#btn-import-html').click()
  await (await picker).setFiles(diagnosticFile)
  await expect(page.locator('#toast')).toContainText('已导入')
  await page.reload()
  await expect(page.locator('#toast')).toContainText('已恢复')
  const result = await page.evaluate(async () => {
    const { captureAnnotationScene } = await import('/src/capture.js')
    const web = await import('/src/web-doc.js')
    const capture = await captureAnnotationScene()
    const doc = document.getElementById('web-doc-frame').contentDocument
    const heading = doc.querySelector('h1')
    const original = doc.body.innerHTML
    const removed = web.applyBrushDelete([{ webId: heading.getAttribute('data-markset-id'), kind: 'text' }])
    const gone = !doc.querySelector('h1')
    web.undoWebEditsSince()
    return { captured: Boolean(capture.combinedDataUrl), removed: removed.ok, gone, restored: doc.body.innerHTML === original }
  })
  expect(result).toEqual({ captured: true, removed: true, gone: true, restored: true })
  await logs.check()
})
