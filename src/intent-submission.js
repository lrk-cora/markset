/** Enter and the visible button submit the same action; IME confirmation is not a submit. */
export function bindIntentSubmission({ primary, customSubmit, input, analysis }, submit, onAnalysis) {
  const onClick = () => {
    const button = analysis && !analysis.hidden && analysis.dataset?.action !== 'cancel' ? analysis : primary
    if (!button.disabled && !button.hidden) return submit()
  }
  const analyze = () => {
    if (analysis.disabled || analysis.hidden) return
    if (onAnalysis) return onAnalysis()
    return onClick()
  }
  const onKey = (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.repeat || input.disabled) return
    event.preventDefault()
    return onClick()
  }
  primary.addEventListener('click', onClick)
  customSubmit.addEventListener('click', onClick)
  analysis?.addEventListener('click', analyze)
  input.addEventListener('keydown', onKey)
  return () => {
    primary.removeEventListener('click', onClick)
    customSubmit.removeEventListener('click', onClick)
    analysis?.removeEventListener('click', analyze)
    input.removeEventListener('keydown', onKey)
  }
}

/** Resolve once and finish the submitted action, never a different/newer stroke group. */
export async function finishIntentSubmission({ snapshot, getCurrent, isCurrent, resolvedPlan, resolve, publish, finish }) {
  const current = () => {
    const group = getCurrent()
    return isCurrent() && group?.id === snapshot.id && group?.revision === snapshot.revision ? group : null
  }
  if (!current()) return false
  if (resolvedPlan) publish()
  else await resolve()
  if (current()?.status === 'analyzing') publish()
  const group = current()
  const plan = group?.inferredIntent
  // A failed AI request may still publish a usable local plan. Show the failure
  // and require a fresh confirmation instead of silently applying that fallback.
  if (group?.analysisIssue || group?.modelError) return false
  if (group?.status !== 'suggested' || !plan || plan.type === 'note' || plan.needsClarification || plan.needsInput) return false
  if (plan.source === 'model' && plan.requiresConfirmation) return false
  finish()
  return true
}
