import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clearBehaviorMemories,
  clearBehaviorOverrides,
  DEFAULT_BEHAVIOR_PROFILE,
  getAgentBehaviorContext,
  getEffectiveBehaviorProfile,
  recordEditEpisode,
  setBehaviorLearning,
  setBehaviorPreference,
} from '../src/behavior-memory.js'

test('starts from an explicit, conservative behavior baseline', () => {
  clearBehaviorMemories()
  setBehaviorLearning(true)
  assert.deepEqual(getEffectiveBehaviorProfile(), DEFAULT_BEHAVIOR_PROFILE)
  assert.equal(getAgentBehaviorContext().learningEnabled, true)
})

test('learns a repeated successful interaction only after repeated evidence', () => {
  clearBehaviorMemories()
  setBehaviorLearning(true)
  for (let i = 0; i < 2; i += 1) recordEditEpisode({ operation: 'delete', execution: 'direct', outcome: 'applied' })
  assert.equal(getEffectiveBehaviorProfile().clearIntentAction, 'direct')
  recordEditEpisode({ operation: 'delete', execution: 'direct', outcome: 'applied' })
  const context = getAgentBehaviorContext()
  assert.equal(context.profile.clearIntentAction, 'direct')
  assert.ok(context.memories.some((item) => item.key === 'clearIntentAction' && item.supportCount >= 3))
})

test('manual preference overrides automatic learning', () => {
  clearBehaviorMemories()
  setBehaviorLearning(true)
  for (let i = 0; i < 3; i += 1) recordEditEpisode({ operation: 'delete', execution: 'direct', outcome: 'applied' })
  setBehaviorPreference('clearIntentAction', 'preview')
  assert.equal(getEffectiveBehaviorProfile().clearIntentAction, 'preview')
  assert.equal(getAgentBehaviorContext().profileSources.clearIntentAction, 'user')
  clearBehaviorOverrides()
  setBehaviorLearning(true)
  assert.equal(getEffectiveBehaviorProfile().clearIntentAction, 'direct')
  assert.equal(getAgentBehaviorContext().profileSources.clearIntentAction, 'default')
})

test('disabled learning does not collect new episodes', () => {
  clearBehaviorMemories()
  setBehaviorLearning(false)
  recordEditEpisode({ operation: 'delete', execution: 'direct', outcome: 'applied' })
  assert.equal(getAgentBehaviorContext().recentEpisodes.length, 0)
  setBehaviorLearning(true)
})
