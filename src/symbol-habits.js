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

export function rememberSymbolHabit({ shape, intent, label, note, command, ask, fingerprint } = {}) {
  const fp = String(fingerprint || '').trim()
  const id = String(shape || (fp ? `mark:${fp}` : '')).trim()
  const op = String(intent || '').trim()
  if (!id || !op || op === 'stamp' || (op === 'custom' && !label)) return null
  const next = {
    shape: id,
    fingerprint: fp,
    intent: op,
    label: String(label || '').trim() || op,
    note: String(note || op).trim(),
    command: String(command || '').trim(),
    ask: String(ask || '').trim().slice(0, 40),
    count: 1,
    at: Date.now(),
  }
  const list = readAll().filter((h) => h.shape !== id && !(fp && h.fingerprint && fingerprintsMatch(fp, h.fingerprint)))
  const prev = habitForShape(id) || (fp ? list.find((h) => fingerprintsMatch(fp, h.fingerprint)) : null)
  if (prev && prev.intent === op) next.count = (prev.count || 1) + 1
  writeAll([next, ...list.filter((h) => h !== prev)])
  return next
}

export function forgetSymbolHabit(shape) {
  writeAll(readAll().filter((h) => h.shape !== shape))
}

export function habitGuess(habit, shape) {
  if (!habit) return null
  const title = shapeTitle(shape || habit.shape, habit.ask)
  return {
    id: habit.intent,
    label: `按习惯：${title} = ${habit.label}`,
    note: habit.note || habit.intent,
    command: habit.command || '',
    habit: true,
    shape: habit.shape,
  }
}
