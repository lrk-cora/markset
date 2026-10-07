const trackers = new WeakMap()
let sequence = 0

// Includes synchronous, not-yet-delivered mutations. The document may keep its
// identity when import/undo replaces its root. Watch that replacement as well.
export function pageEvidenceVersion(doc, scope = doc?.documentElement) {
  if (!doc || !scope) return ''
  const watch = scope === doc.documentElement ? doc : scope
  let tracker = trackers.get(watch)
  if (!tracker) {
    tracker = { id: ++sequence, revision: 0 }
    const changed = (records) => {
      if (records.some(record => record.type !== 'attributes'
        || record.oldValue !== record.target.getAttribute(record.attributeName))) tracker.revision++
    }
    const Observer = doc.defaultView?.MutationObserver
    if (Observer) {
      tracker.observer = new Observer(changed)
      tracker.observer.observe(watch, {
        subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true,
      })
      if (scope !== doc.documentElement && doc.head) tracker.observer.observe(doc.head, {
        subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true,
      })
    }
    const invalidate = () => { tracker.revision++ }
    // Asset/font completion and inner scroll can change pixels without DOM edits.
    watch.addEventListener('load', invalidate, true)
    watch.addEventListener('error', invalidate, true)
    watch.addEventListener('scroll', invalidate, { passive: true, capture: true })
    doc.fonts?.addEventListener?.('loadingdone', invalidate)
    doc.fonts?.addEventListener?.('loadingerror', invalidate)
    tracker.flush = () => changed(tracker.observer?.takeRecords() || [])
    trackers.set(watch, tracker)
  }
  tracker.flush()
  const body = doc.body, root = doc.documentElement, view = doc.defaultView
  return [tracker.id, tracker.revision, scope.clientWidth, scope.clientHeight, scope.scrollWidth, scope.scrollHeight,
    body?.scrollWidth, body?.scrollHeight, root?.clientWidth, root?.clientHeight, root?.style?.zoom,
    view?.innerWidth, view?.innerHeight, view?.devicePixelRatio, doc.fonts?.status].join(':')
}

export function pageEvidenceCacheable(doc) {
  if (doc.fonts?.status === 'loading') return false
  if ([...doc.querySelectorAll('video')].some(video => !video.paused)) return false
  return !(doc.getAnimations?.() || []).some(animation => animation.playState === 'running')
}
