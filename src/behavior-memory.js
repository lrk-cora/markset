const STORAGE_KEY = 'markset-behavior-memory-v2'
const LEGACY_PREFERENCE_KEY = 'markset-user-preferences-v1'
const DB_NAME = 'markset-memory'
const STORE_NAME = 'snapshots'
const DB_VERSION = 1
const MAX_EVENTS = 120
const MAX_EPISODES = 40
const MAX_MEMORIES = 32

export const DEFAULT_BEHAVIOR_PROFILE = Object.freeze({
  clearIntentAction: 'direct',
  ambiguousMode: 'choices',
  textScope: 'marked-range',
  editStyle: 'minimal',
})

const PROFILE_KEYS = new Set(Object.keys(DEFAULT_BEHAVIOR_PROFILE))

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function now() {
  return Date.now()
}

function defaultState() {
  return {
    schemaVersion: 2,
    learningEnabled: true,
    profile: { ...DEFAULT_BEHAVIOR_PROFILE },
    overrides: {},
    learned: {},
    memories: [],
    episodes: [],
    events: [],
    updatedAt: now(),
  }
}

function validProfileValue(key, value) {
  const allowed = {
    clearIntentAction: ['direct', 'preview'],
    ambiguousMode: ['choices', 'input'],
    textScope: ['marked-range', 'text-object'],
    editStyle: ['minimal', 'preserve-layout'],
  }[key]
  return allowed?.includes(value) ? value : null
}

function normalize(raw) {
  const base = defaultState()
  if (!raw || typeof raw !== 'object') return base
  const next = { ...base, ...raw }
  next.schemaVersion = 2
  next.learningEnabled = raw.learningEnabled !== false
  next.profile = { ...DEFAULT_BEHAVIOR_PROFILE }
  for (const key of PROFILE_KEYS) {
    const value = validProfileValue(key, raw.profile?.[key])
    if (value) next.profile[key] = value
  }
  next.overrides = {}
  for (const key of PROFILE_KEYS) {
    const value = validProfileValue(key, raw.overrides?.[key]?.value || raw.overrides?.[key])
    if (value) next.overrides[key] = { value, source: 'user', updatedAt: Number(raw.overrides?.[key]?.updatedAt) || now() }
  }
  next.learned = {}
  for (const key of PROFILE_KEYS) {
    const item = raw.learned?.[key]
    const value = validProfileValue(key, item?.value || item)
    if (value) next.learned[key] = {
      value,
      confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0.72)),
      supportCount: Math.max(0, Number(item?.supportCount) || 0),
      updatedAt: Number(item?.updatedAt) || now(),
    }
  }
  next.memories = Array.isArray(raw.memories) ? raw.memories.slice(0, MAX_MEMORIES) : []
  next.episodes = Array.isArray(raw.episodes) ? raw.episodes.slice(0, MAX_EPISODES) : []
  next.events = Array.isArray(raw.events) ? raw.events.slice(0, MAX_EVENTS) : []
  next.updatedAt = Number(raw.updatedAt) || now()
  return next
}

function readBootstrap() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '')
    if (stored) return normalize(stored)
  } catch {}
  const migrated = defaultState()
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_PREFERENCE_KEY) || '')
    if (legacy && legacy.recording === false) migrated.learningEnabled = false
    if (Array.isArray(legacy?.items)) {
      migrated.memories = legacy.items.slice(0, MAX_MEMORIES).map((item, index) => ({
        id: item.id || `memory-legacy-${index}`,
        key: 'user.instruction',
        value: String(item.text || '').slice(0, 180),
        label: String(item.text || '').slice(0, 180),
        source: 'explicit',
        confidence: 1,
        supportCount: 1,
        conflictCount: 0,
        operation: String(item.operation || ''),
        createdAt: Number(item.createdAt) || now(),
        updatedAt: Number(item.createdAt) || now(),
      }))
    }
  } catch {}
  return migrated
}

let state = readBootstrap()
const listeners = new Set()

function emit() {
  for (const listener of listeners) listener(getBehaviorMemory())
}

function persist() {
  state.updatedAt = now()
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch {}
  mirrorToIndexedDb(state)
  emit()
}

function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch { resolve(null) }
  })
}

async function readIndexedSnapshot() {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get('current')
      request.onsuccess = () => resolve(request.result?.value || null)
      request.onerror = () => resolve(null)
    } catch { resolve(null) }
  })
}

