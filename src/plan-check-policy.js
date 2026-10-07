// Keep the first proposal. Validation never spends another model call, even
// for malformed output. Transport retries remain a separate bounded policy.
export const MAX_PLAN_REPAIRS = 0
export const MINOR_HORIZONTAL_OVERFLOW_PX = 12
// Read-only compatibility for records produced before repairs were disabled.
export const planRepairCount = value => Math.min(2, Math.max(0, Math.floor(Number(value) || 0)))
export const resultRepairCount = result => planRepairCount(result?.repairsUsed ?? (result?.repaired ? 1 : 0))

const descriptions = {
  'invalid-plan-json': 'AI 方案格式不完整',
  'mixed-read-and-submit': 'AI 把查证与提交方案混在同一步',
  'unknown-target': '修改目标已失效或不在允许范围',
  'invalid-target-set': '目标对象不支持这项修改',
  'missing-goal': 'AI 未说明修改目标',
  'missing-rationale': 'AI 方案缺少必要的目标依据',
  'missing-strategy': 'AI 未给出具体执行步骤',
  'missing-impact-scope': 'AI 未说明修改影响范围',
  'high-risk-needs-clarification': '方案影响较大，需明确确认范围',
  'contradicts-user-instruction': '方案与本次要求冲突',
  'missing-replacement-spec': '替换方案未明确原文或新内容',
  'unknown-insertion-anchor': '插入位置不存在',
  'invalid-insertion-bounds': '插入区域坐标无效',
  'invalid-insertion-placement': '插入方式无效',
  'missing-insertion-anchor': '缺少明确的插入锚点',
  'insertion-position-mismatch': '新增内容没有落在方案指定的区域',
  'insertion-position-unverified': '无法确认新增内容的实际位置',
  'invalid-move-anchor': '移动位置无效',
  'move-into-self': '不能把组件移动到它自己内部',
  'scope-expansion-not-disclosed': '方案扩大了修改范围但未说明',
  'repair-expanded-write-scope': '修复方案扩大了原修改范围',
  'repair-introduces-destructive-operation': '修复方案新增了未授权的删改',
  'non-target-removed': '方案会移除未要求删除的内容',
  'non-target-text-changed': '方案会改动需要保留的文字',
  'non-target-attributes-changed': '方案会改变范围外组件的属性',
  'non-target-moved': '方案会移动范围外组件',
  'page-horizontal-overflow': '修改会导致页面横向溢出',
  'component-overflow': '组件内容超出容器',
  'new-content-clipped': '修改后的内容被裁切',
  'new-content-overlap': '新增内容遮挡了已有内容',
  'inactive-layout-style': '布局属性在当前组件上不起作用',
  'undo-mismatch': '无法验证修改能完整撤销',
  'execution-failed': '方案无法由当前编辑工具执行',
  'verification-failed': '检查程序未能完成验证',
  'verification-timeout': '执行检查超时',
  'layout-changing': '网页布局仍在变化，请待侧栏或窗口稳定后重试',
  'page-not-loaded': '网页尚未加载完成',
  'invalid-text-range': '文字范围无效',
  'text-range-out-of-bounds': '文字范围超出原文',
  'text-range-mismatch': '目标文字与原文不一致',
  'source-text-not-in-target': '找不到要替换的原文',
  'selection-alone-does-not-authorize-deletion': '只有圈选证据，不能据此删除',
  'missing-concrete-plan-for-stated-goal': 'AI 未给出具体修改方案',
  'already-answered-clarification': 'AI 重复询问已回答的问题',
  'repair-limit-reached': '自动方案修复已达上限',
  'automatic-repair-disabled': '自动方案修复已关闭，请自行重新分析',
  'content-quality-advisory': '文案质量仍有优化空间',
  'design-advisory': '视觉效果仍有优化空间',
}

// Never echo arbitrary model/provider messages (which can include HTML, page
// copy or secrets). A known code is enough to explain the public failure.
export function planIssueDescription(issue = {}) {
  const code = String(typeof issue === 'string' ? issue : issue.code || '')
  return descriptions[code.replace(/^(?:batch:|invalid-candidate:)+/u, '')] || '方案参数或执行检查未通过'
}

export function planCheckReport(issues = [], extra = {}) {
  // Unknown issues fail closed. Only measured, minor geometry defects and
  // explicit quality advisories may be non-blocking; never lost text/scope.
  const checkedIssues = !issues.length && extra.ok === false ? [{code:'verification-failed'}] : issues
  const classified = checkedIssues.map(issue => {
    const delta = Number(issue.increasePixels ?? issue.pixels)
    const mildOverflow = ['page-horizontal-overflow', 'component-overflow'].includes(issue.code)
      && Number.isFinite(delta) && delta > 0 && delta <= MINOR_HORIZONTAL_OVERFLOW_PX
    const advisory = ['content-quality-advisory', 'design-advisory', 'inactive-layout-style'].includes(issue.code)
    const severity = mildOverflow || advisory ? 'warning' : 'error'
    return { ...issue, severity, message: planIssueDescription(issue) }
  })
  const errors = classified.filter(issue => issue.severity === 'error')
  const warnings = classified.filter(issue => issue.severity === 'warning')
  return { ...extra, ok: errors.length === 0, issues: classified, errors, warnings }
}

export const blockingPlanIssues = report => (report?.issues || []).filter(issue => issue.severity !== 'warning')
export function canRepairPlanReport() { return false }

// Generated images are retained locally. Do not resend their bytes or silently
// regenerate them during a plan repair; the next explicit apply can reuse them.
export function repairPlanEvidence(plan) {
  const copy = structuredClone(plan)
  for (const step of copy.type === 'batch' ? copy.steps || [] : [copy]) {
    if (step.imagePrompt && (step.type === 'replace-image' || step.contentKind === 'image')) delete step.replacementText
  }
  return copy
}
