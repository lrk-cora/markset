import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STUDY_TASKS } from '../src/study-tasks.js'
const text = node => node?.textContent?.replace(/\s+/gu,' ').trim()
// A structural scoring aid, NOT an automatic aesthetic/semantic oracle. The
// evaluator separately judges overflow/readability and task appropriateness.
export function scoreStudyResult(taskId,html) {
  const task=STUDY_TASKS.find(t=>t.id===taskId)
  if (!task) throw Error('unknown-task')
  const doc=new JSDOM(html).window.document,$=id=>doc.getElementById(id)
  const color = key => $(key)?.style.color === 'rgb(34, 102, 255)' || $(key)?.style.color === '#2266ff'
  const baseline={title:task.title,description:task.description,action:'了解更多','other-title':`${task.title}概览`,'other-description':'此处为目标模块，保留原有内容。',decoy:`相似卡片 ${task.variant}`,card:`研究卡片 ${task.variant}`,existing:'已有卡片'}
  const unchanged=Object.entries(baseline).filter(([key])=> !(task.kind==='text-range'&&key==='description')).every(([key,value])=>text($(key))===value)
  let effect=false
  if(task.kind==='module-image') effect=$('description')?.nextElementSibling?.tagName==='IMG'&&$('description').nextElementSibling.nextElementSibling?.id==='action'
  if(task.kind==='move-card') effect=$('destination')?.firstElementChild?.id==='card'
  if(task.kind==='compound') effect=color('title')&&text($('other-description')?.nextElementSibling)==='补充信息'
  if(task.kind==='reference') effect=text($('destination')?.lastElementChild)==='主题总结'
  if(task.kind==='text-range') effect=text($('description'))===task.description.replace('初始阶段','准备阶段')
  if(task.kind==='simple-color') effect=color('title')&&!color('other-title')
  const report={task:task.id,version:task.version,structuralEffect:effect,originalTextPreserved:unchanged,structurePass:effect&&unchanged,visualQuality:null,overflow:null,independentReviewRequired:true}
  doc.defaultView.close();return report
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{if(!process.argv[2]||!process.argv[3]) throw Error('missing');console.log(JSON.stringify(scoreStudyResult(process.argv[2],readFileSync(process.argv[3],'utf8')),null,2))}
  catch{console.error('Usage: npm run study:score -- T1A path/to/exported-result.html (no raw contents printed)');process.exitCode=1}
}
