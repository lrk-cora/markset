// Frozen synthetic task material. No participants or private imported pages.
export const TASK_VERSION = 'relational-tasks-v1'
export const STUDY_IMAGE = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" rx="12" fill="#e3ecfa"/><path d="M65 90h190" stroke="#2266ff" stroke-width="6"/><g fill="#fff" stroke="#2266ff" stroke-width="3"><rect x="30" y="60" width="70" height="60" rx="8"/><rect x="125" y="60" width="70" height="60" rx="8"/><rect x="220" y="60" width="70" height="60" rx="8"/></g><g fill="#2266ff"><circle cx="65" cy="90" r="10"/><circle cx="160" cy="90" r="10"/><circle cx="255" cy="90" r="10"/></g></svg>')
const goals = [
  ['module-image','保留原标题和说明，在说明后、按钮前插入一张固定测试图片。','wrong-object'],
  ['move-card','将源区的研究卡片移到目标区的开头，保留其他卡片与文字。','wrong-card'],
  ['compound','将左侧标题改为蓝色 #2266ff，同时在右侧说明后添加“补充信息”。其他内容保留。','wrong-region'],
  ['reference','左侧模块仅作主题参考，在右侧模块末尾补充“主题总结”；不得替换参考模块。','reference-write'],
  ['text-range','只把说明中的“初始阶段”替换为“准备阶段”，保留其他字符与标签。','whole-paragraph'],
  ['simple-color','只将左侧标题改为蓝色 #2266ff，右侧相似标题不变。','wrong-title'],
]
export const STUDY_TASKS = goals.flatMap(([kind,goal,error],index)=>['A','B'].map(variant=>({
  id:`T${index+1}${variant}`,pair:`T${index+1}`,kind,variant,goal,error,version:TASK_VERSION,
  title:variant==='A'?'模型训练':'城市观察',description:`${variant==='A'?'模型训练':'城市观察'}从初始阶段开始，保留这段完整说明。`,
})))
export function studyTaskHtml(task) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${task.id} 评估任务</title><style>body{font:18px system-ui;margin:40px;background:#f8f6f0;color:#17233a}main{display:grid;grid-template-columns:1fr 1fr;gap:32px;max-width:1100px}section{padding:26px;background:white;border:1px solid #d9deea;border-radius:16px}h1{font-size:32px}p{line-height:1.6}article{padding:18px;border:1px solid #dae1ef;margin:16px 0}img{max-width:100%;width:180px;height:100px;object-fit:contain;background:#e3ecfa}</style></head><body><main id="task-root" data-markset-study-task="${task.id}"><section id="source"><h1 id="title">${task.title}</h1><p id="description">${task.description}</p><button id="action">了解更多</button><article id="card">研究卡片 ${task.variant}</article><article id="decoy">相似卡片 ${task.variant}</article></section><section id="destination"><h1 id="other-title">${task.title}概览</h1><p id="other-description">此处为目标模块，保留原有内容。</p><article id="existing">已有卡片</article></section></main></body></html>`
}

// Only semantic fixture keys resolve to live known webIds. The wrong plan is
// displayed by an explicit researcher command, never applied automatically.
export function injectedStudyPlan(task, targets) {
  const target = key => targets.find(node => node.studyKey === key)
  const chosen = target(task.kind==='move-card'?'decoy':task.kind==='simple-color'||task.kind==='compound'?'other-title':task.kind==='text-range'?'description':'title')
  if (!chosen) return null
  // Same proposal contract as a model response; provenance is a separate,
  // explicit fixture field and display-only journal source. No model was called.
  const base = { source:'model',studyFixture:task.id,requiresConfirmation:true,confidence:0.8,targets:[chosen],scopeExpansion:[String(chosen.webId)],allowedAnchorIds:targets.map(t=>String(t.webId)),
    suggestion:{text:'这是预置的错误建议，请根据任务目标检查并纠正。',alternatives:[]},goal:'预置的错误建议',rationale:'固定的对象或范围误解',strategy:'只展示结构合法的局部方案，等待用户决定',impact:{scope:'冻结任务相关模块',riskLevel:'low'},parameters:{},needsInput:false,needsClarification:false }
  const summaries = { 'move-card':'把相似卡片移到右侧模块开头，保留其他内容。', 'simple-color':'将右侧概览标题改为蓝色，左侧标题不变。', compound:'仅将右侧概览标题改为蓝色，不添加其他内容。', 'text-range':'将整段说明替换为“新的完整内容”。', reference:'将左侧标题替换为“新的完整内容”。', 'module-image':'将原标题替换为“新的完整内容”，不插入图片。' }
  base.suggestion.text = summaries[task.kind]
  if (task.kind==='move-card') return target('destination') ? {...base,type:'move',insertion:{anchorId:String(target('destination').webId),placement:'inside-start'}} : null
  if (task.kind==='simple-color'||task.kind==='compound') return {...base,type:'color',parameters:{color:'#2266ff'}}
  return {...base,type:'replace',targetText:chosen.text,replacementText:'新的完整内容',targetRanges:[{targetId:String(chosen.webId),start:0,end:chosen.text.length}]}
}

// Only an explicit, consented session on its matching frozen T1 page uses
// fixed resources. Placement/styles/targets are not repaired or retargeted.
export function materializeStudyResources(plan, { condition, trial, mountedTask } = {}) {
  if (!condition || trial !== mountedTask || !STUDY_TASKS.some(t => t.id === trial && t.kind === 'module-image')) return plan
  const fixedNodes = nodes => nodes?.map(node => ({ ...node, ...(node.tag === 'img' ? { attrs: { ...node.attrs, src: STUDY_IMAGE } } : {}), ...(node.children ? { children: fixedNodes(node.children) } : {}) }))
  const hasImage = nodes => nodes?.some(node => node.tag === 'img' || hasImage(node.children))
  const fixed = step => {
    if (step.type !== 'insert' || step.contentKind !== 'image' && !hasImage(step.nodes)) return step
    const value = { ...step, ...(step.nodes ? { nodes: fixedNodes(step.nodes) } : {}) }
    if (step.contentKind === 'image') { value.replacementText = STUDY_IMAGE; delete value.imagePrompt }
    return value
  }
  if (plan.type !== 'batch') return fixed(plan)
  const steps = plan.steps.map(fixed)
  return steps.some((step,i)=>step!==plan.steps[i]) ? { ...plan, steps } : plan
}
