export const analysisStageLabels = Object.freeze({
  preparing:'准备证据', planning:'AI 设计方案', observe:'AI 查证页面', draft:'AI 草拟建议',
  verify:'检查方案', repair:'修正方案', retry:'重试连接',
})

/** No invented percentages or pretend local suggestions. A streamed summary
 * is view-only until the complete plan passes the ordinary validators. */
export function analysisProgressView(progress = {}, now = Date.now()) {
  progress ||= {}
  const stage = analysisStageLabels[progress.stage] ? progress.stage : 'preparing'
  const seconds = Math.max(0,Math.floor((now-(Number.isFinite(progress.startedAt) ? progress.startedAt : now))/1000))
  const headline = progress.draftSummary || ({
    preparing:'正在准备截图与页面结构…', planning:'正在理解标注，设计修改方案…',
    observe:'正在读取相关模块，确定修改位置…', verify:'建议已生成，正在检查执行效果…',
    repair:'正在按检查结果修正方案…', retry:'连接暂时未完成，正在重试…',
  })[stage] || '正在生成修改方案…'
  return { stage, kind:`${analysisStageLabels[stage]} · ${seconds} 秒`, headline,
    detail:progress.draftSummary ? '草案 · 检查通过后可修改' : '可继续补充要求或绘制，网页尚未修改',
    button:stage === 'verify' ? '检查中…' : stage === 'repair' ? '修正中…' : '等待方案…',
  }
}
