import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { filterExcludedTargets } from '../src/target-selection.js'
import { planCheckReport } from '../src/plan-check-policy.js'
import { anchorBrushStroke } from '../src/brush-layout.js'

// Exercise main.js's real event handlers, renderer, planner and brush store.
// Browser layout, editor mounting and the DOM executor are adapters here;
// this is controller integration coverage, not a browser end-to-end test.
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
globalThis.HTMLInputElement = class extends Element {}
globalThis.HTMLTextAreaElement = class extends Element {}
const calls = []
let drawingArmed = false
let lassoCallbacks
let captureTask = async () => ({})
let modelTask = async () => { throw new Error('Unexpected model roundtrip') }
let imageTask = async () => { throw new Error('Unexpected paid image request') }
let verificationTask = async () => ({ok:true,checks:['mock-layout-adapter']})
const liveRects = new Map()
const layoutRects = new Map()
const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
const boundaryModules = ['editor', 'overlay', 'web-doc', 'api', 'capture', 'diagnostics-panel']
globalThis.submissionAdapters = {
  initDiagnosticsPanel: ({ journal }) => { globalThis.testJournal = journal },
  SELECT_COLOR: '#3c6fd4',
  setLassoMode: (on) => { drawingArmed = on },
  disarmDrawing: () => { drawingArmed = false },
  verifyBrushPlan: (...args) => verificationTask(...args),
  createEditor: () => ({}), isWebDocActive: () => true, listWebEdits: () => [],
  applyBrushPlan: (plan) => {
    if (plan.type === 'color') return globalThis.submissionAdapters.applyBrushColor(plan.targets, plan.parameters?.color || plan.color || plan.replacementText)
    if (plan.type === 'delete') return plan.targetRanges?.length ? globalThis.submissionAdapters.applyBrushTextDeletion(plan.targets,plan.targetRanges) : globalThis.submissionAdapters.applyBrushDelete(plan.targets)
    if (plan.type === 'replace') return globalThis.submissionAdapters.applyBrushTextReplacement(plan.targets,plan)
    if (plan.type === 'insert') { calls.push({type:'insert',plan}); return {ok:true,message:'已插入内容'} }
    throw new Error('Unexpected executor in test: ' + plan.type)
  },
  applyBrushColor: (targets, color) => { calls.push({ type: 'color', targets, color }); return { ok: true, message: '颜色已修改' } },
  applyBrushTextReplacement: () => { calls.push({ type: 'replace' }); return { ok: true } },
  applyBrushDelete: (targets) => { calls.push({ type: 'delete', targets }); return { ok: true, message: '内容已移除' } },
  applyBrushTextDeletion: (targets, ranges) => { calls.push({ type: 'delete-text', targets, ranges }); return { ok: true } },
  planBrushIntent: (...args) => { calls.push({ type: 'model' }); return modelTask(...args) },
  generateImage: (...args) => { calls.push({type:'generate-image'});return imageTask(...args) },
  captureAnnotationScene: (...args) => captureTask(...args),
  bindLasso: (callbacks) => { lassoCallbacks = callbacks },
  hitWebDoc: (polygon) => { calls.push({ type: 'hit', polygon }); return { texts: { found: [target] } } },
  expandBrushTargets: (targets) => targets,
  excludeBrushTargets: filterExcludedTargets,
  liveScreenRect: (target) => liveRects.get(target.webId) || target.screenRect,
  resolveBrushLayoutRect: (reference) => layoutRects.get(reference?.id) || null,
  refreshBrushTargetGeometry: (target) => ({...target,documentRect:layoutRects.get('page') || target.documentRect}),
  webDocumentToScreenPoint: (point) => point,
  webDocumentRectToScreen: (rect) => rect,
  screenToWebDocumentRect: (rect) => rect,
}
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/src/styles.css')) return { format: 'module', source: '', shortCircuit: true }
    const boundary = boundaryModules.find((name) => url.endsWith(`/src/${name}.js`))
    if (!boundary) return nextLoad(url, context)
    const imported = boundary === 'capture' ? ['captureAnnotationScene','warmAnnotationBase']
      : source.match(new RegExp(`import \\{([^}]+)\\} from '\\./${boundary}\\.js'`))[1].split(',').map((name) => name.trim())
    return {
      format: 'module', shortCircuit: true,
      source: imported.map((name) => `export const ${name} = globalThis.submissionAdapters.${name} || (() => {});`).join('\n'),
    }
  },
})
const store = await import('../src/brush-store.js')
const settings = await import('../src/brush-settings.js')
const behavior = await import('../src/behavior-memory.js')
await import('../src/main.js')
const target = { webId: 'heading', kind: 'text', text: '原标题', context: { tag: 'h1' } }
beforeEach(() => {
  settings.resetBrushSettings()
  globalThis.testJournal.clear()
  calls.length = 0
  drawingArmed = false
  liveRects.clear()
  layoutRects.clear()
  captureTask = async () => ({})
  modelTask = async () => { throw new Error('Unexpected model roundtrip') }
  imageTask = async () => { throw new Error('Unexpected paid image request') }
  verificationTask = async () => ({ok:true,checks:['mock-layout-adapter']})
  behavior.clearBehaviorOverrides()
  store.resetBrushState()
  store.startGroup({
    id: 'marked-title', revision: 1, strokes: [], targets: [target], status: 'suggested',
    inferredIntent: { type: 'note', needsClarification: true, clarifyingQuestion: '你想如何修改？', suggestion: { alternatives: [] } },
    replacementText: '', feedbackDraft: '',
  })
})
afterEach(() => node('btn-inline-dismiss').dispatchEvent(new Event('click')))
const tick = () => new Promise((resolve) => setImmediate(resolve))
const until = async predicate => {
  const started=Date.now()
  while (!predicate()) {
    assert.ok(Date.now()-started<2000,'controller did not reach the expected state')
    await new Promise(resolve=>setTimeout(resolve,5))
  }
}

function enableBrush() {
  store.patchBrush({ pageLoaded: true })
  node('btn-brush').dispatchEvent(new Event('click'))
  assert.equal(store.getBrushState().mode, 'brush')
  assert.equal(drawingArmed, true)
}

const finishDot = () => { lassoCallbacks.onStart(); lassoCallbacks.onFinish([], { strokeId: 'settings-dot', rawPoints: [{ x: 100, y: 200 }], shape: 'dot', width: 8, opacity: 0.4, smoothing: 'strong' }) }

test('disabled automatic analysis leaves a manual start action, with appearance preserved in the real group', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  settings.setBrushSettings({ autoAnalyze: false })
  enableBrush(); finishDot()
  t.mock.timers.tick(5000); await tick()
  const group = store.getBrushState().group
  assert.equal(group.status, 'draft')
  assert.equal(group.strokes[0].width, 8)
  assert.equal(group.strokes[0].opacity, 0.4)
  assert.equal(node('btn-analyze-strokes').hidden, false)
  assert.equal(node('btn-inline-primary').hidden, true)
  assert.equal(node('inline-proposal-kind').textContent, '待分析')
  assert.equal(calls.filter((call) => call.type === 'model').length, 0)
  modelTask = async () => ({ model: 'test', intent: concreteColor() })
  node('btn-analyze-strokes').dispatchEvent(new Event('click'))
  for (let i = 0; i < 6; i++) await tick()
  assert.equal(calls.filter((call) => call.type === 'model').length, 1)
  assert.equal(calls.filter((call) => call.type === 'color').length, 0, 'analysis is not permission to apply')
  assert.equal(store.getBrushState().group.status, 'suggested')
  assert.equal(node('btn-analyze-strokes').hidden, true)
})

test('manual analysis with a complete typed instruction suggests but cannot auto-apply', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  settings.setBrushSettings({ autoAnalyze: false })
  enableBrush(); finishDot()
  typeInstruction('改成红色')
  pressEnter()
  for (let i = 0; i < 4; i++) await tick()
  assert.equal(store.getBrushState().group.inferredIntent.type, 'color')
  assert.equal(store.getBrushState().group.status, 'suggested')
  assert.equal(calls.filter((call) => call.type === 'color').length, 0)
  node('btn-inline-primary').dispatchEvent(new Event('click')); await tick()
  assert.equal(calls.filter((call) => call.type === 'color').length, 1)
})

