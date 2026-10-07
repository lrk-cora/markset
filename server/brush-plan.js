const operations = new Set(['reorder','replace','replace-image','delete','insert','color','style','move','note','batch'])
const clean = (value, max = 500) => String(value || '').trim().slice(0, max)
const list = (value) => Array.isArray(value) ? value : []
const cssColors = { red:'#ff0000', blue:'#0000ff', green:'#008000', black:'#000000', white:'#ffffff', gray:'#808080', grey:'#808080', yellow:'#ffff00', orange:'#ffa500', purple:'#800080', pink:'#ffc0cb' }
const strategies = { reorder:'保留内容，按方案调整标记对象的布局顺序。', color:'仅调整标记对象的颜色，保留内容和结构。', delete:'仅移除方案指定的对象或字符范围。', replace:'仅替换方案指定的文字范围。', 'replace-image':'保留图片位置与结构，按方案生成或编辑图片。', insert:'在指定锚点或位置插入内容，不替换已有内容。', batch:'按步骤整体应用，失败回滚，支持整组撤销。' }

// No geometry-dependent action rewriting here. Illegal references remain
// visible to the shared validator instead of silently becoming another action.
export function normalizeBrushPlan(raw, targets, fallback = {}, instruction = '', child = false) {
  const type = operations.has(raw.intentType) && !(child && raw.intentType === 'batch') ? raw.intentType : 'note'
  const ids = Array.isArray(raw.targetIds) ? raw.targetIds.map(String) : (fallback.targets || []).map((target) => String(target.webId))
  const selected = ids.map((id) => targets.find((target) => String(target.webId) === id) || { webId: id, kind: 'unknown' })
  const bounds = raw.bounds || fallback.parameters?.bounds || null
  // A selected object supplies context, not an implicit flow insertion command.
  // Preserve an explicit model rectangle when it did not choose a placement.
  const placement = ['inside-start','inside-end','before','after','position'].includes(raw.insertion?.placement)
    ? raw.insertion.placement : type === 'insert' && raw.bounds ? 'position' : ids.length ? 'after' : 'position'
  const insertion = { anchorId: clean(raw.insertion?.anchorId || (type === 'insert' && placement !== 'position' ? ids[0] : ''),128), placement }
  const contentKind = raw.contentKind === 'image' ? 'image' : raw.nodes?.length ? 'module' : 'text'
  const imagePrompt = clean(raw.imagePrompt, 2000)
  const imageMode = raw.imageMode === 'generate' ? 'generate' : 'edit'
  const replacementText = clean(raw.replacementText || (type === 'color' ? raw.color : ''), 4000)
  const sourceRanges = Array.isArray(raw.targetRanges) ? raw.targetRanges : []
  const needsInput = Boolean(raw.needsInput) && !replacementText && !imagePrompt && !raw.nodes?.length
  const plan = {
    type, operation: type, confidence: Math.max(0,Math.min(1,Number(raw.confidence)||0)), targets: selected,
    goal: clean(raw.goal || raw.suggestion), rationale: clean(raw.rationale || raw.reason || (child ? '执行本组已指定的局部修改步骤。' : '')), strategy: clean(raw.strategy || strategies[type]),
    constraints: list(raw.constraints).slice(0,8).map((value) => clean(value,160)),
    impact: { scope: clean(raw.impact?.scope || `${selected.length} 个标记对象`), riskLevel: raw.impact?.riskLevel || 'medium' },
    targetText: clean(raw.targetText,600), replacementText,
    targetRanges: ['delete','replace'].includes(type) ? sourceRanges : [],
    needsInput, needsClarification: Boolean(raw.needsClarification), clarifyingQuestion: clean(raw.clarifyingQuestion),
    contentKind, imagePrompt, imageMode, insertion,
    allowedAnchorIds: targets.map((target) => String(target.webId)),
    styles: Array.isArray(raw.styles) ? Object.fromEntries(raw.styles.map((item) => [item.property,item.value])) : raw.styles,
    nodes: raw.nodes?.map(normalizeNode),
    scopeExpansion: list(raw.scopeExpansion).map(String),
    requiresConfirmation: Boolean(raw.requiresConfirmation || raw.scopeExpansion?.length),
    desiredOutcome: raw.desiredOutcome || null,
    parameters: { direction: raw.direction || 'horizontal', order: raw.order || 'forward',
      targetOrder: raw.targetOrder || [], bounds, coordinateSpace: raw.coordinateSpace || fallback.parameters?.coordinateSpace || 'web-document',
      color: type === 'color' ? cssColors[clean(raw.color || replacementText).toLowerCase()] || clean(raw.color || replacementText) : '', insertion },
    suggestion: { text: clean(raw.suggestion || raw.goal || '请补充修改要求'),
      alternatives: list(raw.alternatives).filter((value) => typeof value === 'string' && !/保留为批注|不修改|取消/u.test(value)).slice(0,3) },
    recommendedAlternative: clean(raw.recommendedAlternative), source: 'model', hint: '',
  }
  if (type === 'batch') plan.steps = (Array.isArray(raw.steps) ? raw.steps : []).map((step) => normalizeBrushPlan(step, targets, fallback, instruction, true))
  const expanded = new Set([...(plan.scopeExpansion || []),...(plan.steps || []).flatMap((step)=>step.scopeExpansion || [])])
  if (expanded.size) plan.suggestion.text += `（会同时调整模块内 ${expanded.size} 个未单独标记的组件）`
  if (!child && raw.candidatePlans?.length) {
    plan.candidatePlans = raw.candidatePlans.slice(0,3).map((candidate)=>normalizeBrushPlan(candidate,targets,fallback,instruction,true))
    plan.suggestion.alternatives = plan.candidatePlans.map((candidate)=>candidate.suggestion.text || candidate.goal)
  }
  return plan
}

