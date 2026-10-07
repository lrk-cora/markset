export const analysisStageLabels = Object.freeze({
  preparing:'准备证据', planning:'AI 设计方案', observe:'AI 查证页面', draft:'AI 草拟建议',
  verify:'检查方案', repair:'修正方案', retry:'重试连接',
})

/** Publish a complete proposal only after validation, never a partial draft.
 * Legacy draft events are displayed as plain waiting, not as a suggestion. */
export function analysisProgressView(progress = {}, now = Date.now()) {
  progress ||= {}
  const stage = progress.stage === 'draft' ? 'planning' : analysisStageLabels[progress.stage] ? progress.stage : 'preparing'
  const seconds = Math.max(0,Math.floor((now-(Number.isFinite(progress.startedAt) ? progress.startedAt : now))/1000))
  const headline = ({
    preparing:'正在准备截图与页面结构…', planning:'正在生成完整修改建议…',
    observe:'正在读取相关模块，确定修改位置…', verify:'建议已生成，正在检查执行效果…',
    repair:'正在按检查结果修正方案…', retry:'连接暂时未完成，正在重试…',
  })[stage] || '正在生成修改方案…'
  return { stage, kind:`${analysisStageLabels[stage]} · ${seconds} 秒`, headline,
    detail:stage === 'verify' ? '正在检查格式与安全执行，网页尚未修改' : '完整方案返回后一次显示，网页尚未修改',
    button:stage === 'verify' ? '检查中…' : stage === 'repair' ? '修正中…' : '等待方案…',
  }
}
