import test from 'node:test'
import assert from 'node:assert/strict'
import { analysisIssue } from '../src/analysis-errors.js'
import { runAnalysisTask } from '../src/analysis-task.js'

test('browser exception enums are not exposed as HTTP statuses or seconds',()=>{
  const issue=analysisIssue(new DOMException('private details','TimeoutError'))
  assert.equal(issue.code,'analysis_timeout');assert.equal(issue.status,0)
  assert.doesNotMatch(issue.message,/23|private/)
  assert.match(issue.message,/总时限/)
  assert.equal(analysisIssue(new DOMException('cancelled','AbortError')).status,0)
})

test('real HTTP status codes remain visible and upstream timeouts remain distinct',()=>{
  for(const status of [401,403,422,429,502,504])assert.equal(analysisIssue({status}).status,status)
  assert.equal(analysisIssue({code:'504'}).status,504)
  const upstream=analysisIssue({code:'model_gateway_timeout',status:504})
  assert.equal(upstream.code,'model_gateway_timeout');assert.match(upstream.message,/504/)
  for(const status of [0,23,600,10000,'secret'])assert.equal(analysisIssue({status}).status,0)
})

test('model timeout messages and metadata distinguish local wait, idle, total and provider errors',()=>{
  for (const [code,source,stage,word] of [
    ['model_first_output_timeout','local','connect','连接响应'],
    ['model_first_output_timeout','local','first-output','首次输出'],
    ['model_stream_idle_timeout','local','idle','输出中断'],
    ['model_total_timeout','local','total','总时限'],
    ['model_gateway_timeout','upstream','provider','上游接口'],
  ]) {
    const issue=analysisIssue({code,status:504,timeoutSource:source,timeoutStage:stage,timeoutMs:30_000,message:'PRIVATE'})
    assert.equal(issue.timeoutSource,source);assert.equal(issue.timeoutStage,stage)
    assert.match(issue.message,new RegExp(word));assert.doesNotMatch(issue.message,/PRIVATE/)
  }
  assert.equal(analysisIssue({timeoutSource:'PRIVATE',timeoutStage:'<script>'}).timeoutSource,undefined)
})

test('actual capture and verifier deadlines identify the local phase, not a failed model connection',async()=>{
  for(const [phase,code,word] of [['capture','capture_timeout','截图'],['verify','verification_timeout','检查'],['analysis','analysis_timeout','总时限']]) {
    let abortedSignal
    try {
      await runAnalysisTask(signal=>{abortedSignal=signal;return new Promise(()=>{})},{timeoutMs:5,timeoutPhase:phase})
      assert.fail('deadline must fire')
    } catch(error) {
      assert.equal(error.name,'TimeoutError');assert.equal(error.code,23)
      const issue=analysisIssue(error)
      assert.equal(issue.code,code);assert.equal(issue.status,0);assert.equal(issue.timeoutPhase,phase)
      assert.equal(issue.timeoutMs,5);assert.match(issue.message,new RegExp(word))
      assert.equal(abortedSignal.aborted,true)
    }
  }
})

test('nested work preserves the parent deadline identity without relabeling it as a capture deadline',async()=>{
  await assert.rejects(runAnalysisTask(signal=>runAnalysisTask(()=>new Promise(()=>{}),{signal,timeoutMs:1000,timeoutPhase:'capture'}),{timeoutMs:5}),error=>{
    assert.equal(analysisIssue(error).timeoutPhase,'analysis');assert.equal(error.timeoutMs,5);return true
  })
})
