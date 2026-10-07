import test from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory } from 'fake-indexeddb'
import { createImportedPageCache } from '../src/imported-page-cache.js'
import { createImportedPageSession } from '../src/imported-page-session.js'

const page = (title) => ({ title, snapshotHtml: `<h1>${title}</h1>` })
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
function setup(overrides = {}) {
  const indexedDB = new IDBFactory()
  const cache = createImportedPageCache({ getIndexedDB: () => indexedDB })
  const mounted = [], imported = []
  const options = {
    cache,
    importPage: async (payload) => { imported.push(payload); return payload },
    mountPage: async (prepared) => { mounted.push(prepared); return 'html' },
    ...overrides,
  }
  return { cache, mounted, imported, options, session: createImportedPageSession(options) }
}

test('reload restores the prepared original without reupload, model calls, or persisting live edits', async () => {
  const { session, options, mounted, imported } = setup()
  assert.equal(await session.restore(), null)
  const result = await session.load(page('原始网页'))
  assert.equal(result.storageError, null)
  mounted[0].snapshotHtml = '<h1>在当前页修改的内容</h1>'
  const refreshed = createImportedPageSession(options)
  assert.equal((await refreshed.restore()).page.title, '原始网页')
  assert.equal(mounted[1].snapshotHtml, '<h1>原始网页</h1>')
  assert.equal(imported.length, 1)
})

test('a delayed startup read cannot replace a user-chosen new file, even during file reading', async () => {
  const reading = deferred()
  const mounted = [], saved = []
  const { session } = setup({
    cache: { load: () => reading.promise, save: async (prepared) => saved.push(prepared) },
    mountPage: async (prepared) => mounted.push(prepared.title),
  })
  const restoring = session.restore()
  const ticket = session.beginImport()
  reading.resolve(page('上次的网页'))
  assert.equal(await restoring, null)
  assert.deepEqual(mounted, [])
  await session.load(page('新网页'), ticket)
  assert.deepEqual(mounted, ['新网页'])
  assert.equal(saved[0].title, '新网页')
})

test('out-of-order import responses cannot overwrite the newer successful document', async () => {
  const slow = deferred()
  const { session, mounted, cache } = setup({ importPage: (payload) => payload.title === 'A' ? slow.promise : payload })
  const first = session.load(page('A'))
  await session.load(page('B'))
  slow.resolve(page('A'))
  assert.equal(await first, null)
  assert.deepEqual(mounted.map((item) => item.title), ['B'])
  assert.equal((await cache.load()).title, 'B')
})

test('serializes asynchronous mounts so an old mount cannot finish on top of the newest page', async () => {
  const mounting = deferred(), entered = deferred()
  const finished = []
  const { session, cache } = setup({ mountPage: async (prepared) => {
    if (prepared.title === 'A') { entered.resolve(); await mounting.promise }
    finished.push(prepared.title)
    return 'html'
  } })
  const first = session.load(page('A'))
  await entered.promise
  const next = session.load(page('B'))
  mounting.resolve()
  assert.equal(await first, null)
  assert.equal((await next).page.title, 'B')
  assert.deepEqual(finished, ['A', 'B'])
  assert.equal((await cache.load()).title, 'B')
})

test('a failed or empty import never resets the displayed page or replaces its backup', async () => {
  const { options, session, mounted, cache } = setup()
  await session.load(page('原始'))
  const failed = createImportedPageSession({ ...options, importPage: async () => { throw new Error('Server unavailable') } })
  await assert.rejects(failed.load({ html: '失败' }), /Server unavailable/)
  const empty = createImportedPageSession({ ...options, importPage: async () => ({}) })
  await assert.rejects(empty.load({ html: '' }), /网页内容/)
  assert.equal(mounted.length, 1)
  assert.equal((await cache.load()).title, '原始')
})

test('an unsuccessful mount is not remembered and does not break the next import', async () => {
  const { session, cache } = setup({ mountPage: async (prepared) => {
    if (prepared.title === 'bad') throw new Error('Mount failed')
    return 'html'
  } })
  await session.load(page('原始'))
  await assert.rejects(session.load(page('bad')), /Mount failed/)
  assert.equal((await cache.load()).title, '原始')
  await session.load(page('下次'))
  assert.equal((await cache.load()).title, '下次')
})

test('storage failure is a warning after a usable import, not an import failure', async () => {
  const { session, mounted } = setup({ cache: { save: async () => { throw new Error('Quota exceeded') } } })
  const result = await session.load(page('可继续修改'))
  assert.equal(result.page.title, '可继续修改')
  assert.match(result.storageError.message, /Quota exceeded/)
  assert.equal(mounted.length, 1)
})

test('no side effects from an obsolete file read or failed old import', async () => {
  const slow = deferred()
  const { session, imported, mounted } = setup()
  const stale = session.beginImport()
  const current = session.beginImport()
  assert.equal(await session.load(page('旧文件'), stale), null)
  assert.equal(imported.length, 0)
  await session.load(page('最新文件'), current)
  assert.equal(mounted.length, 1)
  const another = setup({ importPage: () => slow.promise }).session
  const old = another.load({})
  another.beginImport()
  slow.reject(new Error('Obsolete failure'))
  assert.equal(await old, null)
})
