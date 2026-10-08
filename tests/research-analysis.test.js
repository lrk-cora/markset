import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeResearchLog } from '../scripts/analyze-research-log.mjs'
test('descriptive analysis separates applied/censored trials, not inventing task accuracy',()=>{
  const base={session:'trial1',participant:'P01',trial:'T1A',condition:'ink-correction'}
  const log={version:1,events:[{...base,event:'input',at:100},{...base,event:'analysis-start',at:200},{...base,event:'analysis-end',at:1200,elapsedMs:1000,modelRequests:1,model:'fixture'},{...base,event:'correction',at:1500},{...base,event:'apply',at:2200,success:true},{...base,event:'undo',at:2300},{...base,session:'trial2',condition:'ink-no-correction',event:'input',at:3000},{...base,session:'trial2',condition:'ink-no-correction',event:'failure',at:6000}]}
  const report=analyzeResearchLog(log)
  assert.equal(report.trials.length,2);assert.equal(report.trials[0].inputToApplyMs,2100);assert.equal(report.trials[0].undos,1)
  assert.equal(report.conditions[0].medianAnalysisMs,1000);assert.equal(report.conditions[1].censoredTrials,1)
  assert.equal(report.conditions[1].medianInputToApplyMs,null);assert.equal(report.outcomeAccuracy,null)
})

test('a consented session stopped without input remains a censored trial in the denominator',()=>{
  const report=analyzeResearchLog({version:1,events:[{session:'empty',participant:'P01',trial:'T0',condition:'ink-no-correction',event:'session-start',at:100},{session:'empty',participant:'P01',trial:'T0',condition:'ink-no-correction',event:'session-stop',at:150}]})
  assert.equal(report.conditions[1].trials,1);assert.equal(report.conditions[1].censoredTrials,1)
})
test('a score collected before a later undo is stale, not a final successful outcome',()=>{
  const base={session:'s',participant:'P01',trial:'T1A',condition:'ink-correction'}
  const report=analyzeResearchLog({version:1,events:[{...base,event:'input',at:1},{...base,event:'apply',success:true,at:2},{...base,event:'outcome-score',rater:'R01',goalMet:true,at:3},{...base,event:'undo',at:4}]})
  assert.equal(report.trials[0].staleOutcomeScore,true);assert.equal(report.trials[0].independentlyScored,false);assert.equal(report.trials[0].goalMet,null)
})
