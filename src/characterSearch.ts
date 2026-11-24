import type { CharacterPalette } from './characterLibrary';
import { findInLibrary } from './characterLibrary';

/** A searchable character, already translated into a pet palette. */
export interface CharacterMatch {
  id: string;
  name: string;
  native?: string;
  source?: string;
  emoji?: string;
  palette: CharacterPalette;
  fromLibrary: boolean;
  /** Where the palette came from, shown in the result row. */
  origin: '内置角色库' | '联网 · 角色描述' | '联网 · 名称配色';
  imageUrl?: string;
}

const CACHE_KEY = 'kurocat.studio.character-search';
const CACHE_TTL = 1000 * 60 * 60; // 1 hour
const SEARCH_TIMEOUT = 7000;

interface CacheEntry {
  at: number;
  results: CharacterMatch[];
}

/* ------------------------------------------------------------------ */
/* Colour words → hex                                                  */
/* ------------------------------------------------------------------ */

interface ColorWord {
  words: string[];
  hex: string;
}

const COLOR_WORDS: ColorWord[] = [
  { words: ['漆黑', '墨黑', '乌黑', '黑色', '黑', 'black', 'noir', '黒', 'ダーク'], hex: '#1b1b1f' },
  { words: ['雪白', '纯白', '乳白', '白色', '白', 'white', 'snow', '白い'], hex: '#f4f4f6' },
  { words: ['银白', '银灰', '银色', '银', 'silver', 'シルバー'], hex: '#c9ccd4' },
  { words: ['灰色', '灰白', '灰', 'gray', 'grey', 'グレー'], hex: '#9aa0ad' },
  { words: ['棕色', '褐色', '棕', '褐', 'brown', '茶色', 'ブラウン'], hex: '#a9744a' },
  { words: ['米色', '米白', '奶油', '奶白', 'cream', 'beige', 'クリーム'], hex: '#f0e0c0' },
  { words: ['金色', '金黄', '金', 'gold', 'blonde', '金髪', 'ブロンド'], hex: '#e8c15a' },
  { words: ['黄色', '柠檬', '鹅黄', '黄', 'yellow', 'イエロー'], hex: '#f2d24e' },
  { words: ['橙色', '橘色', '橘黄', '橙', '橘', 'orange', 'オレンジ'], hex: '#e8913c' },
  { words: ['红色', '鲜红', '绯红', '红', '赤', 'red', 'レッド'], hex: '#d94f3d' },
  { words: ['粉色', '樱粉', '粉红', '桃粉', '粉', 'pink', 'ピンク'], hex: '#f2a0c0' },
  { words: ['紫色', '紫罗兰', '紫', 'violet', 'purple', 'パープル'], hex: '#8a63c9' },
  { words: ['蓝色', '深蓝', '天蓝', '海蓝', '蓝', '青蓝', 'blue', 'ブルー'], hex: '#4a7fc9' },
  { words: ['青色', '青绿', '碧绿', '青', 'teal', 'cyan', 'ターコイズ'], hex: '#39c5bb' },
  { words: ['绿色', '翠绿', '草绿', '绿', 'green', 'グリーン'], hex: '#4a9e6b' },
];

const EYE_HINTS = ['眼', '瞳', 'eye', 'eyes', '目'];
const HAIR_HINTS = ['发', '头发', 'hair', '髪'];
const PATTERN_WORDS: { words: string[]; pattern: CharacterPalette['pattern'] }[] = [
  { words: ['虎斑', '条纹', '虎纹', '鱼骨纹', 'striped', 'tabby', 'ストライプ'], pattern: 'tabby' },
  { words: ['三花', '三色', '花猫', 'calico', 'トライカラー'], pattern: 'calico' },
  { words: ['奶牛', '黑白', '燕尾服', 'tuxedo', 'タキシード'], pattern: 'tuxedo' },
  { words: ['暹罗', '重点色', 'siamese', 'シャム'], pattern: 'siamese' },
  { words: ['双色', '白胸', '白脸', '白爪', 'bicolor', 'ragdoll'], pattern: 'bicolor' },
];

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ');
}

/** Finds the colour word closest to a body-part hint ("blue eyes" → blue). */
function colorWordNear(text: string, index: number): ColorWord | null {
  let best: ColorWord | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const word of COLOR_WORDS) {
    for (const w of word.words) {
      let at = text.indexOf(w);
      while (at >= 0) {
        const distance = Math.abs(at - index);
        if (distance <= w.length + 18 && distance < bestDistance) {
          bestDistance = distance;
          best = word;
        }
        at = text.indexOf(w, at + 1);
      }
    }
  }
  return best;
}

