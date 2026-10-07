const DB_NAME = 'markset-imported-page'
const STORE_NAME = 'pages'
const RECORD_KEY = 'latest'
const RECORD_VERSION = 1

// Store only the prepared import, never the live iframe, strokes, or undo state.
// Taking a detached copy before mounting keeps edits out of the saved original.
export function copyImportedPage(page) {
  if (!page || typeof page !== 'object') throw new Error('没有可恢复的网页内容')
  const copy = {}
  for (const key of ['title', 'sourceUrl', 'siteName', 'snapshotHtml', 'screenshotDataUrl']) {
    copy[key] = typeof page[key] === 'string' ? page[key] : ''
  }
  copy.blocks = (Array.isArray(page.blocks) ? page.blocks : []).filter((block) =>
    block && typeof block === 'object' && (
      (block.type === 'image' && typeof block.src === 'string' && block.src.trim())
      || (typeof block.text === 'string' && block.text.trim())
    ),
  ).map((block) => {
    const next = {}
    for (const key of ['type', 'text', 'src', 'alt']) {
      if (typeof block[key] === 'string') next[key] = block[key]
    }
    for (const key of ['width', 'height']) {
      if (Number.isFinite(block[key])) next[key] = block[key]
    }
    return next
  })
  copy.warnings = Array.isArray(page.warnings) ? page.warnings.filter((item) => typeof item === 'string') : []
  if (!copy.snapshotHtml.trim() && !copy.blocks.length && !/^data:image\//i.test(copy.screenshotDataUrl)) {
    throw new Error('没有可恢复的网页内容')
  }
  return copy
}

export function createImportedPageCache({ getIndexedDB = () => globalThis.indexedDB, timeoutMs = 5000 } = {}) {
  // IndexedDB supports HTML with embedded images beyond localStorage's quota.
  // Serialize writes so a slow database open cannot overwrite a newer import.
  let writes = Promise.resolve()
  function transact(mode, operation) {
    return new Promise((resolve, reject) => {
      let database, transaction, result, settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        database?.close()
        if (error) reject(error)
        else resolve(result)
      }
      const timer = setTimeout(() => {
        try { transaction?.abort() } catch {}
        finish(new Error('本地网页存储超时'))
      }, timeoutMs)
      try {
        const factory = getIndexedDB()
        if (!factory) {
          result = null
          finish(mode === 'readonly' ? null : new Error('浏览器未允许本地网页存储'))
          return
        }
        const open = factory.open(DB_NAME, 1)
        open.onblocked = () => finish(new Error('本地网页存储被其他页面占用'))
        open.onerror = () => finish(open.error || new Error('无法打开本地网页存储'))
        open.onupgradeneeded = () => {
          if (settled) { open.transaction.abort(); return }
          if (!open.result.objectStoreNames.contains(STORE_NAME)) open.result.createObjectStore(STORE_NAME)
        }
        open.onsuccess = () => {
          database = open.result
          if (settled) { database.close(); return }
          database.onversionchange = () => database.close()
          try {
            transaction = database.transaction(STORE_NAME, mode)
            transaction.oncomplete = () => finish()
            transaction.onabort = () => finish(transaction.error || new Error('本地网页存储已取消'))
            transaction.onerror = () => finish(transaction.error || new Error('本地网页存储失败'))
            const request = operation(transaction.objectStore(STORE_NAME))
            request.onsuccess = () => { result = request.result }
            request.onerror = () => finish(request.error || new Error('本地网页存储失败'))
          } catch (error) {
            try { transaction?.abort() } catch {}
            finish(error)
          }
        }
      } catch (error) { finish(error) }
    })
  }
  return {
    async load() {
      await writes
      const record = await transact('readonly', (store) => store.get(RECORD_KEY))
      if (record?.version !== RECORD_VERSION) return null
      try { return copyImportedPage(record.page) } catch { return null }
    },
    save(page) {
      const record = { version: RECORD_VERSION, savedAt: Date.now(), page: copyImportedPage(page) }
      const pending = writes.then(() => transact('readwrite', (store) => store.put(record, RECORD_KEY)))
      writes = pending.catch(() => {})
      return pending
    },
  }
}
