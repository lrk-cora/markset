// Separate from Agent journal, default OFF. Explicit consent each session;
// persist only whitelisted metadata, never page text, ink, images or prompts.
const KEY = 'markset.research-events.v1'
import { RESEARCH_CONDITIONS, STUDY_VERSION } from './research-conditions.js'
const CONDITIONS = Object.keys(RESEARCH_CONDITIONS)
const EVENTS = ['input', 'analysis-start', 'analysis-end', 'request-dispatched', 'correction', 'apply', 'failure', 'undo', 'cancel', 'suggestion-shown', 'error-shown', 'text-submit', 'outcome-score']
const FIELDS = ['revision', 'bindingRevision', 'regionCount', 'strokeCount', 'targetCount', 'elapsedMs', 'success', 'model', 'reason', 'operation', 'role', 'changedObject', 'changedRange', 'changedRelation', 'modelRequests', 'retriesUsed', 'verifyMs', 'captureMs', 'observationMs', 'modelMs', 'evidenceChars', 'imageCount', 'readToolCalls', 'inputChars', 'supplement', 'goalMet', 'preserved', 'placementCorrect', 'noOverflow', 'burden', 'control', 'rater', 'fixture', 'taskVersion']
export function createResearchLog({ storage = globalThis.localStorage, now = () => Date.now(), sessionId = () => globalThis.crypto.randomUUID() } = {}) {
  let active = null, records = [], error = '', stoppedAt = null
  try { const saved = JSON.parse(storage?.getItem(KEY) || 'null'); if (saved?.version === 1 && Array.isArray(saved.events)) records = saved.events.slice(-5000) } catch { error = '无法读取本地研究记录' }
  function persist() {
    records = records.slice(-5000)
    try { storage?.setItem(KEY, JSON.stringify({ version: 1, events: records })); error = '' }
    catch { error = '本地存储失败，请立即导出；当前记录仍保留在内存' }
  }
  return {
    start({ consent, condition = 'ink-correction', trial = 'pilot', participant = 'P00' } = {}) {
      if (consent !== true || !CONDITIONS.includes(condition) || !/^[a-zA-Z0-9_-]{1,48}$/u.test(trial) || !/^P\d{2,4}$/u.test(participant)) return { ok: false }
      if (active) records.push({...active,event:'session-stop',at:now()})
      active = { session: sessionId(), condition, trial, participant, protocol: STUDY_VERSION, startedAt: now() }; stoppedAt = null
      records.push({...active,event:'session-start',at:now()});persist();return { ok: true }
    },
    stop() { if (active) { records.push({...active,event:'session-stop',at:now()});persist() }; active = null; stoppedAt = now() },
    condition() { return active?.condition || null },
    session() { return active ? { ...active } : null },
    record(event, fields = {}) {
      if (!active || !EVENTS.includes(event)) return false
      const data = {}
      for (const key of FIELDS) if (Object.hasOwn(fields, key)) {
        const value = fields[key]
        // Never accept arbitrary diagnostic/provider prose as metadata.
        if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') data[key] = value
        else if (typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/u.test(value)) data[key] = value
      }
      records.push({ ...active, event, at: now(), ...data }); records = records.slice(-5000); persist(); return true
    },
    clear() { active = null; records = []; persist() },
    snapshot() { return { version: 1, active: Boolean(active), stoppedAt, error, events: records.map(record => ({ ...record })) } },
  }
}

export function initResearchPanel(log, { canStart = () => true, onChange = () => {} } = {}) {
  const $ = id => document.getElementById(id), status = $('research-status')
  const update = () => { const value = log.snapshot(); status.textContent = `${value.active ? '记录中（仅本地）' : '未记录'} · ${value.events.length} 条${value.error ? ` · ${value.error}` : ''}` }
  $('btn-research-start').addEventListener('click', () => {
    if (!canStart()) { status.textContent = '请先结束当前标记任务，再开始新的研究条件；不会清除你的笔迹'; return }
    const result = log.start({ consent: $('research-consent').checked, condition: $('research-condition').value, trial: $('research-trial').value, participant:$('research-participant').value })
    if (!result.ok) { status.textContent = '请先同意记录，并填写英文/数字任务编号'; return }
    for (const id of ['research-goal','research-preserved','research-placement','research-overflow']) $(id).checked = false
    $('research-burden').value = '0'; $('research-control').value = '0'
    update(); onChange()
  })
  $('btn-research-stop').addEventListener('click', () => { if (!canStart()) { status.textContent = '请先完成或取消当前任务，再停止记录；运行中不会切换条件'; return }; log.stop(); update(); onChange() })
  $('btn-research-clear').addEventListener('click', () => { if (!canStart()) { status.textContent = '请先完成或取消当前任务'; return }; if (!window.confirm('清空本机研究记录？请先导出备份。')) return; log.clear(); update(); onChange() })
  $('btn-research-error-shown').addEventListener('click', () => { log.record('error-shown', { fixture: false }); update() })
  $('btn-research-score').addEventListener('click', () => {
    if (!log.snapshot().active) return
    const rater = $('research-rater').value
    if (!/^R\d{2,4}$/u.test(rater)) { status.textContent = '请填写独立评分员编号 R01 等'; return }
    log.record('outcome-score', { rater, goalMet: $('research-goal').checked, preserved: $('research-preserved').checked,
      placementCorrect: $('research-placement').checked, noOverflow: $('research-overflow').checked,
      burden: Number($('research-burden').value), control: Number($('research-control').value) }); update()
  })
  $('btn-research-export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(log.snapshot(), null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'markset-research-events.json'; link.click(); URL.revokeObjectURL(url)
  })
  update(); return { update }
}