test('the configured pause controls automatic analysis and disabling it cancels late results', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  settings.setBrushSettings({ analysisDelayMs: 2500 })
  let release
  modelTask = () => new Promise((resolve) => { release = resolve })
  enableBrush(); finishDot()
  t.mock.timers.tick(2499); await tick()
  assert.equal(calls.filter((call) => call.type === 'model').length, 0)
  t.mock.timers.tick(1)
  for (let i = 0; i < 8 && !release; i++) await tick()
  assert.equal(typeof release, 'function')
  settings.setBrushSettings({ autoAnalyze: false })
  release({ model: 'test', intent: concreteColor() })
  await tick(); await tick()
  assert.equal(store.getBrushState().group.status, 'draft')
  assert.equal(store.getBrushState().group.inferredIntent, null)
  assert.equal(store.getBrushState().group.strokes.length, 1)
  assert.equal(node('btn-analyze-strokes').hidden, false)
})

test('a tap appends a one-point stroke to the current group instead of cancelling it or exiting', () => {
  enableBrush()
  const id = store.getBrushState().group.id
  lassoCallbacks.onStart()
  lassoCallbacks.onFinish([{ x: 92, y: 192 }, { x: 108, y: 192 }, { x: 108, y: 208 }, { x: 92, y: 208 }], {
    strokeId: 'dot-1', rawPoints: [{ x: 100, y: 200 }], shape: 'dot', closed: false,
  })
  const group = store.getBrushState().group
  assert.equal(group.id, id)
  assert.equal(group.strokes.length, 1)
  assert.deepEqual(group.strokes[0].points, [{ x: 100, y: 200 }])
  assert.equal(group.strokes[0].shape, 'dot')
  assert.equal(group.strokes[0].closed, false)
  lassoCallbacks.onStart()
  lassoCallbacks.onFinish([], { strokeId: 'line-2', rawPoints: [{ x: 120, y: 200 }, { x: 220, y: 200 }] })
  assert.equal(store.getBrushState().group.strokes.length, 2)
  assert.equal(store.getBrushState().mode, 'brush')
  assert.equal(drawingArmed, true)
})

test('cancelled contact, dismissed suggestions and Escape leave drawing enabled; only the toolbar button exits', () => {
  enableBrush()
  const group = store.getBrushState().group
  lassoCallbacks.onCancel({ cancelled: true, tap: false })
  assert.equal(store.getBrushState().group.id, group.id)
  node('btn-inline-dismiss').dispatchEvent(new Event('click'))
  assert.equal(store.getBrushState().group, null)
  assert.equal(store.getBrushState().mode, 'brush')
  assert.equal(drawingArmed, true)
  store.startGroup(group)
  window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }))
  assert.equal(store.getBrushState().group, null)
  window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'b' }))
  assert.equal(store.getBrushState().mode, 'brush')
  assert.equal(drawingArmed, true)
  node('btn-brush').dispatchEvent(new Event('click'))
  assert.equal(store.getBrushState().mode, 'browse')
  assert.equal(drawingArmed, false)
})

test('successful modification re-arms drawing for the next operation without automatically leaving brush mode', async () => {
  enableBrush()
  typeInstruction('改成红色')
  pressEnter()
  await tick()
  assert.equal(calls.filter((call) => call.type === 'color').length, 1)
  assert.equal(store.getBrushState().group, null)
  assert.equal(store.getBrushState().mode, 'brush')
  assert.equal(drawingArmed, true)
})

test('a lasso containing marked characters is not delete evidence at the final apply gate or in alternatives', async () => {
  const plan={type:'delete',source:'model',targets:[target],confidence:.99,goal:'移除标题',rationale:'模型建议',strategy:'移除标题',impact:{scope:'标题',riskLevel:'low'},targetRanges:[{targetId:'heading',start:0,end:3}]}
  store.patchGroup({localIntent:{parameters:{hasRegion:true,markedTextRange:true,hasCross:false,textStrike:false}},inferredIntent:plan})
  node('btn-inline-primary').dispatchEvent(new Event('click'))
  await tick()
  assert.equal(calls.length,0)
  store.patchGroup({inferredIntent:{type:'note',source:'model',needsClarification:true,clarifyingQuestion:'如何修改？',targetRanges:plan.targetRanges,suggestion:{alternatives:['删除标题','调整颜色']}}})
  assert.ok(node('inline-proposal-alternatives').children.every(child=>!/删除标题/u.test(child.textContent || '')))
})

test('a local confirmation journals the user input and actual execution without a model roundtrip', async () => {
  typeInstruction('改成红色')
  pressEnter()
  await tick()
  const entry = globalThis.testJournal.getEntries().at(-1)
  assert.match(entry.user, /改成红色/u)
  assert.equal(entry.source, 'local')
  assert.match(entry.execution, /已执行/u)
  assert.ok(calls.every((call) => call.type !== 'model'))
})

test('model timeout is journalled separately from the fallback and no modification is recorded', async () => {
  modelTask = async () => { throw Object.assign(new Error('timeout'), { code: 'model_gateway_timeout', status: 504, model:'qwen3.8-max', routing:{tier:'max',reason:'视觉规划'},retriesUsed:2 }) }
  typeInstruction('这个模块看起来更柔和一点')
  pressEnter()
  for (let i = 0; i < 6; i++) await tick()
  const entry = globalThis.testJournal.getEntries().at(-1)
  assert.equal(entry.status, 'error')
  assert.equal(entry.source, 'fallback')
  assert.equal(entry.errorCode, 'model_gateway_timeout')
  assert.equal(entry.execution, '')
  assert.equal(entry.model, 'qwen3.8-max')
  assert.match(entry.routing, /视觉规划/)
  assert.equal(entry.retriesUsed, 2)
  assert.ok(calls.every((call) => !['replace', 'color', 'delete'].includes(call.type)))
})

test('model idle timeout retains source/attempt diagnostics, strokes and user draft without applying fallback',async()=>{
  const strokes=[{id:'keep-stroke',points:[{x:10,y:10},{x:20,y:20}],documentPoints:[{x:10,y:10},{x:20,y:20}]}]
  store.patchGroup({strokes})
  modelTask=async()=>{throw Object.assign(new Error('PRIVATE_BODY'),{code:'model_stream_idle_timeout',status:504,timeoutSource:'local',timeoutStage:'idle',timeoutMs:15_000,
    model:'qwen3.8-max',retriesUsed:1,timings:{modelRequests:1,modelAttempts:2,attempts:[{request:1,attempt:1,status:200,firstOutputMs:23_000,
      elapsedMs:35_000,timeoutSource:'local',timeoutStage:'idle',prompt:'PRIVATE_PROMPT'}]}})}
  typeInstruction('这个模块看起来更柔和一点');pressEnter()
  for(let i=0;i<6;i++)await tick()
  const entry=globalThis.testJournal.getEntries().at(-1),group=store.getBrushState().group
  assert.equal(entry.timeoutSource,'local');assert.equal(entry.timeoutStage,'idle')
  assert.equal(entry.timings.attempts[0].firstOutputMs,23_000);assert.equal(entry.timings.attempts[0].status,200)
  assert.deepEqual(group.strokes,strokes);assert.match(group.feedbackDraft,/柔和/)
  assert.doesNotMatch(JSON.stringify(entry),/PRIVATE_BODY|PRIVATE_PROMPT/)
  assert.ok(calls.every(call=>!['replace','color','delete'].includes(call.type)))
})

test('wrapping a deletion in a batch cannot turn a bare circle into deletion permission', async () => {
  const deletion={type:'delete',source:'model',targets:[target],goal:'移除标题',rationale:'模型建议',strategy:'移除标题',impact:{scope:'标题',riskLevel:'low'}}
  const color={...deletion,type:'color',parameters:{color:'#ff0000'}}
  store.patchGroup({localIntent:{parameters:{hasRegion:true,markedTextRange:true}},inferredIntent:{...deletion,type:'batch',steps:[deletion,color]}})
  node('btn-inline-primary').dispatchEvent(new Event('click'))
  await tick()
  assert.equal(calls.length,0)
})

