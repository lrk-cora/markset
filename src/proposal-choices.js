const cleanChoice = (value) => String(value || '')
  .replace(/^(?:(?:你希望|你想|你是希望|你是想|请问|具体来说|是否)\s*)?(?:(?:把|将)\s*)?/u, '')
  .replace(/[“”"'。.!！?？\s]+$/gu, '')
  .trim()

// UI labels strip punctuation and introductory words. Resolve the exact plan
// using that same normalization, never infer an operation from label keywords.
export function candidateForChoice(intent,choice) {
  const normalized=cleanChoice(choice)
  const matches=(intent?.candidatePlans || []).filter(plan=>[plan.goal,plan.suggestion?.text].some(value=>cleanChoice(value)===normalized))
  return normalized && matches.length===1 ? matches[0] : null
}

// Annotation/no-op answers are not modification choices. The user can leave
// a mark without changing the page by clicking away, so these should never
// compete with an actual edit in the choice list.
export function isAnnotationChoice(value) {
  const text = cleanChoice(value).replace(/[：:]/gu, '').trim()
  if (!text) return true
  if (/^(?:取消|不操作|不修改|什么也不改|无需修改)$/u.test(text)) return true
  if (/(?:不修改|不改(?:动)?|不做修改|无需修改)/u.test(text)) return true
  if (/(?:取消|撤销|清除).{0,16}(?:此次|这次|当前)?(?:标记|批注|操作|修改)/u.test(text)) return true
  return /(?:保留|不修改|不改(?:动)?|不做修改|无需修改).{0,20}(?:批注|标注|注释|备注)/u.test(text)
    || /(?:批注|标注|注释|备注).{0,20}(?:保留|不改|仅)/u.test(text)
}

/** Extract two natural-language answers from a question such as “整段变红，还是只改标记部分？”. */
export function parseClarificationChoices(question) {
  const text = String(question || '').replace(/[？?。]+$/u, '').trim()
  if (!text) return []
  const match = text.match(/^(.+?)(?:[，,；;]\s*)?(?:还是|或者|抑或)\s*(.+)$/u)
  if (!match) return []
  const choices = [cleanChoice(match[1]), cleanChoice(match[2])].filter(Boolean)
  return choices.length === 2 && choices[0] !== choices[1] ? choices : []
}

/** Some “clarifications” are really requests for missing content, not choices. */
export function clarificationNeedsContent(intent) {
  if (!(intent?.needsClarification || intent?.type === 'note' || intent?.needsInput)) return false
  const question = String(intent?.clarifyingQuestion || '')
  return /(?:请|需要|还需要|还请)?\s*(?:提供|输入|填写|写下|给出|补充).{0,36}(?:替换|新.{0,12}(?:标题|文字|文案|内容)|完整.{0,12}(?:标题|文字|文案|内容)|(?:标题|文字|文案|内容|图片链接))/u.test(question)
    || /(?:缺少|还需要|需要).{0,18}(?:替换文字|新标题|新文案|具体内容|图片链接)/u.test(question)
}

export function formatClarificationAnswer(question, choice, details) {
  return [
    choice ? `针对“${String(question || '').trim()}”，我的选择是：${String(choice).trim()}` : '',
    details ? `补充的信息/具体要求：${String(details).trim()}` : '',
  ].filter(Boolean).join('\n')
}

export function wasClarificationAnswered(question, history = []) {
  const normalize = (value) => String(value || '').replace(/[\s，,。.!！?？；;：:、“”"']/gu, '').toLowerCase()
  const current = normalize(question)
  return Boolean(current && (history || []).some((item) => normalize(item) === current))
}

/** Always provide useful choices for a clarification, even if the model omitted alternatives. */
export function clarificationChoices(intent, fallbackTargets = []) {
  if (clarificationNeedsContent(intent)) return []
  const supplied = [...new Set((intent?.suggestion?.alternatives || [])
    .map(cleanChoice)
    .filter((choice) => choice && !isAnnotationChoice(choice)))]
  if (supplied.length >= 2) return [...new Set(supplied)].slice(0, 3)

  const fromQuestion = parseClarificationChoices(intent?.clarifyingQuestion)
    .filter((choice) => !isAnnotationChoice(choice))
  if (fromQuestion.length === 2) return fromQuestion
  // Never replace an Agent's actual design question with our generic menu.
  if (intent?.source === 'model') return supplied.slice(0,3)

  const targets = intent?.targets?.length ? intent.targets : fallbackTargets
  const kinds = new Set(targets.map((target) => target?.kind))
  const question = String(intent?.clarifyingQuestion || '')
  const isScopeQuestion = /范围|部分|整段|整句|全部|覆盖|标记/u.test(question)
  if (kinds.has('text') && (isScopeQuestion || kinds.size === 1)) {
    return ['只修改笔迹标记的文字部分', '修改整个文本对象']
  }
  if (kinds.has('image') && kinds.size === 1) {
    return ['更换这张图片', '删除这张图片']
  }
  return ['按笔迹标记范围修改', '修改整个选中对象']
}

export function recommendedClarificationChoice(intent, choices) {
  const list = Array.isArray(choices) ? choices : []
  const explicit = cleanChoice(intent?.recommendedAlternative)
  if (explicit && list.includes(explicit)) return explicit
  return list.find((choice) => /只|部分|局部|标记范围|笔迹覆盖|笔迹标记/u.test(choice)) || list[0] || ''
}
