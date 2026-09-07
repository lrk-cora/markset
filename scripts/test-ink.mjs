import { recognizeStrokes } from '../src/ink.js'

function line(x1, y1, x2, y2, n = 12) {
  const pts = []
  for (let i = 0; i <= n; i += 1) {
    const t = i / n
    pts.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t })
  }
  return pts
}

const samples = {
  改: [
    line(10, 20, 44, 20),
    [...line(12, 20, 12, 74), ...line(12, 74, 42, 74), ...line(42, 74, 40, 50)],
    line(50, 10, 92, 28),
    line(72, 14, 48, 90),
    line(58, 44, 94, 86),
  ],
  改2: [
    [...line(12, 24, 40, 20), ...line(40, 20, 14, 58), ...line(14, 58, 40, 72)],
    [...line(52, 10, 88, 32), ...line(88, 32, 70, 18), ...line(70, 18, 46, 88)],
    line(60, 48, 92, 84),
  ],
  删: [
    [...line(8, 18, 40, 18), ...line(40, 18, 40, 82), ...line(40, 82, 8, 82), ...line(8, 82, 8, 18)],
    line(16, 48, 34, 48),
    line(58, 12, 58, 88),
    line(78, 12, 78, 88),
  ],
  色: [
    [...line(28, 8, 72, 8), ...line(72, 8, 50, 8), ...line(50, 8, 50, 28)],
    [...line(18, 30, 82, 30), ...line(82, 30, 82, 90), ...line(82, 90, 18, 90), ...line(18, 90, 18, 30)],
    line(18, 58, 82, 58),
  ],
  色open: [
    line(38, 8, 66, 22),
    line(18, 34, 84, 34),
    line(20, 34, 22, 86),
    line(82, 34, 80, 86),
    line(22, 86, 80, 86),
    line(24, 60, 78, 60),
  ],
  加: [
    line(14, 16, 14, 84),
    [...line(14, 84, 40, 76)],
    line(56, 48, 90, 48),
    line(74, 22, 74, 82),
  ],
  减: [
    line(12, 18, 28, 30),
    line(10, 42, 28, 58),
    line(42, 14, 90, 14),
    line(66, 14, 52, 88),
    line(66, 42, 90, 80),
    line(48, 50, 86, 50),
  ],
  添: [
    line(8, 16, 22, 28),
    line(6, 46, 24, 40),
    line(8, 62, 24, 78),
    line(38, 12, 90, 12),
    line(64, 12, 64, 88),
    line(42, 48, 88, 48),
  ],
}

const expect = { 改: '改', 改2: '改', 删: '删', 色: '色', 色open: '色', 加: '加', 减: '减', 添: '添' }

let failed = 0
for (const [name, strokes] of Object.entries(samples)) {
  const ch = expect[name]
  const got = recognizeStrokes(strokes)
  const ok = got.text === ch
  if (!ok) failed += 1
  const top = Object.entries(got.scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}:${v.toFixed(2)}`)
    .join(' ')
  console.log(`${ok ? 'OK' : 'FAIL'} ${name} -> ${got.text || '∅'} (want ${ch})  ${top}`)
  if (!ok) console.log('  feat', JSON.stringify(got.debug?.feat))
}
if (failed) {
  console.error(`failed ${failed}`)
  process.exit(1)
}
console.log('all passed')
