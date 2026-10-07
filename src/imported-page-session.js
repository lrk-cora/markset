import { copyImportedPage } from './imported-page-cache.js'

// Startup restore and manual imports share one mounting path. A late restore or
// import response must never replace a more recent user-chosen file.
export function createImportedPageSession({ cache, importPage, mountPage }) {
  let generation = 0
  let mounts = Promise.resolve()
  const beginImport = () => ++generation
  const isCurrent = (ticket) => ticket === generation

  async function install(page, ticket, remember) {
    const original = copyImportedPage(page)
    const pending = mounts.then(async () => {
      if (!isCurrent(ticket)) return null
      const mode = await mountPage(copyImportedPage(original))
      return isCurrent(ticket) ? { page: original, mode } : null
    })
    mounts = pending.catch(() => {})
    const result = await pending
    if (!result || !isCurrent(ticket)) return null
    let storageError = null
    if (remember) {
      try { await cache.save(original) } catch (error) { storageError = error }
    }
    return isCurrent(ticket) ? { ...result, storageError } : null
  }

  return {
    beginImport,
    async load(payload, ticket = beginImport()) {
      try {
        if (!isCurrent(ticket)) return null
        const page = await importPage(payload)
        if (!isCurrent(ticket)) return null
        return await install(page, ticket, true)
      } catch (error) {
        if (isCurrent(ticket)) throw error
        return null
      }
    },
    async restore() {
      const ticket = beginImport()
      try {
        const page = await cache.load()
        if (!page || !isCurrent(ticket)) return null
        return await install(page, ticket, false)
      } catch (error) {
        if (isCurrent(ticket)) throw error
        return null
      }
    },
  }
}
