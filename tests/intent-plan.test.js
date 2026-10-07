import test from 'node:test'
import assert from 'node:assert/strict'
import { hasExplicitAction, hasIntentConflict, inferLocalActionPlan, isDurablePreference, parseExplicitTextReplacement, validateIntentPlan } from '../src/intent-plan.js'

const text = { webId: 't1', kind: 'text', text: 'CPT certification' }
const card = { webId: 'c1', kind: 'card', text: 'Card one' }
const card2 = { webId: 'c2', kind: 'card', text: 'Card two' }
const image = { webId: 'i1', kind: 'image', text: '' }
const base = { confidence: 0.9, goal: '明确的页面结果', rationale: '符合用户要求且保留上下文', strategy: '局部、可逆地修改', impact: { scope: '选中对象', riskLevel: 'low' } }

test('parses explicit replacement into separate goal fields', () => {
  assert.deepEqual(parseExplicitTextReplacement('请把 CPT 改成 CPP', [text]), {
    targetText: 'CPT', replacementText: 'CPP', targets: [text], targetRanges: [{ targetId: 't1', start: 0, end: 3 }],
  })
})
test('a precise replacement instruction resolves the right target among a multi-target mark', () => {
  const matching = { ...text, text: 'Cpt certification' }
  const other = { webId: 't2', kind: 'text', text: '现有学生 35 人' }
  const parsed = parseExplicitTextReplacement('Cpt改为popt', [matching, other])
  const plan = {
    ...base, ...parsed, type: 'replace', operation: 'replace', needsInput: false,
    confidence: 0.95,
  }
  assert.equal(validateIntentPlan(plan, [matching, other], 'Cpt改为popt').actionable, true)
})
test('does not guess when target is absent or repeated', () => {
  assert.equal(parseExplicitTextReplacement('CPT 改成 CPP', [{ ...text, text: 'No match' }]), null)
  assert.equal(parseExplicitTextReplacement('CPT 改成 CPP', [text, { ...text, webId: 't2' }]), null)
})
test('does not mistake a color/style instruction for replacing the words', () => {
  assert.equal(parseExplicitTextReplacement('把标题改成红色', [{ ...text, text: '标题' }]), null)
  assert.equal(parseExplicitTextReplacement('把标题改成加粗', [{ ...text, text: '标题' }]), null)
})
test('detects an explicit negative constraint, not just positive verbs', () => {
  assert.equal(hasIntentConflict('我不想改文字，只想调整布局', 'replace'), true)
  assert.equal(hasIntentConflict('我不想改文字，只想调整布局', 'reorder'), false)
  assert.equal(hasIntentConflict('只调整布局，不要动图片', 'replace-image'), true)
  assert.equal(hasIntentConflict('请保留这些卡片，不要删除', 'delete'), true)
  assert.equal(hasIntentConflict('不要添加新的内容块', 'insert'), true)
})

test('does not convert vague feedback into an unrequested destructive edit', () => {
  assert.equal(hasExplicitAction('让这个页面看起来更高级', 'delete'), false)
  assert.equal(hasExplicitAction('这里内容太乱了', 'replace'), false)
  assert.equal(hasExplicitAction('Cpt改为popt', 'replace'), true)
  assert.equal(hasExplicitAction('请把这几个卡片横向排列', 'reorder'), true)
  assert.equal(hasExplicitAction('请换一张更符合主题的配图', 'replace-image'), true)
  const speculative = { ...base, type: 'delete', targets: [card] }
  assert.equal(validateIntentPlan(speculative, [card], '让这个页面看起来更高级').reason, 'action-not-explicitly-requested')
})

test('only explicit long-term language is eligible for preference memory', () => {
  assert.equal(isDurablePreference('以后默认只改布局，不改文字'), true)
  assert.equal(isDurablePreference('请记住我喜欢简洁的标题'), true)
  assert.equal(isDurablePreference('把这个标题改短一点'), false)
})
test('accepts a supported local reorder plan with rationale and direction', () => {
  const plan = { ...base, type: 'reorder', parameters: { direction: 'horizontal' }, targets: [card, card2] }
  assert.equal(validateIntentPlan(plan, [card, card2]).actionable, true)
})
test('accepts an explicit color edit without treating the color name as replacement copy', () => {
  const plan = { ...base, type: 'color', operation: 'color', color: '红色', parameters: { color: '红色' }, targets: [text] }
  assert.equal(validateIntentPlan(plan, [text], '把标题改成红色').actionable, true)
})
test('rejects target ids outside of the current marked page objects', () => {
  const plan = { ...base, type: 'delete', targets: [{ ...card, webId: 'foreign' }] }
  assert.equal(validateIntentPlan(plan, [card]).reason, 'unknown-target')
})
test('rejects a modification that contradicts the user instruction', () => {
  const plan = { ...base, type: 'replace', targetText: 'CPT', replacementText: 'CPP', targets: [text] }
  assert.equal(validateIntentPlan(plan, [text], '不要修改文字').reason, 'contradicts-user-instruction')
})
test('does not permit vague replacement without exact source and result', () => {
  const plan = { ...base, type: 'replace', needsInput: true, targetText: '', targets: [text] }
  assert.equal(validateIntentPlan(plan, [text]).reason, 'missing-replacement-spec')
})
test('requires clarification for high-impact unconfirmed plans', () => {
  const plan = { ...base, type: 'delete', targets: [card], impact: { scope: '整页内容', riskLevel: 'high' } }
  assert.equal(validateIntentPlan(plan, [card]).reason, 'high-risk-needs-clarification')
})
test('allows high-impact plans only as non-actionable clarification', () => {
  const plan = { ...base, type: 'note', needsClarification: true, clarifyingQuestion: '你要删除卡片还是隐藏它？', impact: { scope: '整页内容', riskLevel: 'high' }, targets: [card] }
  const checked = validateIntentPlan(plan, [card])
  assert.equal(checked.ok, true)
  assert.equal(checked.actionable, false)
  assert.equal(checked.reason, 'clarification-required')
})
test('rejects reordering a single target', () => {
  const plan = { ...base, type: 'reorder', parameters: { direction: 'horizontal' }, targets: [card] }
  assert.equal(validateIntentPlan(plan, [card]).reason, 'invalid-target-set')
})
test('requires a real insertion location instead of inventing one', () => {
  const plan = { ...base, type: 'insert', targets: [], needsInput: true }
  assert.equal(validateIntentPlan(plan, []).reason, 'invalid-target-set')
})
test('keeps an annotation-only plan non-destructive', () => {
  const plan = { type: 'note', goal: '保留为批注', confidence: 0.42, targets: [text] }
  const checked = validateIntentPlan(plan, [text])
  assert.equal(checked.ok, true)
  assert.equal(checked.actionable, false)
})

