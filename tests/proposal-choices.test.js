import test from 'node:test'
import assert from 'node:assert/strict'
import { clarificationChoices, clarificationNeedsContent, formatClarificationAnswer, isAnnotationChoice, parseClarificationChoices, recommendedClarificationChoice, wasClarificationAnswered } from '../src/proposal-choices.js'

const heading = { webId: 'title-1', kind: 'text', text: 'Markset 项目标题' }

test('splits a Chinese clarification into clickable answers without requiring a comma', () => {
  const question = '整段标题都变红，还是只将星形笔迹覆盖的文字变红？'
  assert.deepEqual(parseClarificationChoices(question), [
    '整段标题都变红',
    '只将星形笔迹覆盖的文字变红',
  ])
  const choices = clarificationChoices({ type: 'note', needsClarification: true, clarifyingQuestion: question }, [heading])
  assert.deepEqual(choices, ['整段标题都变红', '只将星形笔迹覆盖的文字变红'])
  assert.equal(recommendedClarificationChoice({ recommendedAlternative: '只将星形笔迹覆盖的文字变红' }, choices), choices[1])
})

test('provides safe scope choices when a clarification question has no explicit alternatives', () => {
  const choices = clarificationChoices({
    type: 'note',
    needsClarification: true,
    clarifyingQuestion: '请确认要修改的范围。',
  }, [heading])
  assert.deepEqual(choices, ['只修改笔迹标记的文字部分', '修改整个文本对象'])
  assert.equal(recommendedClarificationChoice({}, choices), choices[0])
})

test('filters annotation-only answers and falls back to answer choices', () => {
  const choices = clarificationChoices({
    type: 'note',
    clarifyingQuestion: '我还不确定。',
    suggestion: { alternatives: ['保留为批注'] },
  }, [heading])
  assert.equal(choices.length, 2)
  assert.ok(choices.every((choice) => choice !== '保留为批注'))
})

test('filters annotation wording variants instead of matching one exact label', () => {
  assert.equal(isAnnotationChoice('保留标题，仅作为批注'), true)
  assert.equal(isAnnotationChoice('不修改，只做标注'), true)
  assert.equal(isAnnotationChoice('不修改，取消此次标记'), true)
  assert.equal(isAnnotationChoice('取消这次操作'), true)
  assert.equal(isAnnotationChoice('替换标题文字'), false)
  assert.deepEqual(clarificationChoices({
    type: 'note',
    needsClarification: true,
    suggestion: { alternatives: ['替换标题', '保留标题，仅作为批注'] },
  }, [heading]), ['只修改笔迹标记的文字部分', '修改整个文本对象'])
})

test('treats a request for replacement copy as an input step, not a scope-choice question', () => {
  const intent = {
    type: 'note',
    needsClarification: true,
    clarifyingQuestion: '请提供要替换成的完整主标题文字。',
    suggestion: { alternatives: [] },
  }
  assert.equal(clarificationNeedsContent(intent), true)
  assert.deepEqual(clarificationChoices(intent, [heading]), [])
  assert.equal(clarificationNeedsContent({ ...intent, type: 'replace', needsClarification: false, needsInput: false }), false)
})

test('keeps both the selected answer and typed details in one request', () => {
  assert.equal(
    formatClarificationAnswer('整段还是只改标记部分？', '只改标记部分', '新标题是“Markset 智能画笔”'),
    '针对“整段还是只改标记部分？”，我的选择是：只改标记部分\n补充的信息/具体要求：新标题是“Markset 智能画笔”',
  )
})

test('detects an already answered question despite punctuation differences', () => {
  assert.equal(wasClarificationAnswered('整段还是只改标记部分？', ['整段还是只改标记部分']), true)
  assert.equal(wasClarificationAnswered('要不要保留配图？', ['整段还是只改标记部分']), false)
})