function normalizeNode(node) {
  return { ...node, styles: Array.isArray(node.styles) ? Object.fromEntries(node.styles.map((item) => [item.property,item.value])) : node.styles,
    children: node.children?.map(normalizeNode) }
}

export const brushPlanContract = `只输出完整 JSON。必填 intentType:reorder|replace|replace-image|delete|insert|color|style|move|batch|note，suggestion:一句结果摘要，rationale:一句短依据（不要内部推理），strategy:一句执行策略，targetIds:合法webId[]。其余字段仅在当前操作需要时填写，不输出无关字段或空字段：constraints:[]；impact:{scope,riskLevel:low|medium|high}；targetText；replacementText；targetRanges:[{targetId,start,end,expectedText}]；direction:horizontal|vertical；order:forward|reverse；targetOrder:明确顺序的webId[]；needsInput；needsClarification；clarifyingQuestion；alternatives:具体结果选项[]；recommendedAlternative。不预生成多个候选执行方案。
插入字段 contentKind:text|image，insertion:{anchorId:已标记对象或只读工具实际返回的相关模块webId,placement:inside-start|inside-end|before|after|position}，bounds:{x,y,w,h}（placement为position时必须填写，采用web-document坐标；即使有anchorId也不得省略）。选中对象允许内部或附近插入，不得要求清空选区。
用户画出了明确的图片框或空白位置时，使用placement:position并给出web-document坐标bounds；targetIds可用于上下文，不代表必须插在该对象后面。inside-end是模块内容末尾，不是模块右侧。若需两列布局，请组合style与insert步骤实现；不得仅在建议中承诺右侧位置、执行时却追加到模块底部。
图像字段 imagePrompt（具体绘制/编辑要求）、imageMode:generate|edit。insert+contentKind:image 是添加配图；replace-image+imageMode:edit 是修改原图，原图会真实传入图片模型；用户明确想换成全新内容则generate。不要要求用户给图片URL来替代生图。编辑多个原图时使用batch，每步一个原图，不得将基于一张原图的结果套用到其他不同图片。
多步骤修改用 intentType:batch，steps:[上述单步对象]（2-6步）；每一步目标必须合法，可整体撤销。圈/框仅确定范围，不能默认替换文字或删除。结合截图真实判断手势及对象关系；本地shape只是线索，不是必须服从的动作限制。
新增基础工具：style 使用 styles:[{property:CSS属性,value:CSS值}] 调整字体、间距、布局、配色等；move 使用 targetIds+insertion 移动真实节点；insert 可使用 nodes:[{tag,text,styles,attributes,children}] 创建继承页面风格的可编辑局部模块，不允许script、事件属性或任意CSS。多个基础工具可组合为batch（2-6步）。读取相关模块的节点可以用于内部插入；修改未选中的相关节点必须显式列出scopeExpansion，并在suggestion中说明扩展范围，requiresConfirmation=true。
分开输出 desiredOutcome:{effect,preserve,missingInformation}：最终呈现效果、必须保留的内容、真正缺失的用户信息。图片主题、布局、尺寸等一般由你根据页面设计，不是必须追问的信息。
能确定具体效果时直接给计划，只缺精确文案才needsInput；真正存在多个合理目标时提一个具体问题并给2-3个具体答案，不要给含糊工具菜单。用户明确动作不得反复问。`