test('view-only journal history is never added to an analysis payload', async () => {
  const id = globalThis.testJournal.begin({ id: 'private-log', strokes: [], targets: [] }, { instruction: 'VIEW_ONLY_JOURNAL_MARKER' })
  globalThis.testJournal.finish(id, { intent: { type: 'note' }, source: 'local' })
  let payload
  modelTask = async (input) => { payload = input; return { model: 'test', intent: { type: 'note', confidence: 0.6,
    targets: input.targets, suggestion: { text: '调整颜色还是间距？', alternatives: ['调整颜色', '调整间距'] }, needsClarification: true } } }
  typeInstruction('这个模块看起来更柔和一点')
  pressEnter()
  for (let i = 0; i < 6; i++) await tick()
  assert.ok(payload)
  assert.doesNotMatch(JSON.stringify(payload), /VIEW_ONLY_JOURNAL_MARKER/u)
})
function typeInstruction(value) {
  node('inline-custom-intent-input').value = value
  node('inline-custom-intent-input').dispatchEvent(new Event('input'))
}
function pressEnter(props = {}) {
  node('inline-custom-intent-input').dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Enter', ...props }))
}

test('remove-this-block overrides old text ranges and replacement prompts without any gateway call', async () => {
  store.patchGroup({
    selectedAlternative: '替换文字内容',
    customInstruction: '不要删除，只替换文字',
    inferredIntent: { type: 'replace', needsInput: true, clarifyingQuestion: '请输入替换的完整新标题', targets: [target] },
    localIntent: { type: 'delete', targets: [target], targetRanges: [{ targetId: target.webId, start: 0, end: 1, expectedText: '原' }] },
  })
  typeInstruction('去掉这块内容')
  pressEnter()
  await tick()
  assert.deepEqual(calls, [{ type: 'delete', targets: [target] }])
  assert.equal(store.getBrushState().group, null)
})

test('a new delete instruction in the old replacement-content field is an action, not page copy', async () => {
  store.patchGroup({ inferredIntent: { type: 'note', needsInput: true, needsClarification: true, clarifyingQuestion: '请提供替换的新标题文字' } })
  node('inline-replace-input').value = '去掉这块内容'
  node('inline-replace-input').dispatchEvent(new Event('input'))
  node('btn-inline-primary').dispatchEvent(new Event('click'))
  await tick()
  assert.deepEqual(calls.map((call) => call.type), ['delete'])
  assert.equal(store.getBrushState().group, null)
})

test('word-only delete remains a range operation even when the stored preference favors whole objects', async () => {
  behavior.setBehaviorPreference('textScope', 'text-object')
  typeInstruction('删除“原”')
  pressEnter()
  await tick()
  assert.deepEqual(calls, [{ type: 'delete-text', targets: [target], ranges: [{ targetId: target.webId, start: 0, end: 1, expectedText: '原' }] }])
})

test('delete still respects an explicit preview preference and only commits once when confirmed', async () => {
  behavior.setBehaviorPreference('clearIntentAction', 'preview')
  typeInstruction('去掉这块内容')
  node('btn-inline-primary').dispatchEvent(new Event('click'))
  await tick()
  assert.equal(calls.length, 0)
  assert.equal(store.getBrushState().group.status, 'previewing')
  node('btn-inline-primary').dispatchEvent(new Event('click'))
  await tick()
  assert.deepEqual(calls.map((call) => call.type), ['delete'])
})

test('restricted delete plus a 502 is neither replacement copy nor permission to delete all', async () => {
  modelTask = async () => { throw new Error('upstream 502') }
  store.patchGroup({ inferredIntent: { type: 'note', needsInput: true, needsClarification: true, clarifyingQuestion: '请提供替换的新标题文字' } })
  typeInstruction('只删除红色的文字')
  pressEnter()
  await tick()
  await tick()
  assert.deepEqual(calls.map((call) => call.type), ['model'])
  assert.equal(store.getBrushState().group.status, 'suggested')
  assert.equal(store.getBrushState().group.feedbackDraft, '只删除红色的文字')
})

test('actual Enter handler applies red once and closes the proposal, without a model roundtrip', async () => {
  typeInstruction('颜色改为红色')
  assert.equal(calls.length, 0, 'typing is not authorization to apply')
  pressEnter()
  await tick()
  assert.deepEqual(calls, [{ type: 'color', color: '红色', targets: [target] }])
  assert.equal(store.getBrushState().group, null)
  assert.equal(node('inline-proposal').hidden, true)
})

test('actual modify click has the same one-step result as Enter', async () => {
  typeInstruction('改成红色')
  node('btn-inline-primary').dispatchEvent(new Event('click'))
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].type, 'color')
  assert.equal(store.getBrushState().group, null)
})

test('IME confirmation does not accidentally submit a partially composed instruction', async () => {
  typeInstruction('改成红色')
  pressEnter({ isComposing: true })
  await tick()
  assert.equal(calls.length, 0)
  assert.ok(store.getBrushState().group)
  pressEnter()
  await tick()
  assert.equal(calls.length, 1)
})

test('a new color instruction overrides an obsolete replacement question, never becomes page copy', async () => {
  store.patchGroup({
    inferredIntent: { type: 'note', needsInput: true, needsClarification: true, clarifyingQuestion: '请提供替换的新标题文字', clarificationAlreadyAnswered: true },
  })
  node('inline-replace-input').value = '改成红色'
  node('inline-replace-input').dispatchEvent(new Event('input'))
  node('btn-inline-primary').dispatchEvent(new Event('click'))
  await tick()
  assert.deepEqual(calls.map((call) => call.type), ['color'])
  assert.equal(store.getBrushState().group, null)
})

test('preview preference and a new correction are honored together by the actual handler', async () => {
  behavior.setBehaviorPreference('clearIntentAction', 'preview')
  store.patchGroup({ inferredIntent: { type: 'color', color: '黑色', parameters: { color: '黑色' }, targets: [target], needsInput: false } })
  typeInstruction('改成红色')
  assert.equal(node('btn-inline-primary').dataset.action, 'preview')
  pressEnter()
  await tick()
  assert.equal(calls.length, 0)
  assert.equal(store.getBrushState().group.status, 'previewing')
  assert.equal(store.getBrushState().group.inferredIntent.color, '红色')
  node('btn-inline-primary').dispatchEvent(new Event('click'))
  await tick()
  assert.equal(calls[0].color, '红色')
})

test('a synchronous local-planning exception unlocks the actual UI and preserves the request', async () => {
  const faultyTarget = { ...target, webId: 'faulty', get context() { throw new RangeError('test classification failure') } }
  store.patchGroup({ targets: [target, faultyTarget] })
  typeInstruction('把布局调整一下')
  pressEnter()
  await tick()
  assert.equal(store.getBrushState().group.status, 'suggested')
  assert.equal(node('btn-inline-primary').disabled, false)
  assert.equal(node('inline-custom-intent-input').value, '把布局调整一下')
  assert.equal(node('inline-custom-intent-input').disabled, false)
  assert.equal(node('inline-replace-input').hidden, true)
  assert.equal(calls.length, 0)
})

test('a hung screenshot exits understanding at the deadline; its late result cannot call the model', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release
  captureTask = () => new Promise((resolve) => { release = resolve })
  typeInstruction('这个区域看起来柔和一点')
  pressEnter()
  await tick()
  assert.equal(store.getBrushState().group.status, 'analyzing')
  assert.equal(typeof release, 'function')
  t.mock.timers.tick(14_001)
  await tick()
  assert.equal(store.getBrushState().group.status, 'suggested')
  assert.equal(node('btn-inline-primary').disabled, false)
  assert.equal(node('inline-custom-intent-input').value, '这个区域看起来柔和一点')
  assert.equal(node('inline-replace-input').hidden, true)
  assert.equal(store.getBrushState().group.inferredIntent.type, 'note')
  release({})
  await tick()
  assert.equal(calls.filter((call) => call.type === 'model').length, 0)
})

