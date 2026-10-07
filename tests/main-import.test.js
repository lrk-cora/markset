import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { IDBFactory } from 'fake-indexeddb'
import { createImportedPageCache } from '../src/imported-page-cache.js'

// Run the actual application bootstrap and file-input handlers. IndexedDB is
// an in-memory implementation; browser layout/editor mounting are adapters.
class Element extends EventTarget {
  constructor() {
    super()
    Object.assign(this, { value: '', hidden: false, disabled: false, dataset: {}, style: {}, children: [] })
    const classes = new Set()
    this.classList = {
      contains: (name) => classes.has(name),
      toggle: (name, on) => { if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name) },
    }
  }
  setAttribute(name, value) { this[name] = String(value) }
  querySelector() { return new Element() }
  replaceChildren(...children) { this.children = children }
  append(...children) { this.children.push(...children) }
  getBoundingClientRect() { return { left: 1000, top: 0, width: 300, height: 200 } }
  click() { this.dispatchEvent(new Event('click')) }
  remove() { this.removed = true }
}
const nodes = new Map()
const node = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id) }
globalThis.document = {
  body: new Element(), getElementById: node, querySelector: node,
  querySelectorAll: () => [], createElement: () => new Element(),
}
globalThis.window = Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 900 })
globalThis.requestAnimationFrame = () => 0
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
globalThis.indexedDB = new IDBFactory()
const cache = createImportedPageCache()
const original = { title: '上次的网页', snapshotHtml: '<style>h1{color:red}</style><h1>原始内容</h1>' }
await cache.save(original)
const mounted = [], imported = []
let active = false, webEdits = [{ label: '旧修改' }]
let importTask = async () => ({ title: '新网页', snapshotHtml: '<h1>新网页原始内容</h1>' })
globalThis.importAdapters = {
  SELECT_COLOR: '#3c6fd4', createEditor: () => ({}), isWebDocActive: () => active,
  listWebEdits: () => webEdits,
  unmountWebDoc: () => { webEdits = []; active = false },
  applyImportedPage: async (_, prepared) => { mounted.push(prepared); active = true; return 'html' },
  importPage: async (payload) => { imported.push(payload); return importTask(payload) },
}
const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/src/styles.css')) return { format: 'module', source: '', shortCircuit: true }
    const boundary = ['editor', 'overlay', 'web-doc', 'api', 'capture', 'diagnostics-panel'].find((name) => url.endsWith(`/src/${name}.js`))
    if (!boundary) return nextLoad(url, context)
    const names = boundary === 'capture' ? ['captureAnnotationScene','warmAnnotationBase']
      : source.match(new RegExp(`import \\{([^}]+)\\} from '\\./${boundary}\\.js'`))[1].split(',').map((name) => name.trim())
    return { format: 'module', shortCircuit: true, source: names.map((name) =>
      `export const ${name} = globalThis.importAdapters.${name} || (() => {});`,
    ).join('\n') }
  },
})
const store = await import('../src/brush-store.js')
store.addHistory({ label: '旧修改' })
store.startGroup({ id: 'old', targets: [], strokes: [], status: 'draft' })
await import('../src/main.js')
async function waitFor(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('application operation did not finish')
    await new Promise((resolve) => setImmediate(resolve))
  }
}
function chooseFile(html) {
  node('btn-import-html').click()
  const input = document.body.children.at(-1)
  input.files = [{ name: 'upload.html', type: 'text/html', text: async () => html }]
  input.dispatchEvent(new Event('change'))
  return input
}

test('real bootstrap restores the last import in browse mode with empty history and no upload request', async () => {
  await waitFor(() => node('toast').textContent?.includes('已恢复'))
  assert.equal(mounted.length, 1)
  assert.equal(mounted[0].snapshotHtml, original.snapshotHtml)
  assert.equal(imported.length, 0)
  const state = store.getBrushState()
  assert.equal(state.pageLoaded, true)
  assert.equal(state.mode, 'browse')
  assert.equal(state.group, null)
  assert.deepEqual(state.history, [])
  assert.deepEqual(webEdits, [])
})

test('real import button saves a new original only after mounting and leaves live edits out of storage', async () => {
  store.addHistory({ label: '临时修改' })
  const input = chooseFile('<h1>新网页原始内容</h1>')
  await waitFor(() => input.removed)
  assert.deepEqual(imported, [{ html: '<h1>新网页原始内容</h1>' }])
  assert.equal(mounted.at(-1).title, '新网页')
  assert.match(node('toast').textContent, /刷新后自动恢复/)
  assert.deepEqual(store.getBrushState().history, [])
  mounted.at(-1).snapshotHtml = '<h1>当前页面的修改</h1>'
  const restored = await createImportedPageCache().load()
  assert.equal(restored.snapshotHtml, '<h1>新网页原始内容</h1>')
  assert.equal(restored.title, '新网页')
})

test('real import failure retains both the current document and the previous saved import', async () => {
  const count = mounted.length
  importTask = async () => { throw new Error('导入服务不可用') }
  const input = chooseFile('<h1>不能导入</h1>')
  await waitFor(() => input.removed)
  assert.match(node('toast').textContent, /导入服务不可用/)
  assert.equal(mounted.length, count)
  assert.equal(active, true)
  assert.equal(store.getBrushState().pageLoaded, true)
  assert.equal((await cache.load()).title, '新网页')
})

test('importing another document does not automatically exit an already enabled brush mode', async () => {
  store.patchBrush({ mode: 'brush' })
  importTask = async () => ({ title: '另一页', snapshotHtml: '<h1>另一页</h1>' })
  const input = chooseFile('<h1>另一页</h1>')
  await waitFor(() => input.removed)
  assert.equal(store.getBrushState().mode, 'brush')
  assert.equal(store.getBrushState().pageLoaded, true)
  assert.equal(store.getBrushState().group, null)
})
