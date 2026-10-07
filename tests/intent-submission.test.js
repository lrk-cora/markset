import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { COLORS, colorFill } from '../src/colors.js'
import { inferCompleteColorPlan, inferLocalActionPlan, validateIntentPlan } from '../src/intent-plan.js'
import { bindIntentSubmission, finishIntentSubmission } from '../src/intent-submission.js'
import { getBrushState, startGroup, patchGroup, patchGroupAnalysis, clearGroup, resetBrushState } from '../src/brush-store.js'

const target = { webId: 'title-1', kind: 'text', text: '设计标题', context: { tag: 'h1' } }
const targets = [target]
const group = () => getBrushState().group
beforeEach(() => resetBrushState())

test('complete color commands have an executable plan without another question', () => {
  for (const instruction of ['改成红色', '颜色改为红色', '请把标题改成红色', '将标记对象改为红色', '把这些文字改成红色', '改成红']) {
    const plan = inferCompleteColorPlan(instruction, targets)
    assert.ok(plan, instruction)
    assert.equal(plan.type, 'color')
    assert.equal(plan.color, '红色')
    assert.equal(plan.needsInput, false)
    assert.equal(plan.needsClarification, false)
    assert.equal(plan.clarificationAlreadyAnswered, false)
    assert.deepEqual(plan.suggestion.alternatives, [])
    assert.equal(validateIntentPlan(plan, targets, instruction).actionable, true)
  }
})

test('fast path accepts actual executable palette names and exact hex, not arbitrary color words', () => {
  for (const { id, fill } of COLORS) {
    const plan = inferCompleteColorPlan(`设置为${id}`, targets)
    assert.ok(plan, id)
    assert.equal(colorFill(plan.color), fill)
  }
  assert.equal(inferCompleteColorPlan('改为 #FF0000', targets).color, '#ff0000')
  assert.equal(inferCompleteColorPlan('改成未知色', targets), null)
})

test('negation, multiple actions, vague colors and restricted scopes still require interpretation', () => {
  for (const instruction of ['不要改成红色', '能不能改成红色？', '改成红色或者黑色', '改成红色并居中', '把红色改成黑色', '背景改成红色', '只把第二个词改成红色', '改个颜色', '改成红色，其他地方不动']) {
    assert.equal(inferCompleteColorPlan(instruction, targets), null, instruction)
  }
  assert.equal(inferCompleteColorPlan('改成红色', []), null)
  assert.equal(inferCompleteColorPlan('改成红色', [{ ...target, kind: 'image' }]), null)
  assert.equal(inferCompleteColorPlan('改成红色', [{ ...target, webId: '' }]), null)
  assert.equal(inferCompleteColorPlan('把标题改成红色', [target, { ...target, webId: 'p1', context: { tag: 'p' } }]), null)
})

test('an explicit action discards obsolete clarification flags', () => {
  const plan = inferLocalActionPlan('颜色改为红色', {
    type: 'note', clarificationAlreadyAnswered: true, needsClarification: true,
    clarifyingQuestion: '请输入新的标题', needsInput: true,
  }, targets)
  assert.equal(plan.clarificationAlreadyAnswered, false)
  assert.equal(plan.needsClarification, false)
  assert.equal(plan.needsInput, false)
  assert.equal(plan.clarifyingQuestion, '')
})

function controls() {
  return Object.fromEntries(['primary', 'customSubmit', 'input'].map((key) => [key, Object.assign(new EventTarget(), { disabled: false, hidden: false })]))
}
function enter(input, props = {}) {
  const event = new Event('keydown', { cancelable: true })
  Object.assign(event, { key: 'Enter', ...props })
  input.dispatchEvent(event)
  return event
}

test('Enter and both modify buttons call exactly the same submit handler', () => {
  const ui = controls()
  let calls = 0
  const dispose = bindIntentSubmission(ui, () => calls++)
  assert.equal(enter(ui.input).defaultPrevented, true)
  ui.primary.dispatchEvent(new Event('click'))
  ui.customSubmit.dispatchEvent(new Event('click'))
  assert.equal(calls, 3)
  dispose()
  enter(ui.input)
  assert.equal(calls, 3)
})