test('gateway failure returns the actual submitted UI to an editable local suggestion', async () => {
  modelTask = async () => { throw Object.assign(new Error('upstream unavailable'), { code: '502' }) }
  typeInstruction('这个区域看起来柔和一点')
  pressEnter()
  await tick()
  await tick()
  assert.equal(store.getBrushState().group.status, 'suggested')
  assert.equal(node('btn-inline-primary').disabled, false)
  assert.equal(node('inline-custom-intent-input').value, '这个区域看起来柔和一点')
  assert.equal(calls.filter((call) => call.type === 'model').length, 1)
  assert.equal(calls.filter((call) => call.type === 'color' || call.type === 'replace').length, 0)
  assert.equal(node('inline-error-message').hidden, false)
  assert.match(node('inline-error-message').textContent, /502/)
  assert.match(node('inline-proposal-kind').textContent, /AI 未完成/)
  assert.match(node('toast').textContent, /502/)
  assert.equal(node('btn-inline-retry').hidden, false)
})

test('AI retry includes the latest correction, clears the warning on success, and does not apply', async () => {
  modelTask = async () => { throw Object.assign(new Error('failed'), { status: 502, code: 'model_gateway_upstream', requestId: 'request-one' }) }
  typeInstruction('这个区域看起来柔和一点')
  pressEnter(); await tick(); await tick()
  assert.match(node('inline-error-message').title, /request-one/)
  typeInstruction('保留原来的文字，只调整视觉风格')
  modelTask = async (payload) => {
    assert.match(payload.userInstruction, /保留原来的文字，只调整视觉风格/)
    return { model: 'test', intent: { type: 'note', confidence: 0.8, needsClarification: true, clarifyingQuestion: '调整颜色还是间距？', suggestion: { text: '请选择', alternatives: ['调整颜色', '调整间距'] } } }
  }
  node('btn-inline-retry').dispatchEvent(new Event('click'))
  await tick(); await tick()
  assert.equal(store.getBrushState().group.analysisIssue, null)
  assert.equal(node('inline-error-message').hidden, true)
  assert.equal(node('btn-inline-retry').hidden, true)
  assert.deepEqual(calls.map((call) => call.type), ['model', 'model'])
})

test('a late failed response cannot toast or attach an error to a new group', async () => {
  let rejectModel
  modelTask = () => new Promise((_resolve, reject) => { rejectModel = reject })
  typeInstruction('这个区域看起来柔和一点')
  pressEnter(); await tick()
  const old = store.getBrushState().group
  store.startGroup({ ...old, id: 'new-group', revision: 2, status: 'draft', analysisIssue: null })
  node('toast').textContent = ''
  rejectModel(Object.assign(new Error('failed'), { status: 502 }))
  await tick(); await tick()
  assert.equal(store.getBrushState().group.analysisIssue, null)
  assert.equal(node('toast').textContent, '')
})

test('repeated-endpoint oval reaches hit testing, keeps its raw ink and returns a selectable suggestion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { paintHitPolygon } = await import('../src/geometry.js')
  const points = Array.from({ length: 100 }, (_, i) => {
    const angle = i / 99 * (Math.PI * 2 + 0.2)
    return { x: 480 + 390 * Math.cos(angle), y: 300 + 110 * Math.sin(angle) }
  })
  store.clearGroup()
  lassoCallbacks.onStart()
  lassoCallbacks.onFinish(paintHitPolygon(points), { rawPoints: points, closed: true, strokeId: 'retraced-oval' })
  assert.equal(calls[0].type, 'hit')
  assert.ok(calls[0].polygon.length >= 3)
  assert.deepEqual(store.getBrushState().group.targets, [target])
  assert.deepEqual(store.getBrushState().group.strokes[0].points, points)
  assert.notEqual(store.getBrushState().group.strokes[0].shape, 'arrow')
  t.mock.timers.tick(settings.getBrushSettings().analysisDelayMs + 1)
  await tick()
  await tick()
  assert.equal(store.getBrushState().group.status, 'suggested')
  assert.equal(store.getBrushState().group.inferredIntent.parameters.hasRegion, true)
  assert.notEqual(store.getBrushState().group.inferredIntent.type, 'delete')
  assert.equal(node('btn-inline-primary').disabled, false)
  assert.equal(node('inline-replace-input').hidden, true)
})

test('background interpretation hides provisional menus, allows correction and retains a new draft on success',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']})
  let release
  modelTask=()=>new Promise(resolve=>{release=resolve})
  const points=Array.from({length:60},(_,i)=>({x:200+150*Math.cos(i*Math.PI/29.5),y:200+70*Math.sin(i*Math.PI/29.5)}))
  store.clearGroup();lassoCallbacks.onStart();lassoCallbacks.onFinish([],{rawPoints:points,closed:true,strokeId:'pending-circle'})
  t.mock.timers.tick(settings.getBrushSettings().analysisDelayMs + 1);await tick();await tick()
  assert.equal(store.getBrushState().group.modelPending,true)
  assert.match(node('inline-proposal-kind').textContent,/AI 设计方案 · \d+ 秒/u)
  assert.equal(node('inline-proposal').dataset.status,'planning')
  assert.equal(node('inline-status-visual').hidden,false)
  assert.equal(node('inline-proposal-alternatives').hidden,true)
  assert.equal(node('btn-inline-primary').disabled,true)
  assert.equal(node('inline-custom-intent-input').disabled,false)
  typeInstruction('保留文字，只改变视觉层次')
  assert.equal(node('btn-inline-primary').disabled,true,'no Modify before the complete plan is checked')
  assert.equal(node('btn-analyze-strokes').textContent,'取消分析')
  release({model:'test',intent:concreteColor()});for(let i=0;i<6;i++)await tick()
  assert.equal(store.getBrushState().group.modelPending,false)
  assert.equal(node('inline-proposal').dataset.status,'ready')
  assert.equal(node('inline-custom-intent-input').value,'保留文字，只改变视觉层次')
  assert.ok(!calls.some(call=>['delete','color','replace'].includes(call.type)))
})

test('a local correction can replace a pending visual request without leaving a preview stuck pending',async()=>{
  behavior.setBehaviorPreference('clearIntentAction','preview')
  store.patchGroup({modelPending:true})
  typeInstruction('改成红色');pressEnter();await tick()
  assert.equal(store.getBrushState().group.modelPending,true,'Enter cannot apply a draft or accidentally cancel')
  node('btn-analyze-strokes').dispatchEvent(new Event('click'))
  assert.equal(store.getBrushState().group.feedbackDraft,'改成红色')
  assert.equal(node('btn-analyze-strokes').textContent,'开始分析')
  // Start analyzes this correction; Modify remains a separate explicit action.
  node('btn-analyze-strokes').dispatchEvent(new Event('click'));for(let i=0;i<6;i++)await tick()
  assert.equal(store.getBrushState().group.modelPending,false)
  assert.equal(store.getBrushState().group.status,'suggested')
  node('btn-inline-primary').dispatchEvent(new Event('click'));await tick()
  assert.equal(store.getBrushState().group.status,'previewing')
  assert.equal(node('btn-inline-primary').disabled,false)
  assert.ok(!calls.some(call=>call.type==='model'))
})

test('streamed drafts stay view-only through verification; cancel preserves ink/input and rejects late events',async()=>{
  settings.setBrushSettings({autoAnalyze:false})
  let progress,release,signal
  modelTask=(_payload,options)=>{progress=options.onProgress;signal=options.signal;return new Promise(resolve=>{release=resolve})}
  const ink=[{id:'keep-ink',points:[{x:100,y:200},{x:200,y:210}]}]
  store.patchGroup({strokes:ink,status:'draft'})
  node('btn-analyze-strokes').dispatchEvent(new Event('click'));await tick();await tick()
  progress({stage:'draft',draftSummary:'保留原标题，调整为蓝色'})
  assert.equal(node('inline-proposal-text').textContent,'保留原标题，调整为蓝色')
  assert.equal(node('inline-analysis-progress').textContent,'草案 · 检查通过后可修改')
  assert.equal(node('btn-inline-primary').disabled,true)
  typeInstruction('再增加一点间距')
  node('btn-analyze-strokes').dispatchEvent(new Event('click'))
  assert.equal(signal.aborted,true)
  assert.deepEqual(store.getBrushState().group.strokes,ink)
  assert.equal(store.getBrushState().group.feedbackDraft,'再增加一点间距')
  progress({stage:'draft',draftSummary:'旧结果不得显示'})
  release({model:'test',intent:concreteColor()});for(let i=0;i<6;i++)await tick()
  assert.equal(store.getBrushState().group.status,'draft')
  assert.notEqual(node('inline-proposal-text').textContent,'旧结果不得显示')
  assert.ok(!calls.some(call=>['delete','color','replace'].includes(call.type)))
})