const str = { type:'string' }, strings = { type:'array',items:str }
const object = (properties, required = Object.keys(properties)) => ({ type:'object',properties,required,additionalProperties:false })
const fields = {
  suggestion:str,
  intentType: { type:'string',enum:[...operations].filter((op)=>op!=='batch') },
  confidence:{type:'number'},goal:str,rationale:str,strategy:str,constraints:strings,
  impact:object({scope:str,riskLevel:{type:'string',enum:['low','medium','high']}}),
  targetIds:strings,targetText:str,replacementText:str,color:str,
  targetRanges:{type:'array',items:object({targetId:str,start:{type:'integer'},end:{type:'integer'},expectedText:str})},
  direction:{type:'string',enum:['horizontal','vertical']},order:{type:'string',enum:['forward','reverse']},targetOrder:strings,
  needsInput:{type:'boolean'},needsClarification:{type:'boolean'},clarifyingQuestion:str,alternatives:strings,recommendedAlternative:str,
  contentKind:{type:'string',enum:['text','image']},imagePrompt:str,imageMode:{type:'string',enum:['generate','edit']},
  insertion:object({anchorId:str,placement:{type:'string',enum:['inside-start','inside-end','before','after','position']}}),
  bounds:object({x:{type:'number'},y:{type:'number'},w:{type:'number'},h:{type:'number'}}),
  coordinateSpace:{type:'string',enum:['web-document','viewport']},
}
const stylesSchema = {type:'array',items:object({property:str,value:str})}
function nodeSchema(depth=0) { return object({tag:str,text:str,styles:stylesSchema,attributes:object({alt:str,title:str,href:str,src:str,type:str},[]),...(depth<2?{children:{type:'array',items:nodeSchema(depth+1)}}:{})},['tag']) }
Object.assign(fields,{ styles:stylesSchema,nodes:{type:'array',items:nodeSchema()},scopeExpansion:strings,requiresConfirmation:{type:'boolean'},desiredOutcome:object({effect:str,preserve:strings,missingInformation:strings}) })
const required = ['intentType','suggestion','rationale','strategy','targetIds']
const singleFields={...fields}
// Historical candidates still normalize; new requests only need one plan or
// lightweight clarification labels, not three prebuilt executions.
export const brushResponseFormat = { type:'json_schema',json_schema:{name:'markset_edit_plan',strict:true,
  schema:object({...fields,intentType:{type:'string',enum:[...operations]},steps:{type:'array',maxItems:6,items:object(singleFields,required)}},required)} }