test('requires a concrete, page-aware strategy for every executable operation', () => {
  const weak = { ...base, type: 'delete', strategy: '', targets: [card] }
  assert.equal(validateIntentPlan(weak, [card]).reason, 'missing-strategy')
  const unscoped = { ...base, type: 'delete', impact: { riskLevel: 'low' }, targets: [card] }
  assert.equal(validateIntentPlan(unscoped, [card]).reason, 'missing-impact-scope')
})

test('accepts character ranges only when they stay inside the marked text', () => {
  const ranged = {
    ...base,
    type: 'delete',
    targets: [text],
    targetRanges: [{ targetId: 't1', start: 0, end: 3, expectedText: 'CPT' }],
  }
  assert.equal(validateIntentPlan(ranged, [text]).actionable, true)
  assert.equal(validateIntentPlan({ ...ranged, targetRanges: [{ targetId: 't1', start: 0, end: 4, expectedText: 'NOPE' }] }, [text]).reason, 'text-range-mismatch')
  assert.equal(validateIntentPlan({ ...ranged, targetRanges: [{ targetId: 't1', start: 0, end: 99 }] }, [text]).reason, 'text-range-out-of-bounds')
})

test('accepts a range-only replacement for a truncated text target', () => {
  const truncated = { ...text, text: '页面开头的一小段', textTruncated: true, textLength: 120 }
  const plan = {
    ...base,
    type: 'replace',
    targets: [truncated],
    targetText: '',
    replacementText: '新的词',
    needsInput: false,
    targetRanges: [{ targetId: 't1', start: 48, end: 51, expectedText: '旧词' }],
  }
  assert.equal(validateIntentPlan(plan, [truncated]).actionable, true)
})

test('turns an explicit delete answer into an executable offline plan', () => {
  const plan = inferLocalActionPlan('删除这些内容', {
    type: 'note',
    targets: [card],
    confidence: 0.5,
    parameters: {},
  }, [card])
  assert.equal(plan.type, 'delete')
  assert.equal(plan.needsInput, false)
  assert.equal(validateIntentPlan(plan, [card], '删除这些内容').actionable, true)
})

test('turns an explicit layout answer into an executable offline plan', () => {
  const plan = inferLocalActionPlan('把这几个卡片横向排列', {
    type: 'note',
    targets: [card, card2],
    confidence: 0.5,
    parameters: { hasArrow: true },
  }, [card, card2])
  assert.equal(plan.type, 'reorder')
  assert.equal(plan.parameters.direction, 'horizontal')
  assert.equal(validateIntentPlan(plan, [card, card2], '把这几个卡片横向排列').actionable, true)
})

test('keeps a selected text-replacement action editable until copy is supplied', () => {
  const plan = inferLocalActionPlan('替换文字内容', { type: 'note', targets: [text], confidence: 0.5 }, [text])
  assert.equal(plan.type, 'replace')
  assert.equal(plan.needsInput, true)
  assert.equal(validateIntentPlan(plan, [text], '替换文字内容').actionable, true)
})

test('the complete executable-plan contract covers every supported operation', () => {
  const plans = [
    { ...base, type: 'reorder', parameters: { direction: 'horizontal' }, targets: [card, card2] },
    { ...base, type: 'replace', targetText: 'CPT', replacementText: 'CPP', targets: [text] },
    { ...base, type: 'replace-image', needsInput: true, targets: [image] },
    { ...base, type: 'delete', targets: [card] },
    { ...base, type: 'insert', needsInput: true, parameters: { bounds: { x: 10, y: 20, w: 100, h: 80 } }, targets: [] },
  ]
  const targets = [card, card2, text, image]
  for (const plan of plans) assert.equal(validateIntentPlan(plan, targets).actionable, true, plan.type)
})

test('a clarification plan cannot be applied, even when it has candidate targets', () => {
  const plan = { ...base, type: 'delete', needsClarification: true, clarifyingQuestion: '删除还是移到别处？', targets: [card] }
  const checked = validateIntentPlan(plan, [card])
  assert.equal(checked.ok, true)
  assert.equal(checked.actionable, false)
})
