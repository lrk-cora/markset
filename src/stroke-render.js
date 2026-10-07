// Smoothing is a display projection only. Endpoints and sharp corners stay
// put; recognition, hit testing and model evidence always use the raw samples.
export function displayStrokePoints(points = [], smoothing = 'light') {
  const amount = smoothing === 'strong' ? 0.5 : smoothing === 'light' ? 0.25 : 0
  return points.map((point, index) => {
    if (!amount || index === 0 || index === points.length - 1) return { ...point }
    const prev = points[index - 1], next = points[index + 1]
    const ax = point.x - prev.x, ay = point.y - prev.y, bx = next.x - point.x, by = next.y - point.y
    const length = Math.hypot(ax, ay) * Math.hypot(bx, by)
    if (!length || (ax * bx + ay * by) / length < 0.5) return { ...point }
    return { x: point.x * (1 - amount) + (prev.x + next.x) * amount / 2,
      y: point.y * (1 - amount) + (prev.y + next.y) * amount / 2 }
  })
}

// Screenshots must retain the same raw ink as the overlay, including taps.
export function drawCanvasStroke(ctx, points, color, width, mapPoint = (point) => point) {
  if (!points?.length) return
  const mapped = points.map(mapPoint)
  ctx.beginPath()
  if (mapped.length === 1) {
    ctx.fillStyle = color
    ctx.arc(mapped[0].x, mapped[0].y, width / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.moveTo(mapped[0].x, mapped[0].y)
  for (const point of mapped.slice(1)) ctx.lineTo(point.x, point.y)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.stroke()
}
