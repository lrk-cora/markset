import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_PLAN_REPAIRS, planCheckReport, planIssueDescription, canRepairPlanReport, blockingPlanIssues, repairPlanEvidence, resultRepairCount } from '../src/plan-check-policy.js'
import { analysisIssue } from '../src/analysis-errors.js'
import { createAgentJournal } from '../src/agent-journal.js'

test('minor visible horizontal overhang and quality advisories do not block a reversible edit',()=>{
  const report=planCheckReport([{code:'page-horizontal-overflow',pixels:10},{code:'component-overflow',pixels:150,increasePixels:8},{code:'design-advisory'},{code:'content-quality-advisory'}])
  assert.equal(report.ok,true);assert.equal(report.warnings.length,4);assert.deepEqual(blockingPlanIssues(report),[])
  assert.equal(canRepairPlanReport(report),false,'cosmetic warnings do not spend paid repair calls')
})

test('real damage, clipping, overlap and unknown errors fail closed even if labeled warning',()=>{
  for(const code of ['page-horizontal-overflow','component-overflow','new-content-clipped','new-content-overlap','non-target-removed','non-target-text-changed','non-target-moved','non-target-attributes-changed','undo-mismatch','unknown-check']) {
    const report=planCheckReport([{code,pixels:30,severity:'warning'}])
    assert.equal(report.ok,false,code);assert.equal(report.errors[0].severity,'error',code)
  }
})

test('wrong insertion positions stop safely and never trigger an automatic model repair',()=>{
  for(const code of ['insertion-position-mismatch','insertion-position-unverified']) {
    const report=planCheckReport([{code,severity:'warning'}])
    assert.equal(report.ok,false)
    assert.equal(canRepairPlanReport(report),false)
    assert.match(report.errors[0].message,/指定的区域|实际位置/)
  }
})

test('existing overflow is compared by its measured increase; non-finite or missing measurements are not relaxed',()=>{
  assert.equal(planCheckReport([{code:'page-horizontal-overflow',pixels:1100,increasePixels:30}]).ok,false)
  for(const pixels of [undefined,NaN,Infinity,-1,0]) assert.equal(planCheckReport([{code:'component-overflow',pixels}]).ok,false)
})

test('many warnings cannot hide a critical issue and no validation result permits another paid design call',()=>{
  const report=planCheckReport([...Array.from({length:20},()=>({code:'design-advisory'})),{code:'non-target-removed'}])
  assert.equal(report.ok,false);assert.equal(report.errors.length,1);assert.equal(canRepairPlanReport(report),false)
  assert.equal(MAX_PLAN_REPAIRS,0)
  for(const code of ['undo-mismatch','verification-timeout','verification-failed','page-not-loaded']) assert.equal(canRepairPlanReport(planCheckReport([{code}])),false)
})

test('ineffective styling is a content/design advisory, but an unexplained failed verifier is not',()=>{
  const report=planCheckReport([{code:'inactive-layout-style',property:'flex-direction'}])
  assert.equal(report.ok,true);assert.equal(report.warnings.length,1)
  assert.equal(planCheckReport([],{ok:false}).ok,false)
})

test('failure message states a safe concrete cause and counts automatic repairs, not provider raw strings',()=>{
  const issue=analysisIssue({code:'agent_plan_invalid',status:422,repairsUsed:2,reason:'invalid-plan-json'})
  assert.match(issue.message,/格式不完整/);assert.match(issue.message,/已自动修复 2 次/)
  const clip=analysisIssue({code:'agent_plan_invalid',validation:planCheckReport([{code:'new-content-overlap',detail:'<script>secret-provider-key</script>'}])})
  assert.match(clip.message,/遮挡/);assert.doesNotMatch(clip.message,/script|secret/)
  assert.equal(planIssueDescription('batch:unknown-insertion-anchor'),'插入位置不存在')
  assert.equal(resultRepairCount({repaired:true}),1);assert.equal(resultRepairCount({repairsUsed:999}),2)
})

test('repair evidence omits paid generated image bytes without mutating the cached original plan',()=>{
  const plan={type:'batch',steps:[{type:'insert',contentKind:'image',imagePrompt:'科研配图',replacementText:'data:image/png;base64,private-image'},{type:'replace',replacementText:'新文案'}]}
  const evidence=repairPlanEvidence(plan)
  assert.equal(evidence.steps[0].replacementText,undefined);assert.equal(evidence.steps[1].replacementText,'新文案')
  assert.match(plan.steps[0].replacementText,/private-image/)
})

test('changing the viewport does not trigger a paid design repair or weaken verification',()=>{
  const report=planCheckReport([{code:'layout-changing'}])
  assert.equal(report.ok,false);assert.equal(canRepairPlanReport(report),false)
  assert.match(planIssueDescription(report.issues[0]),/布局.*变化/)
})

test('view-only journal explains warnings, exact failure and repairs without exposing raw details',()=>{
  const journal=createAgentJournal(),id=journal.begin({id:'test'})
  journal.finish(id,{repairsUsed:2,intent:{goal:'新增配图'},validation:planCheckReport([{code:'design-advisory'}],{checks:['execution']}),trace:[{stage:'verify',summary:'校验失败',issues:[{code:'new-content-clipped',detail:'private-text'}]}]})
  const entry=journal.getEntries()[0]
  assert.equal(entry.repairsUsed,2);assert.match(entry.verification,/轻微提醒/);assert.match(entry.stages[0],/裁切/)
  assert.doesNotMatch(JSON.stringify(entry),/private-text/)
})
