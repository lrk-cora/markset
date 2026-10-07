import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgentJournal, summarizeOperation, sanitizeAnalysisTimings } from '../src/agent-journal.js'

const group = { id: 'group1', revision: 2, strokes: [{ shape: 'circle', points: [{ x: 1, y: 2 }] }],
  targets: [{ kind: 'text', text: '这是被圈住的标题', dom: 'must not store DOM' }], screenshot: 'must not store screenshot' }
const plan = { type: 'color', goal: '把标题改成红色', suggestion: { text: '调整颜色', alternatives: [] } }

test('phase metrics remain view-only scalars; secrets and invalid metrics are never retained', () => {
  const timings = sanitizeAnalysisTimings({ captureMs: 42.8, verifyMs: -1, planMs: Infinity, repairMs: 'private',
    baseCacheHit: true, apiKey: 'must not store', payload: '<full DOM>', totalMs: 900 })
  assert.deepEqual(timings, { captureMs: 43, totalMs: 900, baseCacheHit: true })
  const journal = createAgentJournal(), id = journal.begin(group)
  journal.finish(id, { intent: plan, timings })
  assert.deepEqual(journal.getEntries()[0].timings, timings)
})

test('deadline diagnostics retain only an allowed phase and bounded scalar limit',()=>{
  const journal=createAgentJournal(),id=journal.begin(group)
  journal.finish(id,{issue:{code:'capture_timeout',message:'截图超时',timeoutPhase:'capture',timeoutMs:8000,apiKey:'do-not-store'}})
  assert.equal(journal.getEntries()[0].timeoutPhase,'capture');assert.equal(journal.getEntries()[0].timeoutMs,8000)
  assert.doesNotMatch(JSON.stringify(journal.getEntries()),/do-not-store/)
  journal.finish(id,{issue:{timeoutPhase:'<script>secret</script>',timeoutMs:Infinity}})
  assert.equal(journal.getEntries()[0].timeoutPhase,'');assert.equal(journal.getEntries()[0].timeoutMs,0)
})

test('per-attempt transport metrics are bounded, detached and exclude prompts, secrets and raw outputs',()=>{
  const attempt={request:1,attempt:2,elapsedMs:35_000,headersMs:17,firstOutputMs:23_000,lastProgressMs:34_000,
    status:200,succeeded:false,aborted:true,code:'model_stream_idle_timeout',timeoutSource:'local',timeoutStage:'idle',timeoutMs:15_000,
    apiKey:'PRIVATE',content:'PRIVATE',prompt:'PRIVATE',reasoning_content:'PRIVATE'}
  const journal=createAgentJournal(),id=journal.begin(group)
  journal.finish(id,{timings:{attempts:[attempt]},issue:{...attempt,message:'输出停滞'}})
  const entry=journal.getEntries()[0]
  assert.equal(entry.timeoutSource,'local');assert.equal(entry.timeoutStage,'idle')
  assert.equal(entry.timings.attempts[0].firstOutputMs,23_000);assert.equal(entry.timings.attempts[0].status,200)
  assert.doesNotMatch(JSON.stringify(entry),/PRIVATE|reasoning_content/)
  attempt.firstOutputMs=0;assert.equal(journal.getEntries()[0].timings.attempts[0].firstOutputMs,23_000)
  const bounded=sanitizeAnalysisTimings({attempts:Array(20).fill({timeoutSource:'<script>',timeoutStage:'PRIVATE',status:23,
    headersMs:-1,firstOutputMs:Infinity,lastProgressMs:'PRIVATE',elapsedMs:900_000,code:'PRIVATE'})})
  assert.equal(bounded.attempts.length,12);assert.deepEqual(bounded.attempts[0],{elapsedMs:180_000})
})

test('view-only journal summarizes strokes, targets, and instructions without retaining source data', () => {
  const journal = createAgentJournal()
  const id = journal.begin(group, { instruction: '颜色改成红色', localIntent: { type: 'note' } })
  const item = journal.getEntries()[0]
  assert.match(item.user, /1 个圈/u)
  assert.match(item.user, /标题/u)
  assert.match(item.user, /颜色改成红色/u)
  assert.doesNotMatch(JSON.stringify(item), /must not store|points|screenshot/u)
  assert.equal(item.status, 'pending')
  journal.finish(id, { intent: plan, modelIntent: plan, model: 'test', source: 'ai' })
  assert.equal(journal.getEntries()[0].summary, '把标题改成红色')
  assert.equal(journal.getEntries()[0].source, 'ai')
  assert.match(summarizeOperation({ strokes: [], targets: [] }), /空白/u)
})

test('fallback records the returned plan separately from the adopted plan and exposes a safe issue', () => {
  let clock = 1000
  const journal = createAgentJournal({ now: () => clock })
  const id = journal.begin(group)
  clock += 300
  journal.finish(id, { intent: { type: 'note', suggestion: { text: '选择修改方式' } }, modelIntent: { type: 'delete', goal: '删除标题' },
    issue: { code: 'model_invalid_plan', message: '方案未通过校验' }, source: 'fallback', rejected: true })
  const item = journal.getEntries()[0]
  assert.equal(item.elapsedMs, 300)
  assert.equal(item.modelSuggestion, '删除标题')
  assert.equal(item.summary, '选择修改方式')
  assert.equal(item.rejected, true)
  assert.equal(item.status, 'error')
})

test('cancelled requests do not mutate another record; clear cannot resurrect late results', () => {
  const journal = createAgentJournal()
  const first = journal.begin(group)
  journal.cancel(first)
  const second = journal.begin({ ...group, id: 'group2' })
  journal.finish(second, { intent: plan })
  assert.equal(journal.getEntries()[0].status, 'cancelled')
  assert.equal(journal.getEntries()[1].summary, plan.goal)
  journal.clear()
  assert.equal(journal.finish(first, { intent: plan }), false)
  assert.deepEqual(journal.getEntries(), [])
})

test('records are bounded, snapshots are detached and only notifications are emitted', () => {
  const journal = createAgentJournal({ maxEntries: 2 })
  let notifications = 0
  const unsubscribe = journal.subscribe(() => notifications++)
  for (let i = 0; i < 3; i++) journal.begin({ ...group, id: `group${i}` })
  assert.equal(journal.getEntries().length, 2)
  const data = journal.getEntries(); data[0].user = 'mutated'
  assert.notEqual(journal.getEntries()[0].user, 'mutated')
  assert.equal(notifications, 3)
  unsubscribe(); journal.clear(); assert.equal(notifications, 3)
})

test('execution and undo/redo reflect actions, not merely suggestions', () => {
  const journal = createAgentJournal()
  const id = journal.begin(group)
  journal.finish(id, { intent: plan })
  assert.equal(journal.getEntries()[0].execution, '')
  journal.execution(group.id, '已执行：变红')
  journal.undoLatest()
  assert.equal(journal.getEntries()[0].undone, true)
  journal.redoLatest()
  assert.equal(journal.getEntries()[0].execution, '已重做这次修改')
  journal.execution(group.id, '未执行', { failed: true })
  assert.equal(journal.undoLatest(), false)
})
