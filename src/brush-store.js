import { ping } from './store.js'

const listeners = new Set()
const PREFERENCE_KEY = 'markset-user-preferences-v1'

function readPreferences() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFERENCE_KEY) || '')
    return {
      recording: parsed?.recording !== false,
      items: Array.isArray(parsed?.items) ? parsed.items.slice(0, 20) : [],
    }
  } catch {
    return { recording: true, items: [] }
  }
}

let preferences = readPreferences()

function savePreferences() {
  try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preferences)) } catch {}
}

let state = {
  mode: 'browse',
  pageLoaded: false,
  group: null,
  history: [],
  preferences,
}

function emit() {
  for (const listener of listeners) listener(state)
  ping()
}

export function getBrushState() {
  return state
}

export function subscribeBrush(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function patchBrush(patch) {
  state = { ...state, ...patch }
  emit()
  return state
}

export function startGroup(group) {
  state = { ...state, group }
  emit()
  return group
}

export function patchGroup(patch) {
  if (!state.group) return null
  state = { ...state, group: { ...state.group, ...patch } }
  emit()
  return state.group
}

// Analysis owns interpretation only. It cannot replace the user's strokes,
// and a result for a previous group/revision cannot update the current group.
export function patchGroupAnalysis(snapshot, patch) {
  if (!state.group || state.group.id !== snapshot.id || state.group.revision !== snapshot.revision) return null
  const { strokes, id, revision, coordinateSpace, targets, excludedTargetIds, ...interpretation } = patch
  return patchGroup(interpretation)
}

export function clearGroup() {
  state = { ...state, group: null }
  emit()
}

export function addHistory(item) {
  state = { ...state, history: [item, ...state.history].slice(0, 12) }
  emit()
}

export function getPreferences() {
  return preferences
}

export function setPreferenceRecording(recording) {
  preferences = { ...preferences, recording: Boolean(recording) }
  savePreferences()
  state = { ...state, preferences }
  emit()
}

export function addPreference(item) {
  if (!preferences.recording || !item?.text) return false
  const text = String(item.text).trim().slice(0, 180)
  if (!text) return false
  const next = { id: `preference-${Date.now().toString(36)}`, text, operation: item.operation || '', createdAt: Date.now() }
  preferences = { ...preferences, items: [next, ...preferences.items.filter((entry) => entry.text !== text)].slice(0, 20) }
  savePreferences()
  state = { ...state, preferences }
  emit()
  return true
}

export function clearPreferences() {
  preferences = { ...preferences, items: [] }
  savePreferences()
  state = { ...state, preferences }
  emit()
}

export function resetBrushState() {
  state = { mode: 'browse', pageLoaded: false, group: null, history: [], preferences }
  emit()
}