test('a manual request with no prior intent still shows every streaming phase and editable input',async()=>{
  settings.setBrushSettings({autoAnalyze:false})
  let progress,release
  modelTask=(_payload,options)=>{progress=options.onProgress;return new Promise(resolve=>{release=resolve})}
  store.patchGroup({status:'draft',inferredIntent:null,strokes:[{id:'circle',closed:true,points:[{x:1,y:1},{x:40,y:40}]}]})
  typeInstruction('在区域旁补充一张图，保留原文')
  node('btn-analyze-strokes').dispatchEvent(new Event('click'));await tick();await tick()
  assert.equal(node('inline-proposal').hidden,false)
  assert.equal(node('inline-custom-intent-input').disabled,false)
  progress({stage:'draft',draftSummary:'在右侧新增配图，保留原文'})
  assert.equal(node('inline-proposal').hidden,false)
  assert.equal(node('inline-proposal-text').textContent,'在右侧新增配图，保留原文')
  assert.equal(node('btn-inline-primary').disabled,true)
  node('btn-analyze-strokes').dispatchEvent(new Event('click'))
  release({model:'test',intent:concreteColor()});for(let i=0;i<6;i++)await tick()
  assert.equal(store.getBrushState().group.status,'draft')
  assert.equal(node('inline-custom-intent-input').value,'在区域旁补充一张图，保留原文')
})

test('adding a stroke preserves a pending correction; background success cannot consume text it did not receive',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']})
  let release
  modelTask=()=>new Promise(resolve=>{release=resolve})
  store.patchGroup({customInstruction:'保留原文，优化标题',userInstruction:'保留原文，优化标题',feedbackDraft:'请再增加一点间距'})
  lassoCallbacks.onStart()
  lassoCallbacks.onFinish([],{strokeId:'next-stroke',rawPoints:[{x:100,y:100},{x:200,y:110}]})
  assert.equal(store.getBrushState().group.feedbackDraft,'请再增加一点间距')
  assert.equal(store.getBrushState().group.customInstruction,'保留原文，优化标题')
  t.mock.timers.tick(settings.getBrushSettings().analysisDelayMs+1);await tick();await tick()
  release({model:'test',intent:concreteColor()});for(let i=0;i<6;i++)await tick()
  assert.equal(store.getBrushState().group.feedbackDraft,'请再增加一点间距')
  assert.equal(store.getBrushState().group.strokes.length,1)
})

test('verification stage cannot be skipped by a streamed summary and failure retains the submitted instruction',async()=>{
  let release
  modelTask=async(_payload,{onProgress})=>{onProgress({stage:'draft',draftSummary:'建议草案'});return{model:'test',intent:concreteColor()}}
  verificationTask=()=>new Promise(resolve=>{release=resolve})
  typeInstruction('标题沉稳一点，保留文字');pressEnter();await tick();await tick()
  assert.match(node('inline-proposal-kind').textContent,/检查方案/u)
  assert.equal(node('btn-inline-primary').disabled,true)
  assert.equal(node('inline-custom-intent-input').disabled,false)
  release({ok:true,checks:['execution','undo']});for(let i=0;i<6;i++)await tick()
  assert.equal(node('btn-inline-primary').disabled,false)
  assert.ok(!calls.some(call=>call.type==='color'))
  modelTask=async()=>{throw Object.assign(new Error('timeout'),{code:'model_gateway_timeout',status:504,timings:null})}
  typeInstruction('颜色和间距再柔和一点');pressEnter();for(let i=0;i<6;i++)await tick()
  assert.equal(node('inline-custom-intent-input').value,'颜色和间距再柔和一点')
  assert.equal(store.getBrushState().group.analysisIssue.code,'model_gateway_timeout','missing timing metadata must not mask the actual failure')
})

for(const [phase,code,deadline] of [['capture','capture_timeout',8000],['verify','verification_timeout',4000],['analysis','analysis_timeout',70000]]) {
  test(`${phase} deadline reports its actual source and retains the user's ink and input`,async(t)=>{
    t.mock.timers.enable({apis:['setTimeout']})
    let reached=false
    const hang=()=>{reached=true;return new Promise(()=>{})}
    modelTask=phase==='analysis' ? hang : async()=>({model:'test',intent:concreteColor()})
    if(phase==='capture')captureTask=hang
    if(phase==='verify')verificationTask=hang
    settings.setBrushSettings({autoAnalyze:false});enableBrush();finishDot()
    typeInstruction('标题沉稳一点，保留文字');pressEnter()
    for(let i=0;i<12&&!reached;i++)await tick()
    assert.equal(reached,true)
    t.mock.timers.tick(deadline+1);for(let i=0;i<6;i++)await tick()
    const group=store.getBrushState().group
    assert.equal(group.analysisIssue.code,code);assert.equal(group.analysisIssue.status,0)
    assert.equal(group.analysisIssue.timeoutPhase,phase);assert.equal(group.analysisIssue.timeoutMs,deadline)
    assert.equal(group.strokes.length,1);assert.equal(group.modelPending,false)
    assert.equal(node('inline-custom-intent-input').value,'标题沉稳一点，保留文字')
    assert.doesNotMatch(node('inline-error-message').textContent,/（23）/u)
    assert.equal(node('btn-inline-retry').hidden,false)
    assert.equal(calls.filter(call=>call.type==='color').length,0)
    assert.equal(globalThis.testJournal.getEntries().at(-1).timeoutPhase,phase)
    if(phase==='capture')assert.equal(calls.filter(call=>call.type==='model').length,0,'a failed screenshot is not a failed model call')
  })
}

test('a visual whole-title strike-out is not forced back into the first stroke character range',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']})
  target.markedRanges=[{start:0,end:1,text:'原'}]
  try {
    modelTask=async()=>({model:'test',intent:{type:'delete',source:'model',targets:[target],confidence:.9,goal:'移除划掉的标题',rationale:'整段标题被划掉',strategy:'删除标题对象，保留周边内容',impact:{scope:'标题',riskLevel:'medium'},targetRanges:[],requiresConfirmation:true,suggestion:{text:'移除划掉的标题，保留下方说明',alternatives:[]}}})
    const points=Array.from({length:31},(_,i)=>({x:100+450*i/30,y:100+220*i/30}))
    store.clearGroup();lassoCallbacks.onStart();lassoCallbacks.onFinish([],{rawPoints:points,strokeId:'title-strike'})
    t.mock.timers.tick(settings.getBrushSettings().analysisDelayMs + 1);for(let i=0;i<8;i++)await tick()
    const group=store.getBrushState().group
    assert.equal(group.inferredIntent.type,'delete');assert.equal(group.analysisIssue,null)
    assert.equal(group.inferredIntent.targetRanges.length,0)
    assert.deepEqual(calls.filter(call=>call.type==='model').length,1)
    assert.ok(!calls.some(call=>call.type==='delete'))
    node('btn-inline-primary').dispatchEvent(new Event('click'));for(let i=0;i<6;i++)await tick()
    assert.equal(calls.filter(call=>call.type==='delete').length,1)
  } finally {delete target.markedRanges}
})

function selectTwoTargets() {
  const first = { ...target, screenRect: { x: 100, y: 180, w: 360, h: 80 } }
  const second = { ...target, webId: 'paragraph', text: '说明段落', screenRect: { x: 100, y: 290, w: 360, h: 50 } }
  store.patchGroup({ targets: [first, second], strokes: [{ id: 'selection-ink', points: [{ x: 100, y: 200 }, { x: 460, y: 310 }] }] })
  return [first, second]
}
function dismissTarget(id) {
  const button = node('target-controls-layer').children.find((button) => button.dataset.targetId === id)
  assert.ok(button, `close button for ${id}`)
  button.dispatchEvent(new Event('click', { cancelable: true }))
}

