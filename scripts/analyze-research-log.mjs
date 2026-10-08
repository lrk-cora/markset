import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { RESEARCH_CONDITIONS } from '../src/research-conditions.js'
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a,b)=>a-b), n = sorted.length
  return n ? n % 2 ? sorted[(n-1)/2] : (sorted[n/2-1]+sorted[n/2])/2 : null
}

// Descriptive pilot statistics only. A successful Apply is not evidence that
// the result matches the task: independent outcome scoring is still required.
export function analyzeResearchLog(log) {
  if (log?.version !== 1 || !Array.isArray(log.events)) throw Error('Unsupported research log')
  const byTrial = new Map()
  for (const event of log.events) {
    if (!Object.hasOwn(RESEARCH_CONDITIONS,event?.condition || '') || !Number.isFinite(event.at)
      || typeof event.session !== 'string' || typeof event.trial !== 'string' || !/^P\d{2,4}$/u.test(event.participant || '')) continue
    const key=JSON.stringify([event.session,event.participant,event.trial,event.condition])
    if (!byTrial.has(key)) byTrial.set(key,[])
    byTrial.get(key).push(event)
  }
  const trials=[...byTrial.values()].map(events=>{
    events.sort((a,b)=>a.at-b.at)
    const initial=events.find(event=>event.event==='input')
    const apply=events.filter(event=>event.event==='apply'&&event.success===true).at(-1)
    const analyses=events.filter(event=>event.event==='analysis-end'||event.event==='failure'&&Number.isFinite(event.modelRequests))
    const errorShown=events.find(event=>event.event==='error-shown')
    const recordedScore=events.filter(event=>event.event==='outcome-score').at(-1)
    const staleOutcomeScore=Boolean(recordedScore && events.some(event=>event.at>recordedScore.at && ['apply','undo'].includes(event.event)))
    const score=staleOutcomeScore ? null : recordedScore
    const undoneAfterApply=apply && events.some(event=>event.event==='undo'&&event.at>=apply.at)
    return {participant:events[0].participant,condition:events[0].condition,trial:events[0].trial,session:events[0].session,
      inputToApplyMs:initial&&apply&&apply.at>=initial.at?apply.at-initial.at:null,
      errorToApplyMs:errorShown&&apply&&apply.at>=errorShown.at?apply.at-errorShown.at:null,
      errorOnsetRecorded:Boolean(errorShown), finalApplyUndone:Boolean(undoneAfterApply),
      textSubmissions:events.filter(event=>event.event==='text-submit').length,
      textSupplements:events.filter(event=>event.event==='text-submit'&&event.supplement===true).length,
      independentlyScored:Boolean(score), staleOutcomeScore, rater:score?.rater || null, goalMet:score ? score.goalMet===true : null,
      preserved:score ? score.preserved===true : null, placementCorrect:score ? score.placementCorrect===true : null,
      noOverflow:score ? score.noOverflow===true : null,
      burden:score?.burden>=1&&score.burden<=7?score.burden:null, control:score?.control>=1&&score.control<=7?score.control:null,
      applied:Boolean(apply),censored:!initial||!apply,corrections:events.filter(event=>event.event==='correction').length,
      analysisStarts:events.filter(event=>event.event==='analysis-start').length,
      requestDispatches:events.filter(event=>event.event==='request-dispatched').length,
      modelRequests:analyses.reduce((sum,event)=>sum+Math.max(0,Number(event.modelRequests)||0),0),
      callsMayBeIncomplete:events.some(event=>event.event==='cancel') || events.filter(event=>event.event==='analysis-start').length>analyses.length,
      readToolCalls:analyses.reduce((sum,event)=>sum+Math.max(0,Number(event.readToolCalls)||0),0),
      medianEvidenceChars:median(analyses.map(event=>event.evidenceChars)),medianImageCount:median(analyses.map(event=>event.imageCount)),
      retries:analyses.reduce((sum,event)=>sum+Math.max(0,Number(event.retriesUsed)||0),0),
      failures:events.filter(event=>event.event==='failure').length,undos:events.filter(event=>event.event==='undo').length,
      models:[...new Set(analyses.map(event=>event.model).filter(Boolean))],
      medianAnalysisMs:median(analyses.map(event=>event.elapsedMs))}
  })
  const conditions=Object.keys(RESEARCH_CONDITIONS).map(condition=>{
    const rows=trials.filter(trial=>trial.condition===condition)
    return {condition,trials:rows.length,appliedTrials:rows.filter(row=>row.applied).length,censoredTrials:rows.filter(row=>row.censored).length,
      medianInputToApplyMs:median(rows.map(row=>row.inputToApplyMs)),medianAnalysisMs:median(rows.map(row=>row.medianAnalysisMs)),
      medianErrorToApplyMs:median(rows.map(row=>row.errorToApplyMs)), scoredTrials:rows.filter(row=>row.independentlyScored).length,
      goalMetTrials:rows.filter(row=>row.goalMet===true).length, unscoredTrials:rows.filter(row=>!row.independentlyScored).length,
      totalCorrections:rows.reduce((sum,row)=>sum+row.corrections,0),totalModelRequests:rows.reduce((sum,row)=>sum+row.modelRequests,0),totalFailures:rows.reduce((sum,row)=>sum+row.failures,0)}
  })
  return {version:1,descriptiveOnly:true,outcomeAccuracy:null,warning:'Apply/undo/latency are not task correctness, model accuracy or proof of a user benefit. Pair tasks and collect independent outcome scores before comparing conditions.',trials,conditions}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!process.argv[2]) { console.error('Usage: npm run research:analyze -- path/to/markset-research-events.json');process.exitCode=1 }
  else {
    try { console.log(JSON.stringify(analyzeResearchLog(JSON.parse(readFileSync(process.argv[2],'utf8'))),null,2)) }
    catch { console.error('无法读取有效的研究日志；未输出原始文件内容。');process.exitCode=1 }
  }
}
