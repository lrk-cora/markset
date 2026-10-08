import { mkdirSync,writeFileSync,readFileSync,readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { STUDY_TASKS,studyTaskHtml,TASK_VERSION } from '../src/study-tasks.js'
import { RESEARCH_CONDITIONS,STUDY_VERSION } from '../src/research-conditions.js'
const hash = value => createHash('sha256').update(value).digest('hex')
mkdirSync('public/study/tasks',{recursive:true});mkdirSync('output/study',{recursive:true})
const tasks=STUDY_TASKS.map(task=>{
  const html=studyTaskHtml(task),path=`public/study/tasks/${task.id}.html`
  writeFileSync(path,html);return {...task,path,sha256:hash(html)}
})
writeFileSync('public/study/tasks/manifest.json',JSON.stringify({version:TASK_VERSION,tasks},null,2))
// Allowlist only source/documentation. Never enumerate or read environment,
// credentials, private assets, cache or study exports.
const files=['package.json','package-lock.json','index.html','src/styles.css','vite.config.js','playwright.config.js',
  ...['src','server','tests','scripts','docs/research'].flatMap(dir=>readdirSync(dir).filter(name=>/\.(?:js|mjs|md)$/u.test(name)).map(name=>`${dir}/${name}`)),
  ...readdirSync('tests/browser').filter(name=>name.endsWith('.js')).map(name=>`tests/browser/${name}`)]
const digest=Object.fromEntries(files.map(file=>[file,hash(readFileSync(file))]))
let gitHead=null
try{gitHead=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()}catch{}
const freeze={protocol:STUDY_VERSION,taskVersion:TASK_VERSION,gitHead,workingTreeDigest:hash(JSON.stringify(digest)),files:digest,conditions:RESEARCH_CONDITIONS,
  controls:{model:'configured Flash, actual model retained in analysis logs',autoAnalyze:false,automaticRepair:0,transportRetriesMax:2,personalHistory:false,fixedT1Image:true,taskOutcome:'independent scoring, never Apply alone'},
  note:'This hashes current working-tree sources, not a claim that Git HEAD contains uncommitted changes. After each code change regenerate and retain a new freeze manifest.'}
writeFileSync('output/study/freeze.json',JSON.stringify(freeze,null,2))
console.log(JSON.stringify({taskVersion:TASK_VERSION,taskPages:tasks.length,freeze:'output/study/freeze.json',workingTreeDigest:freeze.workingTreeDigest},null,2))