test('region labels use positional order and refresh together with deselection and live geometry', () => {
  const [first, second] = selectTwoTargets()
  store.patchGroup({ coordinateSpace: 'viewport', targets: [second, first] })
  const labels = () => node('region-labels-layer').children
  assert.deepEqual(labels().map(el => [el.dataset.regionId, el.textContent]), [['target:heading', '1'], ['target:paragraph', '2']])
  assert.equal(labels()[0].style.left, '106px')
  assert.equal(labels()[0].style.top, '168px')
  liveRects.set('heading', { ...first.screenRect, y: 400 })
  window.dispatchEvent(new Event('scroll'))
  assert.deepEqual(labels().map(el => el.dataset.regionId), ['target:paragraph', 'target:heading'])
  dismissTarget('heading')
  assert.deepEqual(labels(), [], 'single remaining region does not need a number')
})

test('a numbered correction sends the shared screenshot/map and cannot recolor every selected object', async () => {
  const [first, second] = selectTwoTargets()
  store.patchGroup({ coordinateSpace: 'viewport', targets: [second, first] })
  let captured, submitted
  captureTask = async (_, options) => { captured = options.regions; return {} }
  modelTask = async payload => {
    submitted = payload
    return { model: 'test', intent: { ...concreteColor(), targets: [second], parameters: { color: '#ff0000' }, suggestion: { text: '将区域 2 改为红色，保留区域 1。', alternatives: [] } } }
  }
  typeInstruction('只把区域2改成红色，区域1保持不变')
  pressEnter(); for (let i = 0; i < 6; i++) await tick()
  assert.deepEqual(submitted.regions, captured)
  assert.deepEqual(submitted.regions.map(r => [r.number, r.targetIds]), [[1, ['heading']], [2, ['paragraph']]])
  assert.deepEqual(calls.map(call => call.type), ['model'], 'reference must not take the all-target local color shortcut')
  node('btn-inline-primary').dispatchEvent(new Event('click')); await tick()
  assert.deepEqual(calls.filter(call => call.type === 'color'), [{ type: 'color', targets: [second], color: '#ff0000' }])
})

test('each selected component gets a nearby accessible close control; clicking only narrows selection', async () => {
  const [first] = selectTwoTargets()
  const ink = store.getBrushState().group.strokes
  const previous = structuredClone(store.getBrushState().group)
  const buttons = node('target-controls-layer').children
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].style.left, '448px')
  assert.equal(buttons[0].style.top, '168px')
  assert.match(buttons[0]['aria-label'], /取消选中/)
  typeInstruction('改成红色')
  store.patchGroup({ status: 'previewing', preview: {} })
  dismissTarget('paragraph')
  assert.deepEqual(store.getBrushState().group.targets, [first])
  assert.equal(store.getBrushState().group.revision, previous.revision + 1)
  assert.equal(store.getBrushState().group.preview, null)
  assert.equal(store.getBrushState().group.strokes, ink)
  assert.equal(node('inline-custom-intent-input').value, '改成红色')
  assert.equal(node('target-controls-layer').children.length, 1)
  assert.equal(calls.length, 0, 'deselecting does not execute a page edit')
  assert.equal(store.patchGroupAnalysis(previous, { inferredIntent: { type: 'delete', targets: previous.targets } }), null)
  store.patchGroupAnalysis(store.getBrushState().group, { targets: previous.targets, excludedTargetIds: [] })
  assert.deepEqual(store.getBrushState().group.targets, [first])
  assert.deepEqual(store.getBrushState().group.excludedTargetIds, ['paragraph'])
  pressEnter()
  await tick()
  assert.deepEqual(calls, [{ type: 'color', color: '红色', targets: [first] }])
})

test('controls follow live scroll positions, and removing the last target cancels rather than inserting', () => {
  selectTwoTargets()
  liveRects.set('heading', { x: 100, y: 120, w: 360, h: 80 })
  window.dispatchEvent(new Event('scroll'))
  assert.equal(node('target-controls-layer').children[0].style.top, '108px')
  store.patchBrush({ mode: 'brush' })
  dismissTarget('paragraph')
  dismissTarget('heading')
  assert.equal(store.getBrushState().group, null)
  assert.equal(store.getBrushState().mode, 'brush')
  assert.equal(node('target-controls-layer').children.length, 0)
  assert.equal(node('inline-proposal').hidden, true)
  assert.equal(calls.length, 0)
})

test('additional strokes cannot accidentally re-add a manually excluded component', () => {
  const [, second] = selectTwoTargets()
  dismissTarget('heading')
  lassoCallbacks.onStart()
  assert.equal(node('target-controls-layer').children.length, 0)
  lassoCallbacks.onFinish([], { rawPoints: [{ x: 100, y: 200 }, { x: 200, y: 200 }], strokeId: 'new-line' })
  assert.deepEqual(store.getBrushState().group.targets, [second])
  assert.deepEqual(store.getBrushState().group.excludedTargetIds, ['heading'])
})

test('deselection during an in-flight submission prevents a late result from reselecting or applying', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const [first, second] = selectTwoTargets()
  let release
  modelTask = () => new Promise((resolve) => { release = resolve })
  typeInstruction('这个区域看起来柔和一点')
  pressEnter()
  await tick()
  assert.equal(typeof release, 'function')
  assert.equal(store.getBrushState().group.status, 'analyzing')
  dismissTarget('heading')
  release({ intent: { type: 'color', targets: [first, second], color: '红色', confidence: 1 } })
  await tick()
  assert.deepEqual(store.getBrushState().group.targets, [second])
  assert.equal(store.getBrushState().group.status, 'suggested')
  assert.equal(node('target-controls-layer').children.length, 1)
  assert.equal(calls.filter((call) => ['color', 'replace'].includes(call.type)).length, 0)
})

const concreteColor=()=>({type:'color',source:'model',targets:[target],confidence:.86,goal:'将标题调整为深蓝色',rationale:'与页面风格一致',strategy:'只修改标题前景色',parameters:{color:'#0a2540'},impact:{scope:'标题',riskLevel:'low'},suggestion:{text:'将标题调整为深蓝色',alternatives:[]},requiresConfirmation:true})

const wideLayout={x:0,y:0,w:1000,h:500},narrowLayout={x:0,y:0,w:700,h:500}
function startAnchoredGroup(plan) {
  layoutRects.set('page',wideLayout)
  const stroke=anchorBrushStroke({id:'anchored-ink',closed:true,shape:'box',points:[{x:800,y:80},{x:980,y:80},{x:980,y:380},{x:800,y:380},{x:800,y:80}]},{id:'page'},wideLayout)
  store.patchGroup({coordinateSpace:'web-document',strokes:[stroke],...(plan?{inferredIntent:plan}:{})})
  return stroke
}

test('sidebar/page-layout reflow preserves one in-flight analysis, semantic revision and progress clock',async()=>{
  let release,signal
  modelTask=async(_payload,options)=>{signal=options.signal;return new Promise(resolve=>{release=resolve})}
  startAnchoredGroup()
  typeInstruction('标题看起来沉稳一点，保留文字')
  pressEnter()
  await until(()=>calls.some(call=>call.type==='model'))
  const before=store.getBrushState().group
  layoutRects.set('page',narrowLayout);window.dispatchEvent(new Event('markset:page-layout'))
  const after=store.getBrushState().group
  assert.equal(signal.aborted,false,'opening the sidebar is not a new user gesture')
  assert.equal(after.revision,before.revision);assert.equal(after.status,before.status)
  assert.equal(after.analysisProgress.startedAt,before.analysisProgress.startedAt)
  assert.notDeepEqual(after.strokes[0].points,before.strokes[0].points,'ink still adapts to the page width')
  assert.equal(globalThis.testJournal.getEntries().length,1)
  release({model:'test',intent:concreteColor()})
  await until(()=>store.getBrushState().group?.status==='suggested'&&!store.getBrushState().group?.modelPending)
  assert.equal(calls.filter(call=>call.type==='model').length,1)
  assert.equal(globalThis.testJournal.getEntries()[0].status,'ready')
  assert.ok(calls.every(call=>call.type!=='color'))
})

const slot={x:800,y:80,w:180,h:300}
const positionalImagePlan=()=>({...concreteColor(),type:'insert',contentKind:'image',imagePrompt:'科研主题配图',
  parameters:{coordinateSpace:'web-document',bounds:{...slot}},insertion:{anchorId:'heading',placement:'position'},
  goal:'在框选空白处插入一张科研主题配图，保留标题',strategy:'将完整配图放入空白框中，保留原内容',suggestion:{text:'在空白框中补充科研配图，保留标题',alternatives:[]}})

