import { SHAPE_LABELS, fingerprintsMatch, strokeFingerprint } from './geometry.js'

const KEY = 'markset-symbol-habits'

function readAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((h) => h && h.shape && h.intent) : []
  } catch {
    return []
  }
}

function writeAll(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 24)))
  } catch {
    /* ignore */
  }
}

export function listSymbolHabits() {
  return readAll()
}

export function listMarkFingerprints() {
  return readAll().map((h) => h.fingerprint).filter(Boolean)
}

export function habitForShape(shape) {
  const id = String(shape || '').trim()
  if (!id) return null
  return readAll().find((h) => h.shape === id) || null
}

export function habitForStroke(pts) {
  if (!pts?.length) return null
  const fp = strokeFingerprint(pts)
  if (!fp) return null
  const list = readAll()
  return (
    list.find((h) => h.fingerprint && fingerprintsMatch(fp, h.fingerprint)) ||
    list.find((h) => h.shape === `mark:${fp}`) ||
    null
  )
}

export function shapeTitle(shape, fallback = '') {
  if (SHAPE_LABELS[shape]) return SHAPE_LABELS[shape]
  if (String(shape).startsWith('mark:')) return fallback || '自定义标记'
  return fallback || shape || '这个符号'
}

export function shapeFromMarkName(name) {
  const t = String(name || '').trim()
  if (!t) return ''
  if (SHAPE_LABELS[t]) return t
  for (const [id, label] of Object.entries(SHAPE_LABELS)) {
    if (t === label || t.includes(label)) return id
  }
  if (/五角星|五芒星|星星|星号|\bstar\b/i.test(t)) return 'star'
  if (/三角|\btriangle\b/i.test(t)) return 'triangle'
  if (/[xX叉×✘✕✖]|叉号|打叉/.test(t)) return 'x'
  if (/勾|对勾|打钩|\bcheck\b/i.test(t)) return 'check'
  if (/下划|横线|\bunderline\b/i.test(t)) return 'line'
  if (/波浪|\bwavy\b/i.test(t)) return 'wavy'
  if (/箭头|\barrow\b/i.test(t)) return 'arrow'
  if (/小方|方框|\bbox\b/i.test(t)) return 'box'
  if (/圈|圆|\bcircle\b/i.test(t)) return 'circle'
  return ''
}

export function rememberSymbolHabit({ shape, intent, label, note, command, ask, fingerprint, scope } = {}) {
  const fp = String(fingerprint || '').trim()
  const id = String(shape || (fp ? `mark:${fp}` : '')).trim()
  const op = String(intent || '').trim()
  if (!id || !op || op === 'stamp' || (op === 'custom' && !label)) return null
  const all = readAll()
  const prev = habitForShape(id) || (fp ? all.find((h) => h.fingerprint && fingerprintsMatch(fp, h.fingerprint)) : null)
  const list = all.filter((h) => h.shape !== id && !(fp && h.fingerprint && fingerprintsMatch(fp, h.fingerprint)))
  const next = {
    shape: id,
    fingerprint: fp,
    intent: op,
    label: String(label || '').trim() || op,
    note: String(note || op).trim(),
    command: String(command || '').trim(),
    ask: String(ask || '').trim().slice(0, 40),
    scope: normalizeHabitScope(scope) || normalizeHabitScope(prev?.scope) || '',
    count: 1,
    at: Date.now(),
  }
  if (prev && prev.intent === op) next.count = (prev.count || 1) + 1
  writeAll([next, ...list.filter((h) => h !== prev)])
  return next
}

export const HABIT_SCOPE_OPTIONS = [
  { id: 'selection', label: '整个选区' },
  { id: 'marked', label: '画上标记的词' },
]

export function normalizeHabitScope(scope) {
  const id = String(scope || '').trim()
  if (id === 'marked' || id === 'word' || id === 'words') return 'marked'
  if (id === 'selection' || id === 'region' || id === 'all') return 'selection'
  return ''
}

export function habitScopeLabel(scope) {
  const id = normalizeHabitScope(scope)
  return HABIT_SCOPE_OPTIONS.find((o) => o.id === id)?.label || ''
}

export const HABIT_INTENT_OPTIONS = [
  { id: 'highlight', label: '高亮' },
  { id: 'bold', label: '加粗' },
  { id: 'underline', label: '下划线' },
  { id: 'wavy', label: '波浪线' },
  { id: 'strike', label: '删除线' },
  { id: 'delete', label: '删除' },
  { id: 'delete-image', label: '删图' },
  { id: 'delete-text', label: '删字' },
  { id: 'scale-down', label: '缩小' },
  { id: 'scale-up', label: '放大' },
  { id: 'color', label: '改颜色' },
  { id: 'generate-image', label: '换图 / 生图' },
  { id: 'shadow', label: '阴影' },
  { id: 'reflect', label: '倒影' },
  { id: 'frame', label: '加框' },
  { id: 'polish', label: '润色' },
  { id: 'move-layout', label: '挪位置' },
]

export function habitIntentLabel(intent) {
  const id = String(intent || '').trim()
  return HABIT_INTENT_OPTIONS.find((o) => o.id === id)?.label || id
}

export function updateSymbolHabit(shape, patch = {}) {
  const id = String(shape || '').trim()
  if (!id) return null
  const list = readAll()
  const prev = list.find((h) => h.shape === id)
  if (!prev) return null
  const intent = String(patch.intent || prev.intent || '').trim()
  if (!intent) return null
  const next = {
    ...prev,
    intent,
    label: String(patch.label ?? habitIntentLabel(intent) ?? prev.label).trim() || intent,
    note: String(patch.note ?? intent).trim(),
    command: patch.command === undefined ? prev.command || '' : String(patch.command || ''),
    ask: patch.ask === undefined ? prev.ask || '' : String(patch.ask || '').trim().slice(0, 40),
    scope: patch.scope === undefined ? normalizeHabitScope(prev.scope) : normalizeHabitScope(patch.scope),
    at: Date.now(),
  }
  writeAll([next, ...list.filter((h) => h.shape !== id)])
  return next
}

export function forgetSymbolHabit(shape) {
  writeAll(readAll().filter((h) => h.shape !== shape))
}

export function clearAllSymbolHabits() {
  writeAll([])
}

export function habitGuess(habit, shape) {
  if (!habit) return null
  const title = shapeTitle(shape || habit.shape, habit.ask)
  const scope = normalizeHabitScope(habit.scope)
  const where = habitScopeLabel(scope)
  return {
    id: habit.intent,
    label: where ? `按习惯：${title} = ${habit.label}（${where}）` : `按习惯：${title} = ${habit.label}`,
    note: habit.note || habit.intent,
    command: habit.command || '',
    habit: true,
    shape: habit.shape,
    scope,
  }
}
