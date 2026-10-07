// Raw ink is immutable. Responsive layout is a projection of that ink onto
// the same page objects, never a new gesture or a new selection.
export function validLayoutRect(rect) {
  return rect && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(rect[key])) && rect.w > 0 && rect.h > 0
}

export function mapLayoutPoint(point, from, to) {
  return { x: to.x + (point.x - from.x) * to.w / from.w, y: to.y + (point.y - from.y) * to.h / from.h }
}

function sameRect(a, b) {
  return validLayoutRect(a) && validLayoutRect(b) && ['x', 'y', 'w', 'h'].every((key) => Math.abs(a[key] - b[key]) < 0.1)
}

export function anchorBrushStroke(stroke, reference, rect) {
  if (!validLayoutRect(rect)) return stroke
  return { ...stroke, layoutAnchor: {
    reference, originalRect: { ...rect }, currentRect: { ...rect },
    originalPoints: (stroke.points || []).map((point) => ({ ...point })),
  } }
}

function pointBounds(points) {
  if (!points?.length) return null
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y)
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

function relocatePlan(plan, changes, targets) {
  if (!plan) return plan
  const bounds = plan.parameters?.bounds
  let parameters = plan.parameters
  if (bounds && parameters.coordinateSpace === 'web-document') {
    const center = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }
    // Each gesture has its own anchor; do not warp all insertions against the
    // last selected object in a multi-stroke group.
    const nearest = [...changes].sort((a, b) => {
      const distance = (change) => {
        const box = pointBounds(change.before.points)
        return box ? Math.hypot(center.x - box.x - box.w / 2, center.y - box.y - box.h / 2) : Infinity
      }
      return distance(a) - distance(b)
    })[0]
    const from = nearest.before.layoutAnchor.currentRect
    const to = nearest.after.layoutAnchor.currentRect
    const origin = mapLayoutPoint(bounds, from, to)
    parameters = { ...parameters, bounds: { ...bounds, ...origin, w: bounds.w * to.w / from.w, h: bounds.h * to.h / from.h } }
  }
  const byId = new Map(targets.map((target) => [target.webId, target]))
  return { ...plan, parameters,
    targets: plan.targets?.map((target) => byId.get(target.webId) || target),
    steps: plan.steps?.map((step) => relocatePlan(step, changes, targets)),
    candidatePlans: plan.candidatePlans?.map((candidate) => relocatePlan(candidate,changes,targets)),
  }
}

export function reflowBrushGroup(group, resolveRect, refreshTarget = (target) => target) {
  if (!group || group.coordinateSpace !== 'web-document') return group
  const changes = []
  const strokes = (group.strokes || []).map((stroke) => {
    const anchor = stroke.layoutAnchor
    if (!anchor || !validLayoutRect(anchor.originalRect)) return stroke
    let rect
    try { rect = resolveRect(anchor.reference) } catch { return stroke }
    // A temporarily hidden/missing object must never discard its ink.
    if (!validLayoutRect(rect) || sameRect(anchor.currentRect, rect)) return stroke
    const next = { ...stroke, points: anchor.originalPoints.map((point) => mapLayoutPoint(point, anchor.originalRect, rect)),
      layoutAnchor: { ...anchor, currentRect: { ...rect } } }
    changes.push({ before: stroke, after: next })
    return next
  })
  if (!changes.length) return group
  const targets = (group.targets || []).map((target) => {
    try { return refreshTarget(target) || target } catch { return target }
  })
  return { ...group, strokes, targets,
    inferredIntent: relocatePlan(group.inferredIntent, changes, targets),
    localIntent: relocatePlan(group.localIntent, changes, targets),
  }
}

/** Trial verification can await layout/images while the sidebar is toggled.
 * Discard a stale trial and reproject the SAME plan once, without another model
 * call or a second image generation. Repeated instability fails safely; it must
 * not be sent to the planner as a bad design. The caller owns the total deadline. */
export async function verifyReflowedBrushPlan(snapshot, plan, { resolveRect, refreshTarget, verify, signal }) {
  let group = { ...snapshot, inferredIntent: plan }
  for (let pass = 0; pass < 2; pass++) {
    signal?.throwIfAborted()
    group = reflowBrushGroup(group, resolveRect, refreshTarget)
    const report = await verify(group.inferredIntent, group.strokes, signal, group)
    signal?.throwIfAborted()
    const current = reflowBrushGroup(group, resolveRect, refreshTarget)
    if (current === group) return { group, plan: group.inferredIntent, report }
    group = current
  }
  return { group, plan: group.inferredIntent,
    report: { ok: false, issues: [{ code: 'layout-changing', severity: 'error' }] } }
}