test('a positional plan returned after sidebar resize is validated at the new slot, with no second analysis',async()=>{
  let release;const checks=[]
  startAnchoredGroup()
  modelTask=async()=>new Promise(resolve=>{release=resolve})
  verificationTask=async(plan,strokes)=>{checks.push({plan,strokes});return{ok:true,checks:['execution','undo']}}
  typeInstruction('在标记框中加一张相关配图，保留标题');pressEnter()
  await until(()=>calls.some(call=>call.type==='model'))
  layoutRects.set('page',narrowLayout);window.dispatchEvent(new Event('markset:page-layout'))
  const resizedInk=structuredClone(store.getBrushState().group.strokes)
  typeInstruction('正在分析时先记下这个补充，不要丢失')
  release({model:'test',intent:positionalImagePlan()})
  await until(()=>store.getBrushState().group?.status==='suggested'&&!store.getBrushState().group?.modelPending)
  const current=store.getBrushState().group
  assert.deepEqual(checks[0].plan.parameters.bounds,{x:560,y:80,w:126,h:300})
  assert.deepEqual(checks[0].strokes,resizedInk)
  assert.deepEqual(current.inferredIntent.parameters.bounds,checks[0].plan.parameters.bounds,'no double scaling on publication')
  assert.match(current.feedbackDraft,/补充/);assert.equal(calls.filter(call=>call.type==='model').length,1)
  assert.equal(calls.filter(call=>call.type==='generate-image').length,0,'the model result is still only a proposal')
})

test('sidebar reflow during image generation and final trial reuses one image and only reruns local validation',async()=>{
  let releaseImage,releaseCheck,checks=0
  const seen=[]
  startAnchoredGroup(positionalImagePlan())
  imageTask=async()=>new Promise(resolve=>{releaseImage=resolve})
  verificationTask=async(plan)=>{
    seen.push(structuredClone(plan));checks++
    if(checks===1)return new Promise(resolve=>{releaseCheck=resolve})
    return{ok:true,checks:['execution','undo']}
  }
  node('btn-inline-primary').dispatchEvent(new Event('click'))
  await until(()=>calls.some(call=>call.type==='generate-image'))
  layoutRects.set('page',narrowLayout);window.dispatchEvent(new Event('markset:page-layout'))
  assert.equal(store.getBrushState().group.applying,true);assert.equal(store.getBrushState().group.revision,1)
  releaseImage({imageUrl:'data:image/png;base64,same-asset',model:'offline-image',elapsedMs:20})
  await until(()=>checks===1)
  assert.deepEqual(seen[0].parameters.bounds,{x:560,y:80,w:126,h:300})
  layoutRects.set('page',{...wideLayout,w:900});window.dispatchEvent(new Event('markset:page-layout'))
  releaseCheck({ok:false,issues:[{code:'insertion-position-mismatch'}]})
  await until(()=>calls.some(call=>call.type==='insert'))
  assert.equal(checks,2);assert.equal(calls.filter(call=>call.type==='generate-image').length,1)
  assert.equal(calls.filter(call=>call.type==='model').length,0)
  const inserted=calls.find(call=>call.type==='insert').plan
  assert.deepEqual(inserted.parameters.bounds,{x:720,y:80,w:162,h:300})
  assert.equal(inserted.replacementText,'data:image/png;base64,same-asset')
})

test('sidebar movement during capture recaptures locally once and sends coherent new coordinates to one model request',async()=>{
  let captures=0,payload
  startAnchoredGroup()
  captureTask=async()=>{
    if(++captures===1){layoutRects.set('page',narrowLayout);window.dispatchEvent(new Event('markset:page-layout'));throw Object.assign(new Error('changed'),{code:'capture_page_changed'})}
    return{}
  }
  modelTask=async(value)=>{payload=value;return{model:'test',intent:concreteColor()}}
  typeInstruction('标题看起来沉稳一点，保留文字');pressEnter()
  await until(()=>store.getBrushState().group?.status==='suggested'&&!store.getBrushState().group?.modelPending)
  assert.equal(captures,2);assert.equal(calls.filter(call=>call.type==='model').length,1)
  assert.equal(payload.strokes[0].documentPoints[0].x,560)
  assert.equal(store.getBrushState().group.revision,1)
})

test('an unstable viewport is not a bad AI plan and cannot invoke an automatic paid repair',async()=>{
  let checks=0
  startAnchoredGroup(concreteColor())
  verificationTask=async()=>{
    checks++;layoutRects.set('page',checks===1?narrowLayout:wideLayout)
    window.dispatchEvent(new Event('markset:page-layout'));return{ok:true,checks:['execution','undo']}
  }
  node('btn-inline-primary').dispatchEvent(new Event('click'))
  await until(()=>checks===2&&!store.getBrushState().group?.applying)
  assert.equal(store.getBrushState().group.validation.issues[0].code,'layout-changing')
  assert.equal(calls.filter(call=>call.type==='model').length,0)
  assert.equal(calls.filter(call=>call.type==='color').length,0)
  assert.equal(store.getBrushState().group.strokes.length,1)
})

test('a goal-driven plan awaits confirmation, then applies once without another analysis or fixed menu',async()=>{
  modelTask=async()=>({model:'test',intent:concreteColor()})
  typeInstruction('标题看起来沉稳一点，保留文字')
  pressEnter();for(let i=0;i<6;i++) await tick()
  assert.equal(store.getBrushState().group.status,'suggested')
  assert.deepEqual(calls.map(call=>call.type),['model'])
  assert.equal(node('inline-proposal-alternatives').hidden,true)
  assert.equal(node('inline-custom-intent-input').value,'')
  node('btn-inline-primary').dispatchEvent(new Event('click'));await tick()
  assert.deepEqual(calls.map(call=>call.type),['model','color'])
  assert.equal(store.getBrushState().group,null)
})

test('choosing a concrete candidate applies exactly that plan instead of translating its label into a generic tool',async()=>{
  const candidate=concreteColor()
  store.patchGroup({inferredIntent:{type:'note',source:'model',needsClarification:true,clarifyingQuestion:'深蓝还是红色？',candidatePlans:[candidate],suggestion:{alternatives:[candidate.suggestion.text]}},selectedAlternative:candidate.suggestion.text.replace(/^将/u,'')})
  node('btn-inline-primary').dispatchEvent(new Event('click'));await tick()
  assert.deepEqual(calls,[{type:'color',targets:[target],color:'#0a2540'}])
  assert.equal(store.getBrushState().group,null)
})

test('a failed execution check sends specific evidence for one repair, preserves the goal, and never auto-applies',async(t)=>{
  let clock = 0
  t.mock.method(performance, 'now', () => clock)
  const original=verificationTask
  let checks=0
  verificationTask=async()=>{ clock+=10; return ++checks===1?{ok:false,issues:[{code:'page-horizontal-overflow',pixels:200}]}:{ok:true,checks:['execution','undo']} }
  let payloads=[]
  modelTask=async(payload)=>{clock+=30; payloads.push(payload);return{model:'test',intent:concreteColor(),timings:{modelRequests:1,upstreamMs:25,serverMs:30}}}
  try {
    typeInstruction('标题看起来沉稳一点，保留文字');pressEnter();for(let i=0;i<8;i++) await tick()
    assert.equal(payloads.length,2)
    assert.deepEqual(payloads[1].repairFeedback.issues,[{code:'page-horizontal-overflow',pixels:200}])
    assert.equal(payloads[1].userInstruction,payloads[0].userInstruction)
    assert.equal(payloads[1].retryBudget,2)
    assert.equal(store.getBrushState().group.inferredIntent.type,'color')
    assert.equal(calls.filter(call=>call.type==='color').length,0)
    const timing = globalThis.testJournal.getEntries().at(-1).timings
    assert.equal(timing.planMs,30); assert.equal(timing.repairMs,30); assert.equal(timing.verifyMs,20)
    assert.equal(timing.modelRequests,2); assert.equal(timing.upstreamMs,50)
  } finally {verificationTask=original}
})

