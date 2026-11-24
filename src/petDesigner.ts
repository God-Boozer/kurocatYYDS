import type {
  CatAccessory,
  CatEarShape,
  CatFaceStyle,
  CatPattern,
  CatSkinConfig,
  CatSpecies,
  CatSpot,
  CatTailStyle,
} from './catSkins';

/**
 * KuroCat Pet Designer
 * --------------------
 * Turns a free-form Chinese / English description into a complete CatSkinConfig.
 * It is fully offline: a small mood + color + pattern analyser drives a seeded
 * palette synthesiser, so the same description always yields the same pet while
 * "换一批" (new seed) produces a fresh variation.
 *
 * The output is a normal CatSkinConfig, which means every generated pet
 * automatically inherits the live engine behaviours:
 *   - pupils that follow the mouse cursor
 *   - paws that type on the mechanical keyboard in front of the pet
 *   - tail slaps, blinks, curious / grumpy moods, privacy guard, etc.
 */

export interface PetDesignSummary {
  moodLabel: string;
  patternLabel: string;
  furLabel: string;
  eyeLabel: string;
  accentLabel: string;
  traits: string[];
}

export interface PetDesignResult {
  cat: CatSkinConfig;
  summary: PetDesignSummary;
}

type Rng = () => number;

/* ------------------------------------------------------------------ */
/* Color helpers                                                       */
/* ------------------------------------------------------------------ */

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function parseHex(hex: string): [number, number, number] {
  const match = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return [0, 0, 0];
  let h = match[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(r: number, g: number, b: number): string {
  const rr = Math.round(clamp01(r) * 255);
  const gg = Math.round(clamp01(g) * 255);
  const bb = Math.round(clamp01(b) * 255);
  return `#${((1 << 24) | (rr << 16) | (gg << 8) | bb).toString(16).slice(1)}`;
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = parseHex(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const ss = clamp01(s / 100);
  const ll = clamp01(l / 100);
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return toHex(r + m, g + m, b + m);
}

function adjust(hex: string, dh = 0, ds = 0, dl = 0): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h + dh, clamp01(s / 100 + ds / 100) * 100, l + dl);
}

function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const k = clamp01(t);
  return toHex(
    (ar + (br - ar) * k) / 255,
    (ag + (bg - ag) * k) / 255,
    (ab + (bb - ab) * k) / 255,
  );
}

function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => v / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function isLight(hex: string): boolean {
  return luminance(hex) > 0.48;
}

function isVeryDark(hex: string): boolean {
  return luminance(hex) < 0.17;
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function ensureVivid(hex: string): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, Math.max(s, 62), Math.max(42, Math.min(74, l)));
}

/* ------------------------------------------------------------------ */
/* Seeded RNG                                                          */
/* ------------------------------------------------------------------ */

function hashString(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length) % list.length];
}

/* ------------------------------------------------------------------ */
/* Theme library                                                       */
/* ------------------------------------------------------------------ */

interface FurTheme {
  id: string;
  label: string;
  keywords: string[];
  base: string;
  secondary: string;
  light: string;
  eye: [string, string];
  accent: string;
  names: string[];
  emoji: string;
  weight: number;
  neutral?: boolean;
}