test('IME confirmation, repeated Enter, disabled controls and mere typing do not submit', () => {
  const ui = controls()
  let calls = 0
  bindIntentSubmission(ui, () => calls++)
  for (const props of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { key: 'a' }]) {
    assert.equal(enter(ui.input, props).defaultPrevented, false)
  }
  ui.input.dispatchEvent(new Event('input'))
  ui.primary.disabled = true
  enter(ui.input)
  ui.customSubmit.dispatchEvent(new Event('click'))
  ui.primary.disabled = false
  ui.input.disabled = true
  enter(ui.input)
  assert.equal(calls, 0)
})

function submission(plan, options = {}) {
  const snapshot = startGroup({ id: 'group-a', revision: 1, strokes: [], targets, status: 'analyzing' })
  const calls = { model: 0, finish: 0, publish: 0 }
  const args = {
    snapshot, getCurrent: group, isCurrent: () => true,
    resolve: async () => { calls.model++ },
    publish: () => { calls.publish++; patchGroupAnalysis(snapshot, { inferredIntent: plan, status: 'suggested' }) },
    finish: () => { calls.finish++; clearGroup() },
    ...options,
  }
  return { args, calls }
}

test('submitting a complete red-color edit finishes once without calling the model', async () => {
  const plan = inferCompleteColorPlan('颜色改为红色', targets)
  const { args, calls } = submission(plan, { resolvedPlan: plan })
  assert.equal(await finishIntentSubmission(args), true)
  assert.deepEqual(calls, { model: 0, finish: 1, publish: 1 })
  assert.equal(group(), null)
  assert.equal(await finishIntentSubmission(args), false)
  assert.equal(calls.finish, 1)
})

test('explicit preview preference finishes in preview rather than applying', async () => {
  const plan = inferCompleteColorPlan('改成红色', targets)
  const { args, calls } = submission(plan, {
    resolvedPlan: plan,
    finish: () => patchGroup({ status: 'previewing', preview: { type: 'color' } }),
  })
  assert.equal(await finishIntentSubmission(args), true)
  assert.equal(group().status, 'previewing')
  assert.equal(calls.finish, 0)
})

test('a complete model plan finishes the original submission without a second confirmation', async () => {
  const plan = inferCompleteColorPlan('改成红色', targets)
  const { args, calls } = submission(null, {
    resolve: async () => patchGroup({ inferredIntent: plan, status: 'suggested' }),
  })
  assert.equal(await finishIntentSubmission(args), true)
  assert.equal(calls.publish, 0)
  assert.equal(calls.finish, 1)
})

test('missing parameters, unresolved ambiguity or a note do not execute', async () => {
  const base = inferCompleteColorPlan('改成红色', targets)
  for (const plan of [{ ...base, needsInput: true }, { ...base, needsClarification: true }, { ...base, type: 'note' }]) {
    const { args, calls } = submission(plan)
    assert.equal(await finishIntentSubmission(args), false)
    assert.equal(calls.finish, 0)
    assert.equal(group().status, 'suggested')
  }
})

test('an AI failure cannot silently apply a different local fallback plan', async () => {
  const plan = inferCompleteColorPlan('改成红色', targets)
  const { args, calls } = submission(null, {
    resolve: async () => patchGroup({ inferredIntent: { ...plan, source: 'local-fallback' }, status: 'suggested', analysisIssue: { code: 'model_gateway_upstream' } }),
  })
  assert.equal(await finishIntentSubmission(args), false)
  assert.equal(calls.finish, 0)
  assert.equal(group().status, 'suggested')
})

test('late analysis cannot publish or execute after new strokes, clearing or cancellation', async () => {
  const plan = inferCompleteColorPlan('改成红色', targets)
  for (const [mutate, cancel] of [
    [() => patchGroup({ revision: 2 }), false],
    [() => startGroup({ id: 'group-b', revision: 1, status: 'analyzing' }), false],
    [() => clearGroup(), false],
    [() => {}, true],
  ]) {
    let resume
    let active = true
    const { args, calls } = submission(plan, {
      resolve: () => new Promise((resolve) => { resume = resolve }),
      isCurrent: () => active,
    })
    const pending = finishIntentSubmission(args)
    mutate()
    active = !cancel
    resume()
    assert.equal(await pending, false)
    assert.equal(calls.publish, 0)
    assert.equal(calls.finish, 0)
  }
})