/**
 * Pulls fur / eye / accent colours out of a free-text character description
 * (English, Japanese or Chinese). Returns null when nothing is recognisable.
 */
export function paletteFromDescription(
  name: string,
  description: string,
): CharacterPalette | null {
  const text = normalizeText(description || '');
  const found: { hex: string; at: number; word: string }[] = [];
  for (const word of COLOR_WORDS) {
    for (const w of word.words) {
      const at = text.indexOf(w);
      if (at >= 0) found.push({ hex: word.hex, at, word: w });
    }
  }
  if (found.length === 0) return null;
  found.sort((a, b) => a.at - b.at);

  let eye: string | undefined;
  for (const hint of EYE_HINTS) {
    let cursor = text.indexOf(hint);
    while (cursor >= 0 && !eye) {
      const word = colorWordNear(text, cursor);
      if (word) eye = word.hex;
      cursor = text.indexOf(hint, cursor + hint.length);
    }
    if (eye) break;
  }

  let hair: string | undefined;
  for (const hint of HAIR_HINTS) {
    let cursor = text.indexOf(hint);
    while (cursor >= 0 && !hair) {
      const word = colorWordNear(text, cursor);
      if (word) hair = word.hex;
      cursor = text.indexOf(hint, cursor + hint.length);
    }
    if (hair) break;
  }

  const fur = hair ?? found[0].hex;
  const accent = found.find((entry) => entry.hex !== fur && entry.hex !== eye)?.hex;
  const second = found.find((entry) => entry.hex !== fur)?.hex;

  let pattern: CharacterPalette['pattern'];
  for (const rule of PATTERN_WORDS) {
    if (rule.words.some((word) => text.includes(word))) {
      pattern = rule.pattern;
      break;
    }
  }

  return {
    id: `remote-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    aliases: [],
    fur,
    furSecondary: second && second !== fur ? second : undefined,
    eye,
    accent: accent ?? eye,
    pattern,
  };
}

/* ------------------------------------------------------------------ */
/* Deterministic fallback palette                                      */
/* ------------------------------------------------------------------ */

function hueToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function hashOf(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Pleasant, stable palette when a character has no colour information at all. */
export function paletteFromName(name: string): CharacterPalette {
  const hash = hashOf(name);
  const hue = hash % 360;
  const hue2 = (hue + 150 + (hash % 90)) % 360;
  return {
    id: `remote-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    aliases: [],
    fur: hueToHex(hue, 0.42, 0.62),
    furSecondary: hueToHex(hue, 0.36, 0.5),
    eye: hueToHex(hue2, 0.55, 0.55),
    eyeBottom: hueToHex(hue2, 0.6, 0.78),
    accent: hueToHex(hue2, 0.7, 0.62),
    pattern: hue % 5 === 0 ? 'tabby' : hue % 3 === 0 ? 'bicolor' : 'solid',
  };
}

/* ------------------------------------------------------------------ */
/* Remote providers                                                    */
/* ------------------------------------------------------------------ */

interface RemoteCharacter {
  id: string;
  name: string;
  native?: string;
  source?: string;
  imageUrl?: string;
  description?: string;
}

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
const JIKAN_ENDPOINT = 'https://api.jikan.moe/v4/characters';

const ANILIST_QUERY = `
query ($search: String) {
  Page(perPage: 6) {
    characters(search: $search) {
      id
      name { full native alternative }
      image { large medium }
      description(asHtml: false)
      media(perPage: 2, sort: POPULARITY_DESC) {
        nodes { title { romaji native english } }
      }
    }
  }
}`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function searchAniList(query: string): Promise<RemoteCharacter[]> {
  const json = await fetchJson(ANILIST_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: ANILIST_QUERY, variables: { search: query } }),
  });
  const root = asRecord(json);
  const data = asRecord(root?.data);
  const page = asRecord(data?.Page);
  const list = Array.isArray(page?.characters) ? (page?.characters as unknown[]) : [];
  const results: RemoteCharacter[] = [];
  for (const item of list) {
    const char = asRecord(item);
    if (!char) continue;
    const name = asRecord(char.name);
    const fullName = asString(name?.full) ?? asString(name?.native);
    if (!fullName) continue;
    const image = asRecord(char.image);
    const media = asRecord(char.media);
    const nodes = Array.isArray(media?.nodes) ? (media?.nodes as unknown[]) : [];
    const mediaNode = asRecord(nodes[0]);
    const title = asRecord(mediaNode?.title);
    const source = asString(title?.native) ?? asString(title?.romaji) ?? asString(title?.english);
    results.push({
      id: `anilist-${String(char.id ?? fullName)}`,
      name: fullName,
      native: asString(name?.native),
      source,
      imageUrl: asString(image?.large) ?? asString(image?.medium),
      description: asString(char.description),
    });
  }
  return results;
}

