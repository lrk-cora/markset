import { looksLikeBoxStroke } from '../src/geometry.js'

function square(x, y, s, n = 24) {
  const pts = []
  const sides = [
    [x, y, x + s, y],
    [x + s, y, x + s, y + s],
    [x + s, y + s, x, y + s],
    [x, y + s, x, y],
  ]
  for (const [x1, y1, x2, y2] of sides) {
    for (let i = 0; i < n; i += 1) {
      const t = i / n
      pts.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t })
    }
  }
  pts.push({ x, y })
  return pts
}

function line(x1, y1, x2, y2, n = 16) {
  const pts = []
  for (let i = 0; i <= n; i += 1) {
    const t = i / n
    pts.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t })
  }
  return pts
}

const cases = [
  ['small square', square(10, 10, 28), true],
  ['taller box', square(8, 8, 40), true],
  ['too big', square(0, 0, 120), false],
  ['too small', square(0, 0, 6), false],
  ['long swipe', line(10, 20, 220, 28), false],
]

let failed = 0
for (const [name, pts, expect] of cases) {
  const got = looksLikeBoxStroke(pts)
  const ok = got === expect
  if (!ok) failed += 1
  console.log(`${ok ? 'ok' : 'FAIL'} ${name}: ${got} (want ${expect})`)
}

if (failed) {
  console.error(`${failed} failed`)
  process.exit(1)
}
console.log('all passed')
