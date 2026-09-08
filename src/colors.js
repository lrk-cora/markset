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
  { id: '灰粉', fill: '#c4a4a8' },
  { id: '烟灰蓝', fill: '#9aa7b0' },
  { id: '蜜桃', fill: '#f3b6a5' },
  { id: '薄荷绿', fill: '#9ad4c0' },
  { id: '香芋', fill: '#c5b6e0' },
  { id: '燕麦', fill: '#d7c4a3' },
  { id: '米杏', fill: '#edd9c0' },
  { id: '朱砂', fill: '#b85c4a' },
  { id: '缃黄', fill: '#c9a44a' },
  { id: '石青', fill: '#3d6b66' },
  { id: '墨色', fill: '#1f1f1f' },
  { id: '鼠尾草', fill: '#7f9b8a' },
  { id: '雾灰', fill: '#b8b6b1' },
  { id: '桦白', fill: '#efe8dc' },
  { id: '陶土', fill: '#b07a58' },
  { id: '枯叶', fill: '#c4a574' },
  { id: '骨色', fill: '#efe6d6' },
  { id: '落日', fill: '#d56a3a' },
  { id: '珊瑚', fill: '#e08b74' },
  { id: '暮紫', fill: '#6e5470' },
  { id: '克莱因蓝', fill: '#002fa7' },
  { id: '沙色', fill: '#e2d3b8' },
]

/** Extra hex chips for the free color picker (not used as glaze words). */
const EXTRA_PICKER = [
  '#7a1f1f',
  '#c0382b',
  '#e74c3c',
  '#f1948a',
  '#f5b7b1',
  '#6e2c00',
  '#d35400',
  '#e67e22',
  '#f0b27a',
  '#fdebd0',
  '#7d6608',
  '#b7950b',
  '#f1c40f',
  '#f7dc6f',
  '#fcf3cf',
  '#145a32',
  '#1e8449',
  '#27ae60',
  '#82e0aa',
  '#d5f5e3',
  '#0e6655',
  '#16a085',
  '#48c9b0',
  '#a3e4d7',
  '#1a5276',
  '#2471a3',
  '#2980b9',
  '#85c1e9',
  '#d6eaf8',
  '#1a237e',
  '#3949ab',
  '#5c6bc0',
  '#9fa8da',
  '#4a148c',
  '#6c3483',
  '#8e44ad',
  '#d2b4de',
  '#880e4f',
  '#ad1457',
  '#e91e8c',
  '#f8bbd0',
  '#3e2723',
  '#6d4c41',
  '#a1887f',
  '#111111',
  '#4a4a4a',
  '#888888',
  '#c8c8c8',
  '#f7f7f7',
  '#ffffff',
]

export const COLOR_SCHEMES = [
  {
    id: 'dopamine',
    label: '多巴胺',
    colors: ['粉色', '姜黄', '浅蓝'],
    heading: '粉色',
    body: '姜黄',
    image: '浅蓝',
    paper: '#fbe4de',
  },
  {
    id: 'luxe',
    label: '高级感 / 黑白灰',
    colors: ['黑色', '岩灰', '白色'],
    heading: '黑色',
    body: '岩灰',
    image: '岩灰',
    paper: '#f2f2f0',
  },
  {
    id: 'oak',
    label: '原木自然',
    colors: ['暖茶', '米色', '奶油'],
    heading: '暖茶',
    body: '米色',
    image: '暖茶',
    paper: '#f6ead4',
  },
  {
    id: 'morandi',
    label: '莫兰迪',
    colors: ['灰粉', '鼠尾草', '烟灰蓝'],
    heading: '灰粉',
    body: '鼠尾草',
    image: '烟灰蓝',
    paper: '#ece8e4',
  },
  {
    id: 'macaron',
    label: '马卡龙',
    colors: ['蜜桃', '薄荷绿', '香芋'],
    heading: '蜜桃',
    body: '薄荷绿',
    image: '香芋',
    paper: '#fff3f5',
  },
  {
    id: 'cream',
    label: '奶油风',
    colors: ['燕麦', '米杏', '奶油'],
    heading: '燕麦',
    body: '米杏',
    image: '燕麦',
    paper: '#fbf6ee',
  },
  {
    id: 'chinese',
    label: '新中式',
    colors: ['朱砂', '缃黄', '石青'],
    heading: '朱砂',
    body: '缃黄',
    image: '石青',
    paper: '#f7f1e4',
  },
  {
    id: 'nordic',
    label: '北欧',
    colors: ['鼠尾草', '雾灰', '桦白'],
    heading: '鼠尾草',
    body: '雾灰',
    image: '鼠尾草',
    paper: '#f3f4f1',
  },
  {
    id: 'wabi',
    label: '日式侘寂',
    colors: ['陶土', '枯叶', '骨色'],
    heading: '陶土',
    body: '枯叶',
    image: '陶土',
    paper: '#f3ece3',
  },
  {
    id: 'sunset',
    label: '落日暖调',
    colors: ['落日', '珊瑚', '暮紫'],
    heading: '落日',
    body: '珊瑚',
    image: '暮紫',
    paper: '#fbeee6',
  },
  {
    id: 'klein',
    label: '克莱因蓝',
    colors: ['克莱因蓝', '沙色', '岩灰'],
    heading: '克莱因蓝',
    body: '岩灰',
    image: '克莱因蓝',
    paper: '#eef1f8',
  },
]

export const COLOR_IDS = COLORS.map((c) => c.id)

export function pickerSwatches() {
  const seen = new Set(COLORS.map((c) => c.fill.toLowerCase()))
  const extra = EXTRA_PICKER.filter((hex) => !seen.has(hex.toLowerCase())).map((hex) => ({
    id: hex,
    fill: hex,
  }))
  return [...COLORS, ...extra]
}

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

export function colorFill(id) {
  if (!id) return '#1d1916'
  if (String(id).startsWith('#')) return id
  return COLORS.find((c) => c.id === id)?.fill || '#1d1916'
}

export function swatchLabel(id) {
  if (!id) return '颜色'
  if (String(id).startsWith('#')) {
    const named = COLORS.find((c) => c.fill.toLowerCase() === id.toLowerCase())
    return named?.id || '自选'
  }
  return id
}

function toHex(r, g, b) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

export function readableTextFill(id, maxLuma = 150) {
  const [r, g, b] = colorRgb(id)
  const luma = 0.299 * r + 0.587 * g + 0.114 * b
  if (luma <= maxLuma) return colorFill(id)
  const t = (luma - 40) / Math.max(1, luma)
  return toHex(r * (1 - t) + 29 * t, g * (1 - t) + 25 * t, b * (1 - t) + 22 * t)
}

/** Keep the named hue visible on paper; only darken near-white swatches. */
export function schemeTextFill(id) {
  const [r, g, b] = colorRgb(id)
  const luma = 0.299 * r + 0.587 * g + 0.114 * b
  if (luma <= 185) return colorFill(id)
  return toHex(r * 0.52, g * 0.52, b * 0.52)
}

export function paperFill(id) {
  if (!id) return '#fffaf2'
  if (String(id).startsWith('#')) return id
  const [r, g, b] = colorRgb(id)
  return toHex(r * 0.16 + 255 * 0.84, g * 0.16 + 255 * 0.84, b * 0.16 + 250 * 0.84)
}