const FUR_THEMES: FurTheme[] = [
  {
    id: 'black',
    label: '曜石黑',
    keywords: ['黑', '墨', '乌', '玄', '午夜', '黑夜', '暗夜', '黑猫', 'obsidian', 'black'],
    base: '#17161a',
    secondary: '#0b0b0e',
    light: '#f5f3ee',
    eye: ['#d4f044', '#b9e02c'],
    accent: '#d2f244',
    names: ['煤球', '墨墨', '乌云', '夜莺', '玄米', '芝麻', '小黑', '阿夜'],
    emoji: '🐈',
    weight: 9,
    neutral: true,
  },
  {
    id: 'charcoal',
    label: '炭灰',
    keywords: ['炭', '深灰', '石墨', 'charcoal'],
    base: '#3a3d45',
    secondary: '#26282e',
    light: '#e9e7e1',
    eye: ['#f0c75a', '#ffe58e'],
    accent: '#b9c6ff',
    names: ['灰灰', '烟烟', '石墨', '炭炭', '雾霾'],
    emoji: '🐾',
    weight: 2,
    neutral: true,
  },
  {
    id: 'white',
    label: '云朵白',
    keywords: ['白', '雪', '奶白', '纯白', '牛奶', '象牙白', 'white', 'snow', 'ivory'],
    base: '#fbf9f3',
    secondary: '#e7e2d8',
    light: '#ffffff',
    eye: ['#5b9bd5', '#b7dcf7'],
    accent: '#8ec9ff',
    names: ['雪球', '奶糖', '汤圆', '云朵', '豆乳', '米糕', '糯米', '小雪'],
    emoji: '🤍',
    weight: 6,
    neutral: true,
  },
  {
    id: 'cream',
    label: '奶油',
    keywords: ['奶油', '奶黄', '米色', '米白', '奶茶', '象牙', 'cream', 'beige', 'latte'],
    base: '#f3e4c8',
    secondary: '#e0cba3',
    light: '#fffaf0',
    eye: ['#c98a2e', '#ffd369'],
    accent: '#ffcf6e',
    names: ['布丁', '奶昔', '蛋挞', '泡芙', '奶油', '千层', '奶盖', '蛋卷'],
    emoji: '🍦',
    weight: 5,
  },
  {
    id: 'orange',
    label: '蜜橘',
    keywords: ['橘', '橙', '橘黄', '姜黄', '南瓜', 'mango', 'orange', 'ginger'],
    base: '#f2a452',
    secondary: '#dd8531',
    light: '#fdf3e2',
    eye: ['#b86b14', '#ffd369'],
    accent: '#ffb347',
    names: ['橘子', '柿子', '柚子', '南瓜', '芒果', '汽水', '橙子', '金桔'],
    emoji: '🍊',
    weight: 8,
  },
  {
    id: 'caramel',
    label: '焦糖',
    keywords: ['焦糖', '太妃', '奶茶', '拿铁', '摩卡', '咖啡', 'caramel', 'latte', 'mocha'],
    base: '#c8874a',
    secondary: '#a8682f',
    light: '#f8ead6',
    eye: ['#8a5a1e', '#ffdf8a'],
    accent: '#e8a34e',
    names: ['焦糖', '太妃', '奶茶', '拿铁', '摩卡', '咖啡', '可可'],
    emoji: '🧋',
    weight: 4,
  },
  {
    id: 'brown',
    label: '可可棕',
    keywords: ['棕', '咖', '巧克力', '深棕', '褐', 'brown', 'chocolate'],
    base: '#6b4f3a',
    secondary: '#513a2a',
    light: '#eadfce',
    eye: ['#e0b34a', '#ffe08a'],
    accent: '#d9a441',
    names: ['可可', '栗子', '板栗', '核桃', '巧克力', '曲奇', '饼干'],
    emoji: '🤎',
    weight: 4,
  },
  {
    id: 'gray',
    label: '雾霾灰',
    keywords: ['灰', '银灰', '烟灰', '蓝灰', 'gray', 'grey', 'slate'],
    base: '#8f95a3',
    secondary: '#747b8a',
    light: '#eef0f4',
    eye: ['#f0c75a', '#ffe58e'],
    accent: '#b9c6ff',
    names: ['灰灰', '烟烟', '银灰', '雾霾', '石板', '月灰'],
    emoji: '🐺',
    weight: 5,
    neutral: true,
  },
  {
    id: 'silver',
    label: '月银',
    keywords: ['银', '银白', '银灰', 'silver'],
    base: '#cfd4dc',
    secondary: '#b4bac5',
    light: '#ffffff',
    eye: ['#5b9bd5', '#b7dcf7'],
    accent: '#d7e2ff',
    names: ['银灰', '月光', '雪霜', '云母', '银币'],
    emoji: '🥈',
    weight: 3,
    neutral: true,
  },
  {
    id: 'blue',
    label: '雾霾蓝',
    keywords: ['蓝', '天蓝', '湛蓝', '蓝猫', 'blue'],
    base: '#6f93c4',
    secondary: '#5878a8',
    light: '#eaf1fb',
    eye: ['#f4d35e', '#ffe9a8'],
    accent: '#7ac7ff',
    names: ['蓝莓', '汽水', '海盐', '湖水', '天空', '阿蓝', '蓝冻'],
    emoji: '💙',
    weight: 5,
  },
  {
    id: 'navy',
    label: '深海蓝',
    keywords: ['深蓝', '藏蓝', '海军蓝', '墨蓝', 'navy'],
    base: '#2f3f66',
    secondary: '#22304e',
    light: '#dfe7f5',
    eye: ['#f0c75a', '#ffe58e'],
    accent: '#6fa8ff',
    names: ['夜航', '深海', '墨蓝', '星港', '蓝夜'],
    emoji: '🌊',
    weight: 3,
  },
  {
    id: 'pink',
    label: '樱花粉',
    keywords: ['粉', '粉红', '粉色', '樱花', '桃粉', '草莓', 'pink'],
    base: '#f3b8c6',
    secondary: '#e79cb0',
    light: '#fff5f8',
    eye: ['#4a86d8', '#a8d4ff'],
    accent: '#ff9ec4',
    names: ['桃桃', '樱桃', '草莓', '樱花', '棉花糖', '果冻', '桃子'],
    emoji: '🌸',
    weight: 6,
  },
  {
    id: 'rose',
    label: '蔷薇',
    keywords: ['玫瑰', '蔷薇', '玫红', 'rose'],
    base: '#d97b8e',
    secondary: '#c25e73',
    light: '#fff0f3',
    eye: ['#4a86d8', '#a8d4ff'],
    accent: '#ff8fa8',
    names: ['玫瑰', '蔷薇', '山楂', '石榴', '莓果'],
    emoji: '🌹',
    weight: 2,
  },
  {
    id: 'purple',
    label: '香芋紫',
    keywords: ['紫', '淡紫', '薰衣草', '香芋', '紫薯', 'purple', 'lavender'],
    base: '#a48ad0',
    secondary: '#8b6fbe',
    light: '#f4efff',
    eye: ['#f4d35e', '#ffe9a8'],
    accent: '#c4a6ff',
    names: ['香芋', '芋泥', '葡萄', '紫薯', '丁香', '薰衣草'],
    emoji: '🍇',
    weight: 4,
  },
  {
    id: 'green',
    label: '抹茶绿',
    keywords: ['绿', '抹茶', '薄荷', '青绿', '苔绿', 'green', 'mint', 'matcha'],
    base: '#9ccfa8',
    secondary: '#7fb88d',
    light: '#f2fbf4',
    eye: ['#e8b84b', '#ffe08a'],
    accent: '#8be9a8',
    names: ['抹茶', '薄荷', '青团', '豆苗', '苔米', '叶子'],
    emoji: '🍵',
    weight: 5,
  },
  {
    id: 'teal',
    label: '湖水青',
    keywords: ['青', '青色', '湖蓝', '孔雀', 'teal', 'cyan'],
    base: '#6fc7cf',
    secondary: '#54aab3',
    light: '#eefbfc',
    eye: ['#f4d35e', '#ffe9a8'],
    accent: '#6fe3ec',
    names: ['汽水', '海盐', '湖蓝', '泡泡', '苏打', '冰棒'],
    emoji: '🫧',
    weight: 3,
  },
  {
    id: 'red',
    label: '石榴红',
    keywords: ['红', '大红', '酒红', '枣红', 'red', 'ruby'],
    base: '#c95b57',
    secondary: '#a8423f',
    light: '#fbeceb',
    eye: ['#f2d05e', '#ffe58e'],
    accent: '#ff7b6b',
    names: ['红豆', '山楂', '枣泥', '辣椒', '番茄', '石榴'],
    emoji: '🍎',
    weight: 3,
  },
  {
    id: 'gold',
    label: '蜂蜜金',
    keywords: ['金', '金色', '金黄', '鎏金', 'gold'],
    base: '#d9b45c',
    secondary: '#c09a3f',
    light: '#fff7df',
    eye: ['#4a86d8', '#a8d4ff'],
    accent: '#ffd76e',
    names: ['金桔', '柠檬', '蜂蜜', '小米', '麦芽', '鎏金'],
    emoji: '🪙',
    weight: 3,
  },
  {
    id: 'galaxy',
    label: '星云紫',
    keywords: ['星空', '银河', '星河', '宇宙', '夜空', '星云', 'galaxy', 'cosmic'],
    base: '#2a2f55',
    secondary: '#1c2040',
    light: '#e9e6ff',
    eye: ['#b18cff', '#e0d4ff'],
    accent: '#9b8cff',
    names: ['星屑', '银河', '月亮', '流星', '夜空', '星云', '星野'],
    emoji: '🌌',
    weight: 4,
  },
];

const THEME_BY_ID = new Map(FUR_THEMES.map((t) => [t.id, t]));

function defaultTheme(): FurTheme {
  return THEME_BY_ID.get('orange')!;
}

/* ------------------------------------------------------------------ */
/* Eye + mood libraries                                                */
/* ------------------------------------------------------------------ */

interface EyeTheme {
  id: string;
  label: string;
  keywords: string[];
  top: string;
  bottom: string;
}

const EYE_THEMES: EyeTheme[] = [
  {
    id: 'blue',
    label: '蓝宝石眼',
    keywords: [
      '蓝眼',
      '蓝色眼睛',
      '蓝眼睛',
      '天蓝眼',
      '海蓝眼',
      '蓝瞳',
      '蓝宝石',
      'blue eye',
      'blue eyes',
      'sapphire',
    ],
    top: '#3f7fd6',
    bottom: '#a8d4ff',
  },
  {
    id: 'green',
    label: '翡翠眼',
    keywords: ['绿眼', '绿色眼睛', '绿眼睛', '翠绿眼', '绿瞳', 'emerald', 'green eye'],
    top: '#4f9e46',
    bottom: '#bfe87c',
  },
  {
    id: 'gold',
    label: '琥珀眼',
    keywords: ['金眼', '金色眼睛', '金眼睛', '琥珀', '黄眼', '黄色眼睛', 'amber', 'gold eye', 'honey'],
    top: '#c98a2e',
    bottom: '#ffe08a',
  },
  {
    id: 'red',
    label: '石榴石眼',
    keywords: ['红眼', '红色眼睛', '红眼睛', '赤瞳', 'ruby', 'red eye'],
    top: '#c94a4a',
    bottom: '#ffb0a0',
  },
  {
    id: 'purple',
    label: '紫水晶眼',
    keywords: ['紫眼', '紫色眼睛', '紫眼睛', '紫瞳', 'violet', 'purple eye'],
    top: '#8a5fd0',
    bottom: '#d9c2ff',
  },
  {
    id: 'cyan',
    label: '湖水眼',
    keywords: ['青眼', '青色眼睛', 'cyan eye', 'teal eye'],
    top: '#2aa6b8',
    bottom: '#9df2ff',
  },
];