async function mirrorToIndexedDb(value) {
  const db = await openDb()
  if (!db) return
  try {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put({ id: 'current', value: clone(value) })
  } catch {}
}

async function hydrate() {
  const snapshot = await readIndexedSnapshot()
  if (!snapshot || Number(snapshot.updatedAt) <= Number(state.updatedAt)) return
  state = normalize(snapshot)
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch {}
  emit()
}

void hydrate()

export function getBehaviorMemory() {
  return clone(state)
}

export function subscribeBehaviorMemory(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getEffectiveBehaviorProfile() {
  const profile = { ...DEFAULT_BEHAVIOR_PROFILE, ...state.profile }
  for (const key of PROFILE_KEYS) {
    if (state.learned[key]?.value) profile[key] = state.learned[key].value
    if (state.overrides[key]?.value) profile[key] = state.overrides[key].value
  }
  return profile
}

function profileLabel(key, value) {
  const labels = {
    clearIntentAction: { direct: '明确时直接执行', preview: '明确时先预览' },
    ambiguousMode: { choices: '优先给选择题', input: '优先让我输入' },
    textScope: { 'marked-range': '只改笔迹覆盖范围', 'text-object': '改整个文本对象' },
    editStyle: { minimal: '尽量少改动', 'preserve-layout': '优先保持原布局' },
  }
  return labels[key]?.[value] || value
}

export function getAgentBehaviorContext({ operation = '', targetKinds = [] } = {}) {
  const profile = getEffectiveBehaviorProfile()
  const profileSources = {}
  for (const key of PROFILE_KEYS) {
    profileSources[key] = state.overrides[key]
      ? 'user'
      : state.learned[key]
        ? 'observed'
        : 'default'
  }
  const requestedKinds = new Set((targetKinds || []).map(String).filter(Boolean))
  const activeMemories = state.memories
    .filter((item) => item?.status !== 'dismissed')
    .filter((item) => {
      if (item.source !== 'explicit' || !item.operation || !operation) return true
      return item.operation === operation
    })
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .slice(0, 8)
    .map((item) => ({
      key: item.key,
      value: item.value,
      label: item.label || profileLabel(item.key, item.value),
      source: item.source,
      confidence: item.confidence,
      supportCount: item.supportCount,
      operation: item.operation || '',
    }))
  const recentEpisodes = state.episodes
    .filter((item) => !operation
      || item.operation === operation
      || (requestedKinds.size && (item.targetKinds || []).some((kind) => requestedKinds.has(kind))))
    .slice(0, 6)
    .map((item) => ({
    operation: item.operation,
    gestureRoles: item.gestureRoles || [],
    targetKinds: item.targetKinds || [],
    targetCount: item.targetCount || 0,
    userChoice: item.userChoice || '',
    execution: item.execution || '',
    outcome: item.outcome || '',
    undone: Boolean(item.undone),
  }))
  return {
    profile,
    profileSources,
    memories: activeMemories,
    recentEpisodes,
    learningEnabled: state.learningEnabled,
  }
}

export function setBehaviorLearning(enabled) {
  state.learningEnabled = Boolean(enabled)
  persist()
}

export function setBehaviorPreference(key, value) {
  if (!PROFILE_KEYS.has(key)) return false
  const valid = validProfileValue(key, value)
  if (!valid) return false
  state.overrides[key] = { value: valid, source: 'user', updatedAt: now() }
  state.profile[key] = valid
  persist()
  return true
}

export function clearBehaviorOverrides() {
  state.overrides = {}
  state.learned = {}
  state.profile = { ...DEFAULT_BEHAVIOR_PROFILE }
  state.memories = state.memories.filter((item) => item.source !== 'observed')
  state.episodes = []
  state.events = []
  persist()
}

function compactEvent(event) {
  return {
    id: event.id || `event-${now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    type: String(event.type || 'unknown').slice(0, 50),
    operation: String(event.operation || '').slice(0, 40),
    gestureRoles: Array.isArray(event.gestureRoles) ? event.gestureRoles.slice(0, 6).map(String) : [],
    targetKinds: Array.isArray(event.targetKinds) ? event.targetKinds.slice(0, 6).map(String) : [],
    targetCount: Math.max(0, Number(event.targetCount) || 0),
    choice: String(event.choice || '').slice(0, 120),
    execution: String(event.execution || '').slice(0, 20),
    outcome: String(event.outcome || '').slice(0, 30),
    createdAt: now(),
  }
}

export function recordBehaviorEvent(event) {
  if (!state.learningEnabled) return false
  state.events = [compactEvent(event), ...state.events].slice(0, MAX_EVENTS)
  persist()
  return true
}

function updateLearnedPreference(key, value, episode) {
  if (!PROFILE_KEYS.has(key) || !value) return
  const observed = state.memories.filter((item) => item.key === key && item.source === 'observed')
  const previous = observed.find((item) => item.value === value)
  const opposingSupport = observed
    .filter((item) => item.value !== value)
    .reduce((sum, item) => sum + (Number(item.supportCount) || 0), 0)
  const next = previous || {
    id: `memory-${key}-${value}`,
    key,
    value,
    label: profileLabel(key, value),
    source: 'observed',
    confidence: 0.55,
    supportCount: 0,
    conflictCount: 0,
    createdAt: now(),
  }
  next.supportCount = Number(next.supportCount || 0) + 1
  next.conflictCount = opposingSupport
  const totalSupport = next.supportCount + opposingSupport
  next.confidence = Math.min(0.92, totalSupport ? next.supportCount / totalSupport : 0)
  next.updatedAt = now()
  next.lastEpisodeId = episode.id
  state.memories = [next, ...state.memories.filter((item) => item.id !== next.id)].slice(0, MAX_MEMORIES)
  if (next.supportCount >= 3 && next.confidence >= 0.72 && next.supportCount - next.conflictCount >= 2 && !state.overrides[key]) {
    state.learned[key] = {
      value,
      confidence: next.confidence,
      supportCount: next.supportCount,
      updatedAt: now(),
    }
  }
}

export function recordExplicitPreference({ text, operation = '' } = {}) {
  const value = String(text || '').trim().slice(0, 180)
  if (!value || !state.learningEnabled) return false
  const item = {
    id: `memory-explicit-${now().toString(36)}`,
    key: 'user.instruction',
    value,
    label: value,
    source: 'explicit',
    confidence: 1,
    supportCount: 1,
    conflictCount: 0,
    operation: String(operation || '').slice(0, 40),
    createdAt: now(),
    updatedAt: now(),
  }
  state.memories = [item, ...state.memories.filter((entry) => !(entry.key === item.key && entry.value === item.value))].slice(0, MAX_MEMORIES)
  persist()
  return true
}

export function recordEditEpisode(input = {}) {
  if (!state.learningEnabled) return false
  const episode = {
    id: input.id || `episode-${now().toString(36)}`,
    operation: String(input.operation || '').slice(0, 40),
    gestureRoles: Array.isArray(input.gestureRoles) ? input.gestureRoles.slice(0, 6).map(String) : [],
    targetKinds: Array.isArray(input.targetKinds) ? input.targetKinds.slice(0, 6).map(String) : [],
    targetCount: Math.max(0, Number(input.targetCount) || 0),
    userChoice: String(input.userChoice || '').slice(0, 120),
    execution: input.execution === 'preview' ? 'preview' : 'direct',
    outcome: String(input.outcome || 'applied').slice(0, 30),
    undone: Boolean(input.undone),
    createdAt: now(),
  }
  state.episodes = [episode, ...state.episodes].slice(0, MAX_EPISODES)
  state.events = [compactEvent({ ...episode, type: 'edit_episode' }), ...state.events].slice(0, MAX_EVENTS)
  if (episode.outcome === 'applied' && !episode.undone) {
    updateLearnedPreference('clearIntentAction', episode.execution === 'direct' ? 'direct' : 'preview', episode)
    if (input.textScope) updateLearnedPreference('textScope', input.textScope, episode)
  }
  persist()
  return episode
}

export function markLatestEpisodeUndone() {
  if (!state.learningEnabled || !state.episodes.length) return false
  const [latest, ...rest] = state.episodes
  state.episodes = [{ ...latest, undone: true, outcome: 'undone', updatedAt: now() }, ...rest]
  state.events = [compactEvent({ ...latest, type: 'edit_undone', outcome: 'undone' }), ...state.events].slice(0, MAX_EVENTS)
  persist()
  return true
}

export function removeMemory(id) {
  const next = state.memories.filter((item) => item.id !== id)
  if (next.length === state.memories.length) return false
  state.memories = next
  persist()
  return true
}

export function clearBehaviorMemories() {
  state.memories = state.memories.filter((item) => item.source !== 'observed')
  state.episodes = []
  state.events = []
  state.learned = {}
  persist()
}
