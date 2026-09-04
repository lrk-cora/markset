/** Named glaze / copy colors shown on the novice card. */
export const COLORS = [
  { id: '雾蓝', fill: '#5884b0' },
  { id: '暖茶', fill: '#b06040' },
  { id: '红色', fill: '#c63830' },
  { id: '白色', fill: '#f4f0ea' },
  { id: '黑色', fill: '#2a2a2a' },
  { id: '米色', fill: '#e6d5b8' },
  { id: '岩灰', fill: '#6b6e73' },
  { id: '墨绿', fill: '#2f5d50' },
  { id: '奶油', fill: '#f3e6c8' },
  { id: '浅蓝', fill: '#8bb8d8' },
  { id: '棕色', fill: '#6b3e2e' },
  { id: '粉色', fill: '#d9a0a8' },
  { id: '姜黄', fill: '#c4a35a' },
  { id: '青瓷', fill: '#7aa89a' },
]

export const COLOR_IDS = COLORS.map((c) => c.id)

export function parseHexColor(text) {
  const m = String(text || '').match(/#([0-9a-f]{6})/i)
  return m ? `#${m[1].toLowerCase()}` : null
}

export function colorRgb(id) {
  const named = COLORS.find((c) => c.id === id)
  const hex = named?.fill || parseHexColor(id)
  if (!hex) return [60, 111, 212]
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