const EYE_BY_ID = new Map(EYE_THEMES.map((e) => [e.id, e]));

interface MoodDef {
  id: string;
  label: string;
  keywords: string[];
  themes: string[];
  accent?: string;
  blush: boolean;
}

const MOODS: MoodDef[] = [
  {
    id: 'cool',
    label: '高冷',
    keywords: ['酷', '高冷', '神秘', '暗黑', '冷艳', '帅气', '霸气', '御姐', '冷酷', '孤傲', '清冷'],
    themes: ['black', 'charcoal', 'navy', 'galaxy', 'gray'],
    blush: false,
  },
  {
    id: 'sweet',
    label: '软萌',
    keywords: ['软', '可爱', '甜', '奶萌', '奶香', '萌', '软萌', '甜妹', '乖', '治愈', '温柔'],
    themes: ['cream', 'white', 'pink', 'caramel'],
    accent: '#ffb7d5',
    blush: true,
  },
  {
    id: 'energetic',
    label: '元气',
    keywords: ['元气', '活泼', '调皮', '捣蛋', '好动', '精力', '阳光', '快乐', '欢乐', '热闹'],
    themes: ['orange', 'gold', 'pink', 'green'],
    accent: '#ffcf5e',
    blush: true,
  },
  {
    id: 'elegant',
    label: '优雅',
    keywords: ['优雅', '气质', '安静', '淑女', '绅士', '贵族', '端庄'],
    themes: ['white', 'silver', 'gray', 'cream'],
    accent: '#d9c7a3',
    blush: false,
  },
  {
    id: 'cyber',
    label: '赛博',
    keywords: ['赛博', '科技', '未来', '霓虹', '电子', '机械', '机器人', '科幻', 'cyber', 'neon'],
    themes: ['galaxy', 'navy', 'purple', 'teal'],
    accent: '#5ef2ff',
    blush: false,
  },
  {
    id: 'natural',
    label: '森系',
    keywords: ['森系', '自然', '清新', '森林', '草地', '植物', '苔藓', '田园', '树叶'],
    themes: ['green', 'brown', 'cream', 'teal'],
    accent: '#8be9a8',
    blush: true,
  },
  {
    id: 'dreamy',
    label: '梦幻',
    keywords: ['梦幻', '仙气', '童话', '梦境', '星空', '月亮', '云朵', '空灵', '柔和'],
    themes: ['galaxy', 'purple', 'pink', 'blue'],
    accent: '#c4a6ff',
    blush: true,
  },
  {
    id: 'retro',
    label: '复古',
    keywords: ['复古', '怀旧', '胶片', '经典', '艺术', '油画', '老钱'],
    themes: ['brown', 'caramel', 'gold', 'cream'],
    accent: '#e0b35e',
    blush: false,
  },
  {
    id: 'neutral',
    label: '日常',
    keywords: [],
    themes: ['black', 'orange', 'cream', 'gray', 'blue', 'pink', 'white', 'green'],
    blush: true,
  },
];

/* ------------------------------------------------------------------ */
/* Pattern rules                                                       */
/* ------------------------------------------------------------------ */

interface PatternRule {
  id: CatPattern;
  label: string;
  keywords: string[];
}

const PATTERN_RULES: PatternRule[] = [
  {
    id: 'calico',
    label: '三花',
    keywords: ['三花', '三色猫', 'calico', '三色'],
  },
  {
    id: 'tuxedo',
    label: '奶牛',
    keywords: ['奶牛', '黑白猫', '燕尾服', 'tuxedo', '黑白'],
  },
  {
    id: 'tabby',
    label: '虎斑',
    keywords: ['虎斑', '条纹', '鱼骨纹', '狸花', '虎纹', 'tabby'],
  },
  {
    id: 'siamese',
    label: '暹罗',
    keywords: ['暹罗', '重点色', 'siamese', '脸黑', '黑脸', '挖煤'],
  },
  {
    id: 'bicolor',
    label: '布偶',
    keywords: ['布偶', '双色', '白脸', '白腿', 'bicolor', 'ragdoll'],
  },
  {
    id: 'solid',
    label: '纯色',
    keywords: ['纯色', '单色', 'solid'],
  },
];

const PATTERN_LABELS: Record<CatPattern, string> = {
  solid: '纯色',
  tabby: '虎斑',
  calico: '三花',
  tuxedo: '奶牛',
  siamese: '暹罗',
  bicolor: '布偶',
};

const ACCESSORY_WORDS = ['项圈', '围巾', '领结', '铃铛', '键盘', '光', '灯', '发光', '霓虹', '荧光'];
const NEON_WORDS = ['赛博', '霓虹', '科技', '未来', '发光', '荧光', '电子'];

/* ------------------------------------------------------------------ */
/* Prompt analysis                                                     */
/* ------------------------------------------------------------------ */

/** Silhouette extras detected from the prompt (or passed straight from a character match). */
interface PetShape {
  earShape: CatEarShape;
  accessories: CatAccessory[];
  accessoryColor: string | null;
  cheek: string | null;
  species: CatSpecies;
  tailStyle: CatTailStyle;
  faceStyle: CatFaceStyle;
  whiskers: boolean;
  earTipColor: string | null;
}

interface Analysis {
  mood: MoodDef;
  themes: FurTheme[];
  pattern: CatPattern;
  eye: EyeTheme;
  accent: string;
  explicitName: string | null;
  emoji: string | null;
  fluffy: boolean;
  spotsRequested: boolean;
  shape?: PetShape;
}

const EAR_SHAPE_WORDS: [CatEarShape, RegExp][] = [
  ['long', /长耳|尖耳|大耳|立耳|兔耳|rabbit|bunny|long ears|tall ears/],
  ['round', /圆耳|小圆耳|熊耳|虎耳|round ears/],
  ['fold', /垂耳|折耳|耷拉|软耳|floppy|folded ears/],
];

const SPECIES_WORDS: [CatSpecies, RegExp][] = [
  ['rabbit', /兔子|兔耳|长耳兔|rabbit|bunny|usagi/],
  ['hedgehog', /刺猬|hedgehog|索尼克|sonic|皮卡丘|pikachu/],
  ['ghost', /幽灵|鬼魂|无脸|ghost|specter|phantom/],
  ['duck', /鸭子|唐老鸭|duck|donald/],
  ['star', /海星|星星|starfish|patrick|派大星/],
  ['bear', /小熊|维尼|熊本|bear|teddy|kumamon|winnie|pooh/],
  ['blob', /果冻|圆滚滚|团子|卡比|kirby|blob/],
];