async function searchJikan(query: string): Promise<RemoteCharacter[]> {
  const json = await fetchJson(`${JIKAN_ENDPOINT}?q=${encodeURIComponent(query)}&limit=6`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  const root = asRecord(json);
  const list = Array.isArray(root?.data) ? (root?.data as unknown[]) : [];
  const results: RemoteCharacter[] = [];
  for (const item of list) {
    const char = asRecord(item);
    if (!char) continue;
    const name = asString(char.name);
    if (!name) continue;
    const images = asRecord(char.images);
    const jpg = asRecord(images?.jpg);
    results.push({
      id: `jikan-${String(char.mal_id ?? name)}`,
      name,
      imageUrl: asString(jpg?.image_url),
      description: asString(char.about),
    });
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

function readCache(): Map<string, CacheEntry> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
    const map = new Map<string, CacheEntry>();
    for (const [key, entry] of Object.entries(parsed)) {
      if (Date.now() - entry.at < CACHE_TTL) map.set(key, entry);
    }
    return map;
  } catch {
    return new Map();
  }
}

function writeCache(cache: Map<string, CacheEntry>): void {
  try {
    const out: Record<string, CacheEntry> = {};
    for (const [key, entry] of cache) out[key] = entry;
    localStorage.setItem(CACHE_KEY, JSON.stringify(out));
  } catch {
    /* storage full / private mode — caching is best effort */
  }
}

/* ------------------------------------------------------------------ */
/* Public search                                                       */
/* ------------------------------------------------------------------ */

export interface SearchOptions {
  /** Set false to answer purely from the bundled library (offline mode). */
  remote?: boolean;
  signal?: AbortSignal;
}

function libraryMatches(query: string): CharacterMatch[] {
  return findInLibrary(query).map((palette) => ({
    id: palette.id,
    name: palette.name,
    source: palette.source,
    emoji: palette.emoji,
    palette,
    fromLibrary: true,
    origin: '内置角色库',
  }));
}

function toMatch(char: RemoteCharacter): CharacterMatch {
  const described = paletteFromDescription(char.name, char.description ?? '');
  const palette = described ?? paletteFromName(char.name);
  return {
    id: char.id,
    name: char.name,
    native: char.native,
    source: char.source,
    emoji: described ? undefined : '🌐',
    palette,
    fromLibrary: false,
    origin: described ? '联网 · 角色描述' : '联网 · 名称配色',
    imageUrl: char.imageUrl,
  };
}

/**
 * Searches the bundled character library first (instant), then falls back to
 * AniList and Jikan so any anime / manga character can be adapted too.
 */
export async function searchCharacters(
  query: string,
  options: SearchOptions = {},
): Promise<CharacterMatch[]> {
  const clean = (query || '').trim();
  if (!clean) return [];

  const local = libraryMatches(clean);
  if (local.length > 0 || options.remote === false) return local;

  const cacheKey = clean.toLowerCase();
  const cache = readCache();
  const cached = cache.get(cacheKey);
  if (cached) return cached.results;

  const collected: CharacterMatch[] = [];
  const seen = new Set<string>();
  const push = (match: CharacterMatch): void => {
    const key = match.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    collected.push(match);
  };

  let failures = 0;
  try {
    for (const char of await searchAniList(clean)) push(toMatch(char));
  } catch {
    failures += 1;
  }

  if (collected.length === 0) {
    try {
      for (const char of await searchJikan(clean)) push(toMatch(char));
    } catch {
      failures += 1;
    }
  }

  if (collected.length === 0 && failures > 0) {
    throw new Error('character search unreachable');
  }

  if (collected.length > 0) {
    cache.set(cacheKey, { at: Date.now(), results: collected });
    writeCache(cache);
  }
  return collected;
}
