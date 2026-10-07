import test from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { copyImportedPage, createImportedPageCache } from '../src/imported-page-cache.js'

const page = (title = '示例') => ({ title, snapshotHtml: `<html><body><h1>${title}</h1></body></html>` })
function setup() {
  const indexedDB = new IDBFactory()
  const createCache = () => createImportedPageCache({ getIndexedDB: () => indexedDB })
  return { indexedDB, createCache, cache: createCache() }
}
async function writeRaw(indexedDB, record) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('markset-imported-page', 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise((resolve, reject) => {
    const tx = database.transaction('pages', 'readwrite')
    tx.objectStore('pages').put(record, 'latest')
    tx.oncomplete = resolve
    tx.onabort = () => reject(tx.error)
  })
  database.close()
}

test('empty storage is harmless; a new cache instance restores the last successful original', async () => {
  const { cache, createCache } = setup()
  assert.equal(await cache.load(), null)
  await cache.save(page('A'))
  await cache.save(page('B'))
  assert.deepEqual(await createCache().load(), copyImportedPage(page('B')))
})

test('captures an isolated import including embedded assets, never history, ink or preferences', async () => {
  const { cache, createCache } = setup()
  const imported = {
    ...page(), sourceUrl: 'https://example.com/page', siteName: '站点',
    snapshotHtml: '<style>h1{color:red}</style><img src="data:image/png;base64,AAAA"><h1>原始标题</h1>',
    blocks: [{ type: 'heading', text: '原始标题' }, { type: 'image', src: 'data:image/png;base64,AAAA', alt: '图片' }],
    history: [{ label: '已修改' }], group: { strokes: [] }, preferences: { recording: true },
  }
  const expected = copyImportedPage(imported)
  const saving = cache.save(imported)
  imported.snapshotHtml = '<h1>修改后的标题</h1>'
  imported.blocks[0].text = '修改后的标题'
  await saving
  const restored = await createCache().load()
  assert.deepEqual(restored, expected)
  for (const key of ['history', 'group', 'preferences']) assert.equal(key in restored, false)
  restored.blocks[0].text = '又一次修改'
  assert.equal((await cache.load()).blocks[0].text, '原始标题')
})

test('stores a page beyond localStorage-sized payloads without using localStorage', async () => {
  const { cache, createCache } = setup()
  const original = { ...page(), snapshotHtml: `<img src="data:image/png;base64,${'A'.repeat(6_000_000)}">` }
  await cache.save(original)
  assert.equal((await createCache().load()).snapshotHtml, original.snapshotHtml)
})

test('also roundtrips block and screenshot imports', async () => {
  const { cache } = setup()
  for (const original of [
    { title: 'Blocks', blocks: [{ type: 'heading', text: '标题' }, { type: 'image', src: '/image.jpg', width: 300, height: 200 }] },
    { title: 'Screenshot', screenshotDataUrl: 'data:image/png;base64,AAAA' },
  ]) {
    await cache.save(original)
    assert.deepEqual(await cache.load(), copyImportedPage(original))
  }
})

test('invalid or unsupported saved records do not prevent a later valid import', async () => {
  const { cache, indexedDB } = setup()
  await cache.load()
  for (const record of [null, { version: 99, page: page() }, { version: 1, page: {} }, { version: 1, page: { snapshotHtml: 3 } }]) {
    await writeRaw(indexedDB, record)
    assert.equal(await cache.load(), null)
  }
  assert.throws(() => cache.save({ blocks: [null, {}] }), /网页内容/)
  await cache.save(page('恢复'))
  assert.equal((await cache.load()).title, '恢复')
})

test('save does not report success before transaction commit, and an abort retains the previous import', async (t) => {
  const { cache } = setup()
  await cache.save(page('原始'))
  const realPut = IDBObjectStore.prototype.put
  const mocked = t.mock.method(IDBObjectStore.prototype, 'put', function (...args) {
    const request = realPut.apply(this, args)
    request.addEventListener('success', () => this.transaction.abort())
    return request
  })
  await assert.rejects(cache.save(page('不能提交')), /取消|abort/i)
  mocked.mock.restore()
  assert.equal((await cache.load()).title, '原始')
  await cache.save(page('恢复写入'))
  assert.equal((await cache.load()).title, '恢复写入')
})

test('quota failure rejects saving without destroying the older import or poisoning the write queue', async (t) => {
  const { cache } = setup()
  await cache.save(page('原始'))
  const mocked = t.mock.method(IDBObjectStore.prototype, 'put', () => { throw new DOMException('Full', 'QuotaExceededError') })
  await assert.rejects(cache.save(page('过大')), { name: 'QuotaExceededError' })
  mocked.mock.restore()
  assert.equal((await cache.load()).title, '原始')
  await Promise.all([cache.save(page('B')), cache.save(page('C')), cache.save(page('D'))])
  assert.equal((await cache.load()).title, 'D')
})

test('storage unavailable or forbidden does not hang startup and saving fails explicitly', async () => {
  const unavailable = createImportedPageCache({ getIndexedDB: () => undefined })
  assert.equal(await unavailable.load(), null)
  await assert.rejects(unavailable.save(page()), /未允许/)
  const forbidden = createImportedPageCache({ getIndexedDB: () => { throw new DOMException('Denied', 'SecurityError') } })
  await assert.rejects(forbidden.load(), { name: 'SecurityError' })
  await assert.rejects(forbidden.save(page()), { name: 'SecurityError' })
})

test('blocked storage reports failure instead of waiting forever', async () => {
  const cache = createImportedPageCache({ getIndexedDB: () => ({
    open: () => {
      const request = {}
      queueMicrotask(() => request.onblocked())
      return request
    },
  }) })
  await assert.rejects(cache.load(), /占用/)
})

test('a hung database open times out; late success closes its connection without writing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let request, closed = 0
  const cache = createImportedPageCache({ getIndexedDB: () => ({ open: () => (request = {}) }), timeoutMs: 100 })
  const loading = assert.rejects(cache.load(), /超时/)
  await Promise.resolve()
  t.mock.timers.tick(101)
  await loading
  request.result = { close: () => closed++, transaction: () => assert.fail('late database access') }
  request.onsuccess()
  assert.equal(closed, 1)
})