const DECOR_WORDS: [CatAccessory, RegExp][] = [
  ['bow', /蝴蝶结|领结|发结|蝴蝶|bow|ribbon/],
  ['bell', /铃铛|铜铃|颈铃|bell/],
  ['glasses', /眼镜|墨镜|护目镜|glasses|spectacles|blindfold/],
  ['ahoge', /呆毛|翘毛|小呆毛|ahoge/],
  ['headband', /发带|头带|金箍|头巾|headband|hairband/],
  ['hat', /帽子|礼帽|贝雷帽|警官帽|飞行员帽|hat|cap|beret/],
];

const ACCESSORY_LABELS: Record<CatAccessory, string> = {
  bow: '蝴蝶结',
  bell: '铃铛',
  glasses: '眼镜',
  ahoge: '呆毛',
  headband: '发带',
  hat: '帽子',
};

/** Picks up silhouette words so a hand-written prompt can also shape the pet. */
function detectShape(prompt: string): PetShape {
  let earShape: CatEarShape = 'cat';
  for (const [shape, re] of EAR_SHAPE_WORDS) {
    if (re.test(prompt)) {
      earShape = shape;
      break;
    }
  }
  const accessories = DECOR_WORDS.filter(([, re]) => re.test(prompt)).map(([id]) => id);
  const cheek = /腮红|脸红|红脸蛋|大腮红|blush/.test(prompt) ? '#f2879f' : null;
  let species: CatSpecies = 'cat';
  for (const [id, re] of SPECIES_WORDS) {
    if (re.test(prompt)) {
      species = id;
      break;
    }
  }
  const earTipColor = /黑耳尖|深色耳尖|耳尖是黑|dark ear tips/.test(prompt) ? '#2b241d' : null;
  const whiskers = species === 'cat' ? !/无胡须|没有胡须|no whiskers/.test(prompt) : false;
  return {
    earShape,
    accessories,
    accessoryColor: null,
    cheek,
    species,
    tailStyle: species === 'cat' ? 'cat' : species === 'hedgehog' ? 'bolt' : species === 'ghost' || species === 'star' ? 'none' : 'puff',
    faceStyle: species === 'ghost' || species === 'duck' ? 'none' : species === 'cat' ? 'cat' : 'button',
    whiskers,
    earTipColor,
  };
}

const SHAPE_LABELS: Record<CatEarShape, string> = {
  cat: '尖耳朵',
  long: '长耳朵',
  round: '圆耳朵',
  fold: '垂耳',
};

function detectMood(prompt: string): MoodDef {
  let best: { mood: MoodDef; idx: number } | null = null;
  for (const mood of MOODS) {
    for (const keyword of mood.keywords) {
      const idx = prompt.indexOf(keyword);
      if (idx >= 0 && (!best || idx < best.idx)) {
        best = { mood, idx };
      }
    }
  }
  return best?.mood ?? MOODS[MOODS.length - 1];
}

/** Colours that describe eyes or accessories must not become the coat colour. */
function maskNonFurColors(prompt: string): string {
  const eyeColor =
    /(?:[蓝绿金红紫黄青琥珀白色]+色?)\s*(?:眼|瞳|眼睛|目光|眼眸|眼珠)/g;
  const accessoryColor =
    /(?:[红粉蓝绿紫金橙黄青黑白]色?)\s*(?:项圈|围巾|领结|铃铛|键盘|光|灯|蝴蝶结)/g;
  const tailTipColor =
    /(?:[红粉蓝绿紫金橙黄青黑白]色?)?[^，,。；;\s]{0,5}(?:尾尖|尾巴尖|尾巴末端|尾巴梢)[^，,。；;\s]{0,4}/g;
  return prompt
    .replace(eyeColor, (m) => ' '.repeat(m.length))
    .replace(accessoryColor, (m) => ' '.repeat(m.length))
    .replace(tailTipColor, (m) => ' '.repeat(m.length));
}

function detectThemesRaw(prompt: string): FurTheme[] {
  const hits: Array<{ theme: FurTheme; idx: number; len: number }> = [];
  const source = prompt.toLowerCase();
  for (const theme of FUR_THEMES) {
    let bestIdx = -1;
    let bestLen = 0;
    for (const keyword of theme.keywords) {
      const idx = source.indexOf(keyword.toLowerCase());
      if (idx >= 0 && (bestIdx < 0 || idx < bestIdx || (idx === bestIdx && keyword.length > bestLen))) {
        bestIdx = idx;
        bestLen = keyword.length;
      }
    }
    if (bestIdx >= 0) hits.push({ theme, idx: bestIdx, len: bestLen });
  }
  hits.sort((a, b) => a.idx - b.idx || b.len - a.len);
  const result: FurTheme[] = [];
  for (const hit of hits) {
    if (!result.some((t) => t.id === hit.theme.id)) result.push(hit.theme);
    if (result.length >= 2) break;
  }
  return result;
}

function detectThemes(prompt: string): FurTheme[] {
  return detectThemesRaw(maskNonFurColors(prompt));
}

function detectPattern(prompt: string, themes: FurTheme[]): CatPattern {
  for (const rule of PATTERN_RULES) {
    for (const keyword of rule.keywords) {
      if (prompt.toLowerCase().includes(keyword.toLowerCase())) return rule.id;
    }
  }

  if (themes.length >= 2) {
    const [a, b] = themes;
    const bothNeutral = Boolean(a.neutral && b.neutral);
    if (!bothNeutral) {
      const aLum = luminance(a.base);
      const bLum = luminance(b.base);
      const lighter = aLum >= bLum ? a : b;
      const darker = aLum >= bLum ? b : a;
      if (luminance(lighter.base) > 0.78 && luminance(darker.base) < 0.3) return 'tuxedo';
      if (luminance(lighter.base) > 0.72) return 'bicolor';
    }
  }
  const first = themes[0] ?? defaultTheme();
  if (first.id === 'orange' && !prompt.includes('纯色')) return 'tabby';
  return 'solid';
}

function detectEye(prompt: string, theme: FurTheme): EyeTheme {
  const lower = prompt.toLowerCase();
  for (const eye of EYE_THEMES) {
    for (const keyword of eye.keywords) {
      if (lower.includes(keyword.toLowerCase())) return eye;
    }
  }
  // Fallback for phrases like "青色发光眼睛" / "黄绿色眼睛" where the colour
  // word is separated from 眼 by an adjective.
  const flexible = prompt.match(
    /([蓝绿金红紫黄青])色?[^，,。；;\s]{0,5}(眼|瞳)/,
  );
  if (flexible) {
    const key = flexible[1];
    const id =
      key === '蓝'
        ? 'blue'
        : key === '绿'
          ? 'green'
          : key === '金' || key === '黄'
            ? 'gold'
            : key === '红'
              ? 'red'
              : key === '紫'
                ? 'purple'
                : 'cyan';
    const found = EYE_BY_ID.get(id);
    if (found) return found;
  }
  return {
    id: 'theme',
    label: '主题眼',
    keywords: [],
    top: theme.eye[0],
    bottom: theme.eye[1],
  };
}

function detectAccent(prompt: string, theme: FurTheme, mood: MoodDef): string {
  const clauses = prompt.split(/[，,。；;\s]+/);
  for (const clause of clauses) {
    if (!ACCESSORY_WORDS.some((word) => clause.includes(word))) continue;
    const clauseThemes = detectThemesRaw(clause);
    if (clauseThemes.length > 0) return clauseThemes[0].accent;
    const clauseEyes = detectEye(clause, theme);
    if (clauseEyes.id !== 'theme') return clauseEyes.top;
  }
  if (mood.accent) return mood.accent;
  if (NEON_WORDS.some((word) => prompt.includes(word))) return ensureVivid(theme.accent);
  return theme.accent;
}

