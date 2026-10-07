// Pointer sampling is independent of gesture recognition and DOM hit testing.
// A fast drag can contain only down/up, and even an unrecognised stroke is ink.
export class StrokeSession {
  constructor() { this.reset() }
  reset() { this.pointerId = null; this.points = []; this.length = 0 }
  get active() { return this.pointerId !== null }
  begin(pointerId, point) {
    if (this.active) return false
    this.pointerId = pointerId
    this.points = [{ x: point.x, y: point.y }]
    this.length = 0
    return true
  }
  add(pointerId, point) {
    if (!this.active || pointerId !== this.pointerId) return false
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
    const last = this.points.at(-1)
    const distance = Math.hypot(point.x - last.x, point.y - last.y)
    if (distance < 0.5) return false
    this.length += distance
    this.points.push({ x: point.x, y: point.y })
    return true
  }
  finish(pointerId, point, { cancelled = false } = {}) {
    if (!this.active || pointerId !== this.pointerId) return null
    // Account for the release coordinate BEFORE distinguishing a tap from ink.
    if (point && !cancelled) this.add(pointerId, point)
    const result = {
      kind: this.length >= 3 ? 'stroke' : cancelled ? 'cancel' : 'tap',
      points: this.points,
      cancelled,
    }
    this.reset()
    return result
  }
}
