import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { STUDY_TASKS,studyTaskHtml,injectedStudyPlan,materializeStudyResources,STUDY_IMAGE } from '../src/study-tasks.js'
import { scoreStudyResult } from '../scripts/score-study-result.mjs'
import { validateIntentPlan } from '../src/intent-plan.js'
test('twelve frozen variants have stable IDs, goals and no executable content',()=>{
  assert.equal(STUDY_TASKS.length,12)
  assert.equal(new Set(STUDY_TASKS.map(task=>task.id)).size,12)
  for(const task of STUDY_TASKS){
    const html=studyTaskHtml(task),dom=new JSDOM(html)
    assert.equal(dom.window.document.querySelectorAll('script,iframe').length,0)
    const report=scoreStudyResult(task.id,html)
    assert.equal(report.structurePass,false);assert.equal(report.originalTextPreserved,true);assert.equal(report.visualQuality,null)
    const targets=[...dom.window.document.querySelectorAll('[id]')].map(node=>({webId:node.id,studyKey:node.id,text:node.textContent,kind:node.matches('section,article,main')?'container':'text'}))
    const wrong=injectedStudyPlan(task,targets)
    assert.equal(validateIntentPlan(wrong,targets,'固定错误恢复测试').ok,true,task.id)
    dom.window.close()
  }
})
test('matching fixed image trials substitute only resources, not targets or placement; normal pages stay unchanged',()=>{
  const plan={type:'insert',contentKind:'image',imagePrompt:'example',targets:[{webId:'title'}],insertion:{anchorId:'description',placement:'after'}}
  assert.equal(materializeStudyResources(plan,{condition:null,trial:'T1A',mountedTask:'T1A'}),plan)
  assert.equal(materializeStudyResources(plan,{condition:'ink-correction',trial:'T1A',mountedTask:'T1B'}),plan)
  const fixed=materializeStudyResources(plan,{condition:'ink-correction',trial:'T1A',mountedTask:'T1A'})
  assert.equal(fixed.replacementText,STUDY_IMAGE);assert.equal(fixed.imagePrompt,undefined)
  assert.deepEqual(fixed.targets,plan.targets);assert.deepEqual(fixed.insertion,plan.insertion);assert.equal(plan.imagePrompt,'example')
})
test('structural scorer detects correct range replacement, wrong paragraph and missing original nodes',()=>{
  const task=STUDY_TASKS.find(t=>t.id==='T5A'),dom=new JSDOM(studyTaskHtml(task)),doc=dom.window.document
  doc.getElementById('description').textContent=task.description.replace('初始阶段','准备阶段')
  assert.equal(scoreStudyResult('T5A',dom.serialize()).structurePass,true)
  doc.getElementById('action').remove()
  assert.equal(scoreStudyResult('T5A',dom.serialize()).structurePass,false)
  dom.window.close()
})
