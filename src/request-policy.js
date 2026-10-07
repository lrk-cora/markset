export const MODEL_MAX_TOTAL_MS = 60_000
export const MODEL_CLIENT_TIMEOUT_MS = MODEL_MAX_TOTAL_MS + 10_000
export const IMAGE_MAX_TOTAL_MS = 180_000

const bounded = (value, fallback, min, max) => {
  const number = Number(value)
  return Math.max(min, Math.min(max, Number.isFinite(number) && number > 0 ? number : fallback))
}

export function modelRequestPolicy(env = {}) {
  const attemptTimeoutMs = bounded(env.MARKSET_MODEL_TIMEOUT_MS, 30_000, 8_000, 45_000)
  return {
    // Legacy name now means time until useful output, NOT the full stream.
    retries: 2, attemptTimeoutMs, firstOutputTimeoutMs: attemptTimeoutMs,
    idleTimeoutMs: bounded(env.MARKSET_MODEL_IDLE_TIMEOUT_MS, 15_000, 5_000, 30_000),
    timeoutMs: bounded(env.MARKSET_MODEL_TOTAL_TIMEOUT_MS, Math.min(MODEL_MAX_TOTAL_MS, attemptTimeoutMs * 3 + 2_000), attemptTimeoutMs, MODEL_MAX_TOTAL_MS),
  }
}

export function imageRequestPolicy(env = {}) {
  return {
    retries: 1,
    timeoutMs: bounded(env.MARKSET_IMAGE_TIMEOUT_MS, 120_000, 30_000, IMAGE_MAX_TOTAL_MS),
    // An outgoing header alone does not establish provider support.
    providerIdempotency: env.MARKSET_IMAGE_IDEMPOTENCY_SUPPORTED === '1',
  }
}