function detectExplicitName(prompt: string): string | null {
  const patterns = [
    /(?:名字是|名字为|名叫|叫做|命名为|叫)[:\s"'“”]*([^，,。；;\s]{1,10})/,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match) {
      let name = match[1].trim();
      name = name.replace(/^(一只|一个|这个|那只)+/, '');
      name = name.replace(/(的小猫|的猫咪|的猫|小猫|猫咪|宝宝|的)+$/, '');
      name = name.replace(/[“”"'《》]/g, '').trim();
      if (name.length >= 1 && name.length <= 10) return name;
    }
  }
  return null;
}

function detectEmoji(prompt: string): string | null {
  const match = prompt.match(/\p{Extended_Pictographic}/u);
  return match ? match[0] : null;
}

/* ------------------------------------------------------------------ */
/* Skin synthesis                                                      */
/* ------------------------------------------------------------------ */

function makeId(theme: FurTheme, seed: number): string {
  return `studio-${theme.id}-${(seed >>> 0).toString(36).slice(-6)}`;
}

function makeSpots(
  rng: Rng,
  fur: string,
  pattern: CatPattern,
  requested: boolean,
  mood: MoodDef,
): CatSpot[] {
  // Patterned coats already have plenty of visual interest; only add random
  // spots to solid coats unless the prompt explicitly asks for markings.
  if (!requested && pattern !== 'solid') return [];
  const chance = requested ? 1 : mood.id === 'dreamy' || mood.id === 'cyber' ? 0.55 : 0.26;
  if (rng() > chance) return [];

  const spotColor = isLight(fur) ? darken(fur, 0.34) : lighten(fur, 0.5);
  const spots: CatSpot[] = [];
  const count = rng() < 0.58 ? 1 : 2;
  for (let i = 0; i < count; i += 1) {
    const onHead = i === 0;
    const side = rng() < 0.5 ? -1 : 1;
    spots.push({
      part: onHead ? 'head' : 'body',
      x: onHead ? (rng() * 2 - 1) * 0.52 : side * (0.42 + rng() * 0.28),
      y: onHead ? -0.04 - rng() * 0.3 : (rng() * 2 - 1) * 0.24,
      rx: 5 + rng() * 8,
      ry: 4 + rng() * 6,
      rotation: (rng() * 2 - 1) * 0.5,
      color: spotColor,
      opacity: 0.78,
    });
  }
  return spots;
}

function darken(hex: string, amount: number): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, s, Math.max(3, l * (1 - amount)));
}

function lighten(hex: string, amount: number): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, s, Math.min(98, l + (100 - l) * amount));
}

/** Shift a colour's lightness by a signed amount (-1..1). Used by the studio's colour pickers. */
export function shiftLuminance(hex: string, amount: number): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, s, Math.min(98, Math.max(3, l + amount * 100)));
}

/** Human-readable Chinese colour name for palette labels. */
export function colorName(hex: string): string {
  const { h, s, l } = hexToHsl(hex);
  const lightness = l / 100;
  const sat = s / 100;
  if (lightness < 0.13) return '曜石黑';
  if (lightness > 0.93) return '云朵白';
  if (sat < 0.15) {
    if (lightness > 0.7) return '月光白';
    return lightness < 0.3 ? '墨黑' : '雾霾灰';
  }
  if (h < 15 || h >= 345) return lightness > 0.72 ? '樱花粉' : '石榴红';
  if (h < 45) return lightness > 0.72 ? '奶油橘' : '暖橘';
  if (h < 70) {
    if (h >= 47 && sat > 0.8 && lightness > 0.5) return '明黄';
    return lightness > 0.55 ? '蜂蜜金' : '琥珀';
  }
  if (h < 100) return '嫩芽绿';
  if (h < 160) return lightness > 0.62 ? '薄荷绿' : '松柏绿';
  if (h < 200) return '湖水青';
  if (h < 255) return lightness > 0.72 ? '天空蓝' : '深海蓝';
  if (h < 290) return lightness > 0.72 ? '香芋紫' : '星云紫';
  if (h < 345) return '莓果粉';
  return '柔光';
}

function pickNames(theme: FurTheme, mood: MoodDef, rng: Rng): string[] {
  const pool = theme.names;
  const name = pick(rng, pool);
  const prefix = rng() < 0.18 ? '小' : '';
  const suffix = rng() < 0.1 ? (mood.id === 'sweet' ? '酱' : '咪') : '';
  return [`${prefix}${name}${suffix}`];
}

