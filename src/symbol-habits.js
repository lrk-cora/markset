import { SHAPE_LABELS } from './geometry.js'

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

export function habitForShape(shape) {
  const id = String(shape || '').trim()
  if (!id) return null
  return readAll().find((h) => h.shape === id) || null
}

export function shapeTitle(shape) {
  return SHAPE_LABELS[shape] || shape || '这个符号'
}

export function rememberSymbolHabit({ shape, intent, label, note, command, ask } = {}) {
  const id = String(shape || '').trim()
  const op = String(intent || '').trim()
  if (!id || !op || op === 'stamp' || (op === 'custom' && !label)) return null
  const next = {
    shape: id,
    intent: op,
    label: String(label || '').trim() || op,
    note: String(note || op).trim(),
    command: String(command || '').trim(),
    ask: String(ask || '').trim().slice(0, 40),
    count: 1,
    at: Date.now(),
  }
  const list = readAll().filter((h) => h.shape !== id)
  const prev = habitForShape(id)
  if (prev && prev.intent === op) next.count = (prev.count || 1) + 1
  writeAll([next, ...list])
  return next
}

export function forgetSymbolHabit(shape) {
  writeAll(readAll().filter((h) => h.shape !== shape))
}

export function habitGuess(habit, shape) {
  if (!habit) return null
  const title = shapeTitle(shape || habit.shape)
  return {
    id: habit.intent,
    label: `按习惯：${title} = ${habit.label}`,
    note: habit.note || habit.intent,
    command: habit.command || '',
    habit: true,
    shape: habit.shape,
  }
}
