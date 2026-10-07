// A single, bounded evidence snapshot. Concurrent warmup/analysis requests
// share work, but a capture made against an obsolete revision is NEVER reused.
export function createRevisionCache({ version, produce, cacheable = () => true, maxAgeMs = 30_000, now = Date.now }) {
  let cached = null, pending = null, generation = 0
  return {
    clear() { generation++; cached = null; pending = null },
    async get() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const key = version(), epoch = generation
        if (cached?.key === key && cached.epoch === epoch && cacheable() && now() - cached.at < maxAgeMs) {
          return { ...cached.result, cacheHit: true, shared: false }
        }
        const shared = pending?.key === key && pending.epoch === epoch
        if (!shared) {
          const job = { key, epoch }
          job.promise = Promise.resolve().then(async () => {
            const start = now(), value = await produce()
            const result = { value, version: key, buildMs: Math.max(0, now() - start), cacheHit: false, shared: false }
            if (generation === epoch && version() === key && value && cacheable()) cached = { key, epoch, at: now(), result }
            return result
          }).finally(() => { if (pending === job) pending = null })
          pending = job
        }
        const job = pending
        const result = await job.promise
        if (generation === epoch && version() === key) return { ...result, shared }
        // Resize/edit/import happened during capture. Retry with fresh evidence,
        // not with stale geometry or an old image attached to the current ink.
      }
      throw Object.assign(new Error('页面正在变化，请稍后重新分析；笔迹已保留'), { code: 'capture_page_changed' })
    },
  }
}