function buildSkin(analysis: Analysis, prompt: string, seed: number): CatSkinConfig {
  const rng = mulberry32(seed);
  const mood = analysis.mood;
  const themes = analysis.themes.length > 0 ? analysis.themes : [defaultTheme()];
  const primary = themes[0];
  const secondary = themes[1] ?? null;
  const pattern = analysis.pattern;

  // Build a coherent light/dark pair from the two prompt colours (or derive one
  // from a single colour) so every pattern has a readable value relationship.
  const primaryColor = primary.base;
  const secondaryColor = secondary?.base ?? null;
  const lightBase = secondaryColor
    ? luminance(primaryColor) >= luminance(secondaryColor)
      ? primaryColor
      : secondaryColor
    : lighten(primaryColor, 0.35);
  const darkBase = secondaryColor
    ? luminance(primaryColor) >= luminance(secondaryColor)
      ? secondaryColor
      : primaryColor
    : darken(primaryColor, 0.22);

  const jitter = primary.id === 'black' || primary.id === 'white' ? 0 : (rng() * 2 - 1) * 3;
  const furJitter = adjust(primaryColor, jitter, (rng() * 2 - 1) * 3, (rng() * 2 - 1) * 2.5);
  const lightJitter = adjust(lightBase, -jitter * 0.5, 0, 1.5);
  const darkJitter = adjust(darkBase, jitter * 0.5, 0, -1);

  let furColor = furJitter;
  let furSecondary = darken(furColor, 0.1);
  let bellyBib: string | null = null;
  let maskColor: string | null = null;
  let foreheadBridge: string | null = null;
  let flankColor: string | null = null;
  let stripeColor: string | null = null;
  let calicoPatchColor: string | null = null;
  let earOuter = furColor;
  let earTip: string | null = null;
  let tailColor = furColor;
  let tailTip: string | null = null;
  let pawColor = furColor;
  let armColor = furColor;
  let pawOutline: string | null = null;

  switch (pattern) {
    case 'tabby': {
      furColor = furJitter;
      furSecondary = darken(furColor, 0.12);
      stripeColor = adjust(darken(furColor, 0.28), 0, 5, 0);
      if (luminance(stripeColor) > luminance(furColor) - 0.08) {
        stripeColor = darken(furColor, 0.4);
      }
      bellyBib = mix(lightJitter, '#fffaf0', 0.58);
      earOuter = furColor;
      earTip = stripeColor;
      tailColor = furColor;
      tailTip = stripeColor;
      pawColor = bellyBib;
      break;
    }
    case 'calico': {
      furColor = mix(lightJitter, '#fbf7ef', 0.5);
      furSecondary = darken(furColor, 0.06);
      const satA = hexToHsl(primaryColor).s;
      const satB = secondaryColor ? hexToHsl(secondaryColor).s : -1;
      maskColor = satA >= satB ? primaryColor : secondaryColor!;
      calicoPatchColor =
        maskColor === primaryColor
          ? secondaryColor
            ? darken(secondaryColor, 0.12)
            : darken(primaryColor, 0.45)
          : darken(primaryColor, 0.12);
      earOuter = calicoPatchColor;
      earTip = maskColor;
      tailColor = maskColor;
      tailTip = calicoPatchColor;
      pawColor = furColor;
      break;
    }
    case 'tuxedo': {
      furColor = adjust(darkJitter, 0, 0, 0);
      furSecondary = darken(furColor, 0.08);
      bellyBib = mix(lightJitter, '#ffffff', 0.6);
      earOuter = furColor;
      tailColor = furColor;
      tailTip = bellyBib;
      pawColor = bellyBib;
      break;
    }
    case 'siamese': {
      furColor = mix(lightJitter, '#f6eedd', 0.6);
      furSecondary = darken(furColor, 0.07);
      maskColor = adjust(darkJitter, 0, -4, -2);
      earOuter = maskColor;
      earTip = darken(maskColor, 0.08);
      tailColor = maskColor;
      tailTip = maskColor;
      pawColor = maskColor;
      break;
    }
    case 'bicolor': {
      furColor = adjust(furJitter, 0, -3, 0);
      furSecondary = darken(furColor, 0.08);
      const secondaryIsDarker =
        secondaryColor !== null && luminance(secondaryColor) < luminance(furColor) - 0.08;
      maskColor = secondaryIsDarker ? secondaryColor : darken(furColor, 0.28);
      if (luminance(maskColor) > 0.52) {
        maskColor = mix(maskColor, '#6b5a4e', 0.55);
      }
      foreheadBridge = mix(furColor, '#ffffff', 0.22);
      flankColor = maskColor;
      bellyBib =
        secondaryColor && isLight(secondaryColor) && !secondaryIsDarker
          ? secondaryColor
          : isLight(furColor)
            ? furColor
            : mix(furColor, '#ffffff', 0.55);
      earOuter = maskColor;
      earTip = darken(maskColor, 0.08);
      tailColor = maskColor;
      tailTip = darken(maskColor, 0.12);
      pawColor = bellyBib;
      break;
    }
    case 'solid':
    default: {
      furColor = furJitter;
      furSecondary = darken(furColor, 0.1);
      earOuter = furColor;
      tailColor = furColor;
      tailTip = darken(furColor, 0.14);
      pawColor = furColor;
      break;
    }
  }

  // Small markings that should not change the overall coat pattern.
  if (/(?:尾尖|尾巴尖|尾巴末端|尾巴梢)[^，,。；;]{0,6}白|白[^，,。；;]{0,6}(?:尾尖|尾巴尖|尾巴末端|尾巴梢)/.test(prompt)) {
    tailTip = mix(lightJitter, '#ffffff', 0.72);
  }
  if (/(?:尾尖|尾巴尖|尾巴末端|尾巴梢)[^，,。；;]{0,6}黑|黑[^，,。；;]{0,6}(?:尾尖|尾巴尖|尾巴末端|尾巴梢)/.test(prompt)) {
    tailTip = '#1a1a1e';
  }
  if (pattern === 'solid' && /白(?:色)?(?:手套|爪|袜子)/.test(prompt)) {
    pawColor = mix(lightJitter, '#ffffff', 0.72);
    pawOutline = '#5d5148';
  }
  if (pattern === 'solid' && /白(?:色)?(?:胸|肚|肚子|围嘴|下巴)/.test(prompt)) {
    bellyBib = mix(lightJitter, '#ffffff', 0.72);
  }

  const lightFur = isLight(furColor);
  const veryDark = isVeryDark(furColor);
  const outlineColor = lightFur ? darken(furColor, 0.52) : null;
  const legLineColor = lightFur
    ? rgba(outlineColor ?? '#5d5148', 0.55)
    : 'rgba(214, 218, 224, 0.62)';
  const earInnerColor = veryDark
    ? mix(furColor, '#f0b9c0', 0.72)
    : mix(furColor, '#f2bfc4', 0.55);
  const shape: PetShape = analysis.shape ?? detectShape(prompt);
  const noseColor =
    shape.faceStyle === 'button' ? '#3a2f2c' : shape.faceStyle === 'none' ? null : veryDark ? '#c97f8c' : '#ee8e9e';
  const mouthColor = veryDark ? 'rgba(224, 190, 197, 0.62)' : 'rgba(90, 74, 68, 0.78)';
  const blushColor = mood.blush
    ? veryDark
      ? 'rgba(255, 140, 170, 0.30)'
      : 'rgba(244, 146, 166, 0.58)'
    : null;
  const whiskerColor = veryDark
    ? 'rgba(210, 214, 220, 0.56)'
    : 'rgba(84, 76, 70, 0.56)';
  const armCreaseColor = isLight(pawColor) ? null : 'rgba(216, 218, 222, 0.62)';
  if (isLight(pawColor) && !lightFur) {
    pawOutline = outlineColor ?? darken(furColor, 0.5);
  }

  const fluffy = analysis.fluffy;
  const tailStripes = pattern === 'tabby' || /条纹|虎斑|尾巴纹/.test(prompt);
  const earTuft = /耳毛|猞狸|lynx/.test(prompt) || rng() < 0.14;
  const eyeCatchlight = analysis.mood.id !== 'cool' && (!veryDark || rng() < 0.45);
  const squintGlowColor =
    mood.id === 'cyber' || mood.id === 'dreamy' ? rgba(analysis.accent, 0.55) : null;

  const accent = ensureVivid(analysis.accent);
  const accentSide = ensureVivid(adjust(accent, -8, 0, -18));

  const name = analysis.explicitName ?? pickNames(primary, mood, rng)[0];
  const emoji = analysis.emoji ?? primary.emoji;
  const spots = makeSpots(rng, furColor, pattern, analysis.spotsRequested, mood);
  const id = makeId(primary, seed);

  return {
    id,
    name,
    emoji,
    builtin: false,
    furColor,
    furSecondaryColor: furSecondary,
    outlineColor,
    legLineColor,
    pattern,
    maskColor,
    foreheadBridgeColor: foreheadBridge,
    flankColor,
    bellyBibColor: bellyBib,
    stripeColor,
    calicoPatchColor,
    earOuterColor: earOuter,
    earTipColor: shape.earTipColor ?? earTip,
    earInnerColor,
    earTuftColor: earTuft ? lighten(furColor, 0.28) : null,
    tailColor,
    tailTipColor: tailTip,
    tailFluffy: fluffy,
    tailStripes,
    eyeColorTop: analysis.eye.top,
    eyeColorBottom: analysis.eye.bottom,
    pupilColor: veryDark ? '#0a0b0e' : '#121722',
    eyeCatchlight,
    eyeRimColor: lightFur ? 'rgba(42, 46, 58, 0.78)' : null,
    squintColor: analysis.eye.top,
    squintGlowColor,
    noseColor,
    mouthColor,
    blushColor,
    whiskerColor,
    armColor,
    pawColor,
    pawOutlineColor: pawOutline,
    armCreaseColor,
    accentColor: accent,
    accentSideColor: accentSide,
    earShape: shape.earShape,
    species: shape.species,
    tailStyle: shape.tailStyle,
    faceStyle: shape.faceStyle,
    whiskers: shape.whiskers,
    accessories: shape.accessories,
    accessoryColor: shape.accessoryColor ?? accent,
    cheekColor: shape.cheek,
    spots,
  } as CatSkinConfig;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function generateCatFromPrompt(prompt: string, seed = Date.now()): PetDesignResult {
  const cleanPrompt = (prompt || '').trim();
  const mood = detectMood(cleanPrompt);
  let themes = detectThemes(cleanPrompt);
  const pattern = detectPattern(cleanPrompt, themes);

  // Vague prompts ("一只很酷的猫") should still get a deliberate palette.
  if (themes.length === 0) {
    const presetIds: Record<CatPattern, string[]> = {
      solid: [],
      tabby: ['orange'],
      calico: ['orange', 'brown'],
      tuxedo: ['black', 'white'],
      siamese: ['brown'],
      bicolor: ['white', 'gray'],
    };
    const preset = presetIds[pattern]
      .map((id) => THEME_BY_ID.get(id))
      .filter((t): t is FurTheme => Boolean(t));
    if (preset.length > 0) {
      themes = preset;
    } else {
      const pool = mood.themes
        .map((id) => THEME_BY_ID.get(id))
        .filter((t): t is FurTheme => Boolean(t));
      const rng = mulberry32(hashString(cleanPrompt) ^ seed);
      themes = [pick(rng, pool.length > 0 ? pool : [defaultTheme()])];
    }
  }

  const primary = themes[0] ?? defaultTheme();
  const eye = detectEye(cleanPrompt, primary);
  const accent = detectAccent(cleanPrompt, primary, mood);
  const explicitName = detectExplicitName(cleanPrompt);
  const emoji = detectEmoji(cleanPrompt);
  const fluffy =
    /蓬松|毛茸茸|长毛|fluffy|绒毛|软毛/.test(cleanPrompt) ||
    ((mood.id === 'sweet' || mood.id === 'dreamy' || mood.id === 'natural') && seed % 3 === 0);
  const spotsRequested = /斑点|斑块|花纹|斑纹|星点|spot|patch/.test(cleanPrompt);
  const shape = detectShape(cleanPrompt);

  const analysis: Analysis = {
    mood,
    themes,
    pattern,
    eye,
    accent,
    explicitName,
    emoji,
    fluffy,
    spotsRequested,
    shape,
  };

  const cat = buildSkin(analysis, cleanPrompt, seed);
  const traits: string[] = [];
  if (cat.tailFluffy) traits.push('蓬松尾巴');
  if (cat.tailStripes) traits.push('环纹尾');
  if (cat.spots && cat.spots.length > 0) traits.push('专属斑纹');
  if (cat.earTuftColor) traits.push('耳尖毛');
  if (mood.id === 'cyber' || mood.id === 'dreamy') traits.push('微光眼');
  if (cat.eyeCatchlight) traits.push('亮眸');
  if (cat.earShape && cat.earShape !== 'cat') traits.push(SHAPE_LABELS[cat.earShape]);
  for (const accessory of cat.accessories ?? []) traits.push(ACCESSORY_LABELS[accessory] ?? accessory);

  const summary: PetDesignSummary = {
    moodLabel: mood.label,
    patternLabel: PATTERN_LABELS[pattern],
    furLabel: primary.label,
    eyeLabel: eye.label,
    accentLabel: accentName(accent),
    traits,
  };

  return { cat, summary };
}

/* ------------------------------------------------------------------ */
/* Character adaptation (studio search)                               */
/* ------------------------------------------------------------------ */

/** Explicit colours for a character, already adapted from a reference. */
export interface PalettePetInput {
  name: string;
  emoji?: string;
  fur: string;
  furSecondary?: string;
  belly?: string;
  mask?: string;
  stripe?: string;
  patch?: string;
  tailTip?: string;
  eye?: string;
  eyeBottom?: string;
  accent?: string;
  pattern?: CatPattern;
  fluffy?: boolean;
  /** Character silhouette extras — what makes a match look like the character. */
  earShape?: CatEarShape;
  accessories?: CatAccessory[];
  accessoryColor?: string;
  cheek?: string;
  species?: CatSpecies;
  tailStyle?: CatTailStyle;
  faceStyle?: CatFaceStyle;
  whiskers?: boolean;
  earTip?: string;
}

function inferPatternFromPalette(input: PalettePetInput): CatPattern {
  if (input.pattern) return input.pattern;
  if (input.stripe) return 'tabby';
  if (input.patch) return 'calico';
  if (input.mask) {
    return luminance(input.mask) < luminance(input.fur) - 0.1 ? 'siamese' : 'bicolor';
  }
  if (input.belly && isLight(input.belly) && !isLight(input.fur)) {
    return isVeryDark(input.fur) ? 'tuxedo' : 'bicolor';
  }
  return 'solid';
}

/**
 * Builds a skin straight from a character palette (fur / eye / accent colours),
 * then re-applies the explicit markings so the coat stays faithful to the
 * reference instead of being re-derived by the pattern heuristics.
 */
/**
 * Accessories drawn in the character accent can vanish against same-hued fur
 * (Miku's teal headband on teal fur). Nudge them away from the coat lightness.
 */
function defaultTail(species: CatSpecies): CatTailStyle {
  if (species === 'hedgehog') return 'bolt';
  if (species === 'ghost' || species === 'star') return 'none';
  if (species !== 'cat') return 'puff';
  return 'cat';
}

function defaultFace(species: CatSpecies): CatFaceStyle {
  if (species === 'ghost' || species === 'duck') return 'none';
  if (species !== 'cat') return 'button';
  return 'cat';
}

function contrastAccessory(color: string, fur: string): string {
  const a = luminance(color);
  const b = luminance(fur);
  if (Math.abs(a - b) >= 0.22) return color;
  return b > 0.5 ? darken(color, 0.55) : lighten(color, 0.46);
}

export function generateCatFromPalette(input: PalettePetInput, seed = Date.now()): PetDesignResult {
  const fur = input.fur || '#c9a37a';
  const eyeTop = input.eye || '#c98a2e';
  const pattern = inferPatternFromPalette(input);
  const rng = mulberry32(hashString(`${input.name}-${fur}-${seed}`) ^ seed);

  const primary: FurTheme = {
    id: 'custom',
    label: colorName(fur),
    keywords: [],
    base: fur,
    secondary: input.furSecondary ?? darken(fur, 0.1),
    light: input.belly ?? lighten(fur, 0.35),
    eye: [eyeTop, input.eyeBottom ?? lighten(eyeTop, 0.32)],
    accent: input.accent ?? eyeTop,
    names: [input.name],
    emoji: input.emoji ?? '🐱',
    weight: 1,
  };
  const themes: FurTheme[] = input.furSecondary
    ? [
        primary,
        {
          ...primary,
          id: 'custom-alt',
          label: colorName(input.furSecondary),
          base: input.furSecondary,
          secondary: darken(input.furSecondary, 0.1),
          light: input.belly ?? lighten(input.furSecondary, 0.3),
          eye: [eyeTop, input.eyeBottom ?? lighten(eyeTop, 0.32)],
          accent: input.accent ?? eyeTop,
        },
      ]
    : [primary];

  const mood = MOODS.find((entry) => entry.id === 'neutral') ?? MOODS[0];
  const eye: EyeTheme = {
    id: 'custom',
    label: `${colorName(eyeTop)}眼`,
    keywords: [],
    top: eyeTop,
    bottom: input.eyeBottom ?? lighten(eyeTop, 0.32),
  };

  const prompt = [
    `${colorName(fur)}毛`,
    input.belly ? '白色肚皮' : '',
    `${colorName(eyeTop)}眼睛`,
    PATTERN_LABELS[pattern],
    input.fluffy ? '尾巴蓬松' : '',
  ]
    .filter(Boolean)
    .join('，');

  const species: CatSpecies = input.species ?? 'cat';
  const analysis: Analysis = {
    mood,
    themes,
    pattern,
    eye,
    accent: input.accent ?? eyeTop,
    explicitName: input.name,
    emoji: input.emoji ?? '🐱',
    fluffy: Boolean(input.fluffy),
    spotsRequested: false,
    shape: {
      earShape: input.earShape ?? 'cat',
      accessories: input.accessories ?? [],
      accessoryColor: contrastAccessory(
        input.accessoryColor ?? input.accent ?? eyeTop,
        fur,
      ),
      cheek: input.cheek ?? null,
      species,
      tailStyle: input.tailStyle ?? defaultTail(species),
      faceStyle: input.faceStyle ?? defaultFace(species),
      whiskers: input.whiskers ?? species === 'cat',
      earTipColor: input.earTip ?? null,
    },
  };

  const cat = buildSkin(analysis, prompt, seed);

  // Re-apply the reference's own markings on top of the pattern defaults.
  if (input.belly) {
    cat.bellyBibColor = input.belly;
    if (pattern === 'tuxedo' || pattern === 'solid') cat.pawColor = input.belly;
  }
  if (input.mask && (pattern === 'siamese' || pattern === 'bicolor')) {
    cat.maskColor = input.mask;
    cat.earOuterColor = input.mask;
    cat.earTipColor = darken(input.mask, 0.08);
    cat.tailColor = input.mask;
    cat.tailTipColor = input.tailTip ?? darken(input.mask, 0.12);
  }
  if (input.stripe && pattern === 'tabby') {
    cat.stripeColor = input.stripe;
    cat.earTipColor = input.stripe;
    cat.tailTipColor = input.tailTip ?? input.stripe;
  }
  if (input.patch && pattern === 'calico') cat.calicoPatchColor = input.patch;
  if (input.tailTip) cat.tailTipColor = input.tailTip;
  if (pattern === 'solid' && input.belly) {
    cat.bellyBibColor = input.belly;
  }

  cat.id = `studio-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cat'}-${seed.toString(36).slice(-4)}`;
  cat.name = input.name;
  cat.emoji = input.emoji ?? '🐱';
  cat.builtin = false;
  void rng;

  const traits: string[] = [];
  if (cat.tailFluffy) traits.push('蓬松尾巴');
  if (cat.tailStripes) traits.push('环纹尾');
  if (cat.spots && cat.spots.length > 0) traits.push('专属斑纹');
  if (cat.earTuftColor) traits.push('耳尖毛');
  if (cat.earShape && cat.earShape !== 'cat') traits.push(SHAPE_LABELS[cat.earShape]);
  for (const accessory of cat.accessories ?? []) traits.push(ACCESSORY_LABELS[accessory] ?? accessory);

  const summary: PetDesignSummary = {
    moodLabel: '还原',
    patternLabel: PATTERN_LABELS[pattern],
    furLabel: colorName(cat.furColor),
    eyeLabel: eye.label,
    accentLabel: accentName(cat.accentColor ?? eyeTop),
    traits,
  };

  return { cat, summary };
}

function accentName(hex: string): string {
  const { h } = hexToHsl(hex);
  if (h < 15 || h >= 345) return '珊瑚光';
  if (h < 45) return '暖橘光';
  if (h < 70) return '蜂蜜光';
  if (h < 160) return '薄荷光';
  if (h < 200) return '湖水光';
  if (h < 255) return '冰蓝光';
  if (h < 290) return '星紫光';
  if (h < 345) return '莓果光';
  return '柔光';
}

/**
 * Re-run the generator with a different pattern while preserving the prompt's
 * colours and mood. Used by the studio's fine-tune chips.
 */
export function regenerateWithPattern(
  prompt: string,
  pattern: CatPattern,
  seed: number,
): PetDesignResult {
  const cleaned = (prompt || '').replace(
    /三花|三色猫|花猫|calico|三色|奶牛|黑白猫|白胸|白爪|白袜子|燕尾服|tuxedo|虎斑|条纹|鱼骨纹|狸花|虎纹|tabby|暹罗|重点色|siamese|脸黑|黑脸|挖煤|布偶|双色|白脸|白腿|bicolor|ragdoll|纯色|单色|solid/g,
    ' ',
  );
  return generateCatFromPrompt(`${cleaned.trim()} ${PATTERN_LABELS[pattern]}`.trim(), seed);
}

export function patternDisplayName(pattern: CatPattern | undefined): string {
  return pattern ? PATTERN_LABELS[pattern] : '纯色';
}

/* ------------------------------------------------------------------ */
/* Inspiration                                                         */
/* ------------------------------------------------------------------ */

const INSPIRATIONS: string[] = [
  '一只奶油白的布偶猫，蓝宝石眼睛，粉色小鼻子，尾巴蓬松',
  '一只 midnight 黑猫，金色眼睛，尾巴尖有一撮白毛',
  '橘色虎斑猫，白色下巴和白手套，绿色眼睛',
  '三花猫，橘子酱和深棕斑块，琥珀色眼睛',
  '暹罗猫，奶油色身体，深棕色脸和耳朵，蓝宝石眼睛',
  '黑白奶牛猫，白胸白爪，黄绿色眼睛',
  '雾霾蓝的英短，圆脸，金色眼睛，蓬松尾巴',
  '樱花粉的小猫，蓝色眼睛，白色肚皮，软软的',
  '薄荷绿的猫咪，深绿条纹，黄色眼睛',
  '星空般的深蓝猫，紫色眼睛，银色胡须，神秘高冷',
  '焦糖奶茶色的猫咪，白色小围嘴，琥珀色眼睛',
  '银灰色的猫，蓝色眼睛，黑色尾尖，气质优雅',
  '戴着红色围巾的橘白猫，金色眼睛，活泼好动',
  '巧克力色的猫，焦糖色条纹，金色眼睛，复古温柔',
  '香芋紫的小猫，金色眼睛，白色胸口，梦幻可爱',
  '赛博霓虹蓝猫，青色发光眼睛，黑色爪垫，未来感',
  '奶白色小猫，蓝色眼睛，粉色项圈，甜甜的',
  '深灰色狸花猫，黑色条纹，琥珀色眼睛，机灵',
  '一只很酷的黑猫， Lime 绿色眼睛，短毛，高冷',
  '一只软软的奶油色小猫，圆眼睛，蓬松尾巴，治愈',
];

export function randomInspiration(seed = Date.now()): string {
  const rng = mulberry32(seed);
  return pick(rng, INSPIRATIONS);
}

export function allInspirations(): string[] {
  return [...INSPIRATIONS];
}