test('a repaired retry consumes the draft so clicking Modify cannot repeat the same analysis',async()=>{
  store.patchGroup({analysisIssue:{message:'失败'},feedbackDraft:'保留文字，标题看起来沉稳一点'})
  modelTask=async()=>({model:'test',intent:concreteColor()})
  node('btn-inline-retry').dispatchEvent(new Event('click'));for(let i=0;i<6;i++) await tick()
  assert.equal(node('inline-custom-intent-input').value,'')
  node('btn-inline-primary').dispatchEvent(new Event('click'));await tick()
  assert.deepEqual(calls.map(call=>call.type),['model','color'])
})

test('a prior schema correction does not consume the remaining automatic layout repair',async()=>{
  let checks=0;const payloads=[]
  verificationTask=async()=>++checks===1 ? {ok:false,issues:[{code:'component-overflow',pixels:180}]} : {ok:true,checks:['execution','undo']}
  modelTask=async(payload)=>{payloads.push(payload);return {model:'test',intent:concreteColor(),repaired:true,repairsUsed:payloads.length===1 ? 1 : 2,retriesUsed:payloads.length===1 ? 1 : 0}}
  typeInstruction('标题看起来沉稳一点，保留文字');pressEnter();for(let i=0;i<12;i++)await tick()
  assert.equal(payloads.length,2);assert.equal(payloads[1].repairsUsed,1);assert.equal(payloads[1].retryBudget,1)
  assert.equal(store.getBrushState().group.planRepairsUsed,2);assert.equal(store.getBrushState().group.analysisIssue,null)
  assert.equal(calls.filter(call=>call.type==='color').length,0)
})

test('trial failures automatically correct at most twice and keep the input, strokes and concrete error',async()=>{
  const ink=[{id:'keep-ink',points:[{x:10,y:20},{x:30,y:20}]}]
  store.patchGroup({strokes:ink});const payloads=[]
  modelTask=async(payload)=>{payloads.push(payload);return{model:'test',intent:concreteColor()}}
  verificationTask=async()=>({ok:false,issues:[{code:'new-content-overlap'}]})
  typeInstruction('标题看起来沉稳一点，保留文字');pressEnter();for(let i=0;i<16;i++)await tick()
  assert.equal(payloads.length,3);assert.deepEqual(payloads.slice(1).map(payload=>payload.repairsUsed),[0,1])
  const group=store.getBrushState().group
  assert.equal(group.planRepairsUsed,2);assert.deepEqual(group.strokes,ink);assert.match(group.feedbackDraft,/沉稳/)
  assert.match(node('inline-error-message').textContent,/遮挡.*自动修复 2 次/)
  assert.equal(calls.filter(call=>call.type==='color').length,0)
})

test('minor trial warnings enable Modify without extra planning and appear in the UI and journal',async()=>{
  modelTask=async()=>({model:'test',intent:concreteColor()})
  verificationTask=async()=>planCheckReport([{code:'page-horizontal-overflow',pixels:9}],{checks:['execution','undo']})
  typeInstruction('标题看起来沉稳一点，保留文字');pressEnter();for(let i=0;i<8;i++)await tick()
  assert.equal(calls.filter(call=>call.type==='model').length,1)
  assert.equal(node('btn-inline-primary').disabled,false);assert.equal(node('inline-check-warning').hidden,false)
  assert.match(globalThis.testJournal.getEntries().at(-1).verification,/轻微提醒/)
  node('btn-inline-primary').dispatchEvent(new Event('click'));for(let i=0;i<3;i++)await tick()
  assert.equal(calls.filter(call=>call.type==='color').length,1)
})

test('apply-time validation automatically repairs the plan but requires fresh confirmation before applying',async()=>{
  store.patchGroup({inferredIntent:concreteColor(),customInstruction:'标题看起来沉稳一点，保留文字'})
  let checks=0;const payloads=[]
  verificationTask=async()=>++checks===1 ? {ok:false,issues:[{code:'component-overflow',pixels:200}]} : {ok:true,checks:['execution','undo']}
  modelTask=async(payload)=>{payloads.push(payload);return{model:'test',intent:concreteColor(),repairsUsed:1}}
  node('btn-inline-primary').dispatchEvent(new Event('click'));for(let i=0;i<14;i++)await tick()
  assert.equal(payloads.length,1);assert.equal(payloads[0].repairFeedback.issues[0].code,'component-overflow')
  assert.equal(calls.filter(call=>call.type==='color').length,0,'repair is not new apply authorization')
  assert.equal(store.getBrushState().group.planRepairsUsed,1);assert.equal(node('btn-inline-primary').disabled,false)
  node('btn-inline-primary').dispatchEvent(new Event('click'));for(let i=0;i<3;i++)await tick()
  assert.equal(calls.filter(call=>call.type==='color').length,1)
})

test('a broken undo engine or exhausted allowance cannot trigger more paid repairs at application',async()=>{
  for(const [code,used] of [['undo-mismatch',0],['component-overflow',2]]) {
    store.patchGroup({inferredIntent:concreteColor(),planRepairsUsed:used})
    verificationTask=async()=>({ok:false,issues:[{code,pixels:200}]})
    node('btn-inline-primary').dispatchEvent(new Event('click'));for(let i=0;i<5;i++)await tick()
    assert.equal(calls.filter(call=>call.type==='model').length,0)
    assert.equal(calls.filter(call=>call.type==='color').length,0)
    assert.equal(store.getBrushState().group.applying,false)
    assert.equal(node('inline-error-message').hidden,false)
  }
})

for(const issueCode of ['new-content-overlap','insertion-position-mismatch']) test(`apply-time ${issueCode} repair retains a generated image and never silently resubmits paid generation`,async()=>{
  const imagePlan={...concreteColor(),type:'insert',contentKind:'image',parameters:{},imagePrompt:'科研流程配图',insertion:{anchorId:'heading',placement:'after'},goal:'在标题下新增配图，保留原文',suggestion:{text:'在标题下新增配图，保留原文',alternatives:[]}}
  store.patchGroup({inferredIntent:imagePlan,customInstruction:'标题下加一张相关配图，保留文字'})
  let checks=0
  verificationTask=async()=>++checks===1 ? {ok:false,issues:[{code:issueCode}]} : {ok:true,checks:['execution','undo']}
  imageTask=async()=>({imageUrl:'data:image/png;base64,cached-fixture',model:'image-fixture',elapsedMs:20})
  modelTask=async(payload)=>{
    assert.equal(payload.repairFeedback.issues[0].code,issueCode)
    assert.equal(payload.repairFeedback.plan.replacementText,undefined,'generated bytes stay local')
    return{model:'test',intent:structuredClone(imagePlan),repairsUsed:1}
  }
  node('btn-inline-primary').dispatchEvent(new Event('click'))
  await until(()=>store.getBrushState().group?.status==='suggested' && !store.getBrushState().group?.modelPending && calls.some(call=>call.type==='model'))
  assert.equal(store.getBrushState().group.imageAssets.length,1)
  assert.equal(calls.filter(call=>call.type==='generate-image').length,1)
  assert.equal(calls.filter(call=>call.type==='insert').length,0)
  node('btn-inline-primary').dispatchEvent(new Event('click'));await until(()=>calls.some(call=>call.type==='insert'))
  assert.equal(calls.filter(call=>call.type==='generate-image').length,1,'next explicit confirmation reuses the original asset')
  assert.equal(calls.find(call=>call.type==='insert').plan.replacementText,'data:image/png;base64,cached-fixture')
})

test('a failed apply-time repair preserves previously consumed connection retries and never retries auth errors',async()=>{
  store.patchGroup({inferredIntent:concreteColor(),planRepairsUsed:1,analysisRetriesUsed:2})
  verificationTask=async()=>({ok:false,issues:[{code:'component-overflow',pixels:200}]})
  modelTask=async(payload)=>{
    assert.equal(payload.repairsUsed,1);assert.equal(payload.retryBudget,0)
    throw Object.assign(new Error('auth'),{code:'model_gateway_auth',status:401,retriesUsed:0})
  }
  node('btn-inline-primary').dispatchEvent(new Event('click'));for(let i=0;i<10;i++)await tick()
  assert.equal(calls.filter(call=>call.type==='model').length,1)
  assert.equal(store.getBrushState().group.analysisRetriesUsed,2)
  assert.equal(store.getBrushState().group.planRepairsUsed,2)
  assert.equal(store.getBrushState().group.analysisIssue.code,'model_gateway_auth')
})
