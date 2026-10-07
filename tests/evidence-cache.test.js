import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createRevisionCache } from '../src/revision-cache.js'
import { pageEvidenceVersion, pageEvidenceCacheable } from '../src/page-evidence-version.js'
import { readPageObservation } from '../src/page-observation.js'
import { initialPlanningEvidence } from '../src/planning-evidence.js'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))

test('warmup and analysis share one capture; repeated unchanged requests use its cached result', async () => {
  let calls = 0, clock = 0
  const capture = deferred()
  const cache = createRevisionCache({ version: () => 'v1', now: () => clock, produce: () => { calls++; return capture.promise } })
  const warmup = cache.get(), analysis = cache.get()
  await tick(); assert.equal(calls, 1)
  clock = 250; capture.resolve('clean-image')
  const [one, two] = await Promise.all([warmup, analysis])
  assert.equal(one.buildMs, 250); assert.equal(two.shared, true)
  assert.equal((await cache.get()).cacheHit, true); assert.equal(calls, 1)
})

test('resize/edit during capture never returns old pixels or lets an old completion overwrite newer evidence', async () => {
  let revision = 1, calls = 0
  const first = deferred(), second = deferred()
  const cache = createRevisionCache({ version: () => revision, produce: () => (++calls === 1 ? first.promise : second.promise) })
  const old = cache.get(); await tick()
  revision = 2
  const fresh = cache.get(); await tick()
  second.resolve('new'); assert.equal((await fresh).value, 'new')
  first.resolve('old'); assert.equal((await old).value, 'new')
  assert.equal((await cache.get()).value, 'new'); assert.equal(calls, 2)
})

test('clear, expiry, volatile assets and failed captures cannot poison the cache', async () => {
  let clock = 0, calls = 0, stable = true
  const cache = createRevisionCache({ version: () => 1, maxAgeMs: 10, now: () => clock, cacheable: () => stable,
    produce: async () => { if (++calls === 1) throw new Error('capture failed'); return `image-${calls}` } })
  await assert.rejects(cache.get(), /capture failed/)
  assert.equal((await cache.get()).value, 'image-2')
  clock = 10; assert.equal((await cache.get()).value, 'image-3')
  stable = false; await cache.get(); await cache.get(); assert.equal(calls, 5)
  stable = true; cache.clear(); assert.equal((await cache.get()).value, 'image-6')
  const late = deferred()
  let build = 0
  const clearing = createRevisionCache({ version: () => 1, produce: () => ++build === 1 ? late.promise : 'fresh' })
  const old = clearing.get(); await tick(); clearing.clear()
  assert.equal((await clearing.get()).value, 'fresh')
  late.resolve('obsolete'); assert.equal((await old).value, 'fresh')
})

test('repeatedly changing pages fail visibly rather than reuse obsolete evidence', async () => {
  let revision = 0
  const cache = createRevisionCache({ version: () => revision, produce: async () => { revision++; return 'old' } })
  await assert.rejects(cache.get(), { code: 'capture_page_changed' })
})

test('DOM, styles, inner scroll, assets, zoom and viewport changes invalidate evidence synchronously', () => {
  const dom = new JSDOM('<style>h1{color:blue}</style><section><h1>Title</h1><img></section>')
  try {
    const doc = dom.window.document, version = () => pageEvidenceVersion(doc)
    let before = version()
    assert.equal(version(), before)
    for (const change of [
      () => { doc.querySelector('h1').textContent = 'New title' },
      () => { doc.querySelector('style').textContent = 'h1{color:red}' },
      () => { doc.documentElement.style.zoom = '.8' },
      () => { dom.window.innerWidth = 750 },
      () => doc.querySelector('img').dispatchEvent(new dom.window.Event('load')),
      () => doc.querySelector('section').dispatchEvent(new dom.window.Event('scroll')),
      () => { doc.replaceChild(doc.documentElement.cloneNode(true), doc.documentElement) },
    ]) {
      change(); assert.notEqual(version(), before); before = version()
    }
    assert.equal(pageEvidenceCacheable(doc), true)
    doc.getAnimations = () => [{ playState: 'running' }]
    assert.equal(pageEvidenceCacheable(doc), false)
  } finally { dom.window.close() }
})

test('font events invalidate a tracked document and loading fonts are never cached', () => {
  const dom = new JSDOM('<h1>Heading</h1>')
  try {
    const doc = dom.window.document
    const fonts = Object.assign(new dom.window.EventTarget(), { status: 'loaded' })
    Object.defineProperty(doc, 'fonts', { value: fonts })
    const before = pageEvidenceVersion(doc)
    fonts.dispatchEvent(new dom.window.Event('loadingdone'))
    assert.notEqual(pageEvidenceVersion(doc), before)
    fonts.status = 'loading'; assert.equal(pageEvidenceCacheable(doc), false)
  } finally { dom.window.close() }
})

test('module prewarm reuses records but head stylesheet changes refresh computed styles even with unchanged module bounds', () => {
  const dom = new JSDOM('<style>h1{color:rgb(0,0,255)}</style><section data-markset-id="m"><h1 data-markset-id="h">Heading</h1></section>')
  try {
    const doc = dom.window.document, rect = () => ({ x: 0, y: 0, w: 300, h: 100 })
    const read = () => readPageObservation(doc, [{ webId: 'h' }], [], rect)
    const first = read(), second = read()
    assert.equal(first.nodes[1], second.nodes[1], 'same revision reuses computed styles')
    doc.querySelector('style').textContent = 'h1{color:rgb(255,0,0)}'
    const next = read()
    assert.notEqual(next.nodes[1], first.nodes[1])
    assert.equal(next.nodes[1].styles.color, 'rgb(255, 0, 0)')
  } finally { dom.window.close() }
})

test('initial evidence includes selected content, layout parent, siblings and blank anchors without widening read permission', () => {
  const nodes = [
    { webId: 'h', context: { parentId: 'm' }, styles: { color: '#123456' }, text: 'Keep this title' },
    { webId: 'm', context: { parentId: 'outside' }, styles: { display: 'grid' } },
    { webId: 'p', context: { parentId: 'm' }, text: 'Explanation' },
    { webId: 'button', context: { parentId: 'm' } },
    ...Array.from({ length: 80 }, (_, i) => ({ webId: `other-${i}`, context: { parentId: 'deep' } })),
  ]
  const result = initialPlanningEvidence({ selectedIds: ['h'], nodes,
    modules: [{ webId: 'm', children: ['h','p','button'], nearbyBlank: [{ afterId: 'p', beforeId: 'button' }] }] })
  assert.deepEqual(result.nodes.map(node => node.webId), ['h','m','button','p'])
  assert.equal(result.complete, false); assert.equal(result.totalNodes, 84)
  assert.equal(result.nodes[0].styles.color, '#123456')
  assert.ok(!result.nodes.some(node => node.webId === 'outside'))
})
