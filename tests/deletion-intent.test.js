import test from 'node:test'
import assert from 'node:assert/strict'
import { inferCompleteActionPlan, inferCompleteDeletionPlan, inferLocalActionPlan, isEditInstruction, validateIntentPlan } from '../src/intent-plan.js'

const title = { webId: 'h1', kind: 'text', text: '从一个问题到一篇可投稿论文', context: { tag: 'h1' } }
const paragraph = { webId: 'p', kind: 'text', text: '保留其他内容', context: { tag: 'p' } }
const range = { targetId: 'h1', start: 3, end: 5, expectedText: '问题' }
const oldPlan = {
  type: 'replace', operation: 'replace_text', targets: [title], needsInput: true,
  needsClarification: true, clarifyingQuestion: '输入完整的新标题', replacementText: '旧回答',
  targetRanges: [range], parameters: { targetRanges: [range], hasRegion: true },
}

test('complete module removal clears old partial character hits and replacement questions', () => {
  for (const instruction of ['去掉这块内容', '请把这个模块删掉', '删除所选内容', '移除整个选中对象', '直接移除这些组件', '把整段文字删除吧', '删除']) {
    const plan = inferCompleteActionPlan(instruction, [title], oldPlan)
    assert.equal(plan?.type, 'delete', instruction)
    assert.deepEqual(plan.targets, [title])
    assert.deepEqual(plan.targetRanges, [])
    assert.deepEqual(plan.parameters, { deletionScope: 'object' })
    assert.equal(plan.needsInput, false)
    assert.equal(plan.needsClarification, false)
    assert.equal(plan.clarifyingQuestion, '')
    assert.equal(plan.replacementText, undefined)
    assert.equal(validateIntentPlan(plan, [title], instruction).actionable, true)
  }
})

test('explicit heading or image requests only use the appropriate selected objects', () => {
  const image = { webId: 'image', kind: 'image' }
  const card = { webId: 'module', kind: 'card' }
  assert.deepEqual(inferCompleteDeletionPlan('去掉这个标题', [paragraph, title]).targets, [title])
  assert.deepEqual(inferCompleteDeletionPlan('删除选中的图片', [title, image]).targets, [image])
  assert.deepEqual(inferCompleteDeletionPlan('移除这些模块', [card]).targets, [card])
  assert.equal(inferCompleteDeletionPlan('删除这个标题', [paragraph]), null)
  assert.equal(inferCompleteDeletionPlan('删除', []), null)
})

test('explicit character deletion preserves validated ranges instead of removing whole objects', () => {
  for (const instruction of ['只删除划线的文字', '删掉这几个字', '删除“问题”']) {
    const plan = inferCompleteActionPlan(instruction, [title, paragraph], oldPlan)
    assert.deepEqual(plan?.targets, [title], instruction)
    assert.deepEqual(plan.targetRanges, [range])
    assert.equal(plan.parameters.deletionScope, 'text-range')
  }
  const bare = inferCompleteDeletionPlan('删除', [title], { ...oldPlan, type: 'delete' })
  assert.deepEqual(bare.targetRanges, [range], 'bare confirmation of a text-strike proposal retains its range')
  assert.equal(inferCompleteDeletionPlan('只删除划线的文字', [title], {}), null)
})

test('unknown, stale, repeated, or unmarked character ranges cannot become whole-object removal', () => {
  for (const evidence of [
    { targetRanges: [{ ...range, targetId: 'outside' }] },
    { targetRanges: [{ ...range, end: 999 }] },
    { targetRanges: [{ ...range, expectedText: '过期' }] },
  ]) assert.equal(inferCompleteDeletionPlan('只删除划线的文字', [title], evidence), null)
  for (const instruction of ['删除“找不到”', '删除“问题”']) {
    assert.equal(inferCompleteDeletionPlan(instruction, [{ ...title, text: '问题和问题' }]), null)
  }
})

test('restrictions, negation, questions and compound requests never authorize deleting everything offline', () => {
  for (const instruction of ['不要删除这块内容', '不删除标题', '能不能删除这个模块？', '删除红色文字', '删除第2个卡片', '删除背景色', '隐藏这个模块', '删除标题并添加按钮', '去掉这块内容但保留图片', '删除“问题”还是移动它']) {
    assert.equal(inferCompleteActionPlan(instruction, [title], oldPlan), null, instruction)
    const fallback = inferLocalActionPlan(instruction, oldPlan, [title])
    if (fallback?.type === 'delete') assert.equal(validateIntentPlan(fallback, [title], instruction).actionable, false, instruction)
  }
})

test('a current correction is not literal replacement copy, and the shared resolver also handles exact replacement', () => {
  for (const text of ['去掉这块内容', '只删除第2个模块', '我不是想修改文本', '改成红色', '换张图片']) assert.equal(isEditInstruction(text), true)
  assert.equal(isEditInstruction('面向未来的研究实践'), false)
  const plan = inferCompleteActionPlan('把“问题”改成“想法”', [title], oldPlan)
  assert.equal(plan.type, 'replace')
  assert.equal(plan.replacementText, '想法')
  assert.equal(plan.needsClarification, false)
  assert.equal(plan.needsInput, false)
})
