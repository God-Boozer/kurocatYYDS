import './studio.css';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { DEFAULT_TAIL_KEY_IDS, KuroCatEngine } from './catEngine';
import type { CatPattern, CatSkinConfig } from './catSkins';
import {
  allInspirations,
  colorName,
  generateCatFromPalette,
  generateCatFromPrompt,
  patternDisplayName,
  randomInspiration,
  regenerateWithPattern,
  shiftLuminance,
  type PetDesignResult,
  type PetDesignSummary,
} from './petDesigner';
import { searchCharacters, type CharacterMatch } from './characterSearch';
import { keyboardEventToVk } from './keyToVk';
import type { KuroCatEngine3D } from './catEngine3d';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const LOCAL_CATS_KEY = 'kurocat.studio.cats';
const LOCAL_PROMPTS_KEY = 'kurocat.studio.prompts';

const EMOJI_CHOICES = [
  '🐈‍⬛',
  '🐱',
  '🐈',
  '🐶',
  '🦊',
  '🐼',
  '🐸',
  '🐧',
  '🐳',
  '🦋',
  '🍓',
  '🍬',
  '🌙',
  '⭐',
  '🍵',
  '🫐',
  '🍑',
  '🍇',
  '🌼',
  '🧁',
  '🪐',
  '🌌',
  '🖤',
  '🤍',
  '💙',
  '💗',
];

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

const stage = byId<HTMLDivElement>('studio-stage');
const canvas = byId<HTMLCanvasElement>('studio-canvas');
const canvas3d = byId<HTMLCanvasElement>('studio-canvas-3d');
const promptInput = byId<HTMLTextAreaElement>('studio-prompt');
const charCountEl = byId<HTMLSpanElement>('studio-char-count');
const generateBtn = byId<HTMLButtonElement>('btn-studio-generate');
const diceBtn = byId<HTMLButtonElement>('btn-studio-dice');
const inspirationRow = byId<HTMLDivElement>('inspiration-chips');
const nameInput = byId<HTMLInputElement>('studio-name');
const subtitleEl = byId<HTMLSpanElement>('studio-subtitle');
const emojiBtn = byId<HTMLButtonElement>('studio-emoji');
const emojiPop = byId<HTMLDivElement>('emoji-pop');
const paletteEl = byId<HTMLDivElement>('studio-palette');
const traitsEl = byId<HTMLDivElement>('studio-traits');
const tuneFur = byId<HTMLInputElement>('tune-fur');
const tuneEye = byId<HTMLInputElement>('tune-eye');
const tuneAccent = byId<HTMLInputElement>('tune-accent');
const fluffyToggle = byId<HTMLInputElement>('tune-fluffy');
const patternRow = byId<HTMLDivElement>('pattern-chips');
const saveBtn = byId<HTMLButtonElement>('btn-studio-save');
const saveNote = byId<HTMLParagraphElement>('studio-save-note');
const savedRow = byId<HTMLDivElement>('saved-row');
const savedChips = byId<HTMLDivElement>('saved-chips');
const statusEl = byId<HTMLSpanElement>('studio-status');
const loadingEl = byId<HTMLDivElement>('studio-loading');
const toastEl = byId<HTMLDivElement>('studio-toast');
const closeBtn = byId<HTMLButtonElement>('btn-studio-close');
const stageTypeInput = byId<HTMLInputElement>('stage-type-input');
const searchInput = byId<HTMLInputElement>('studio-search');
const searchBtn = byId<HTMLButtonElement>('btn-studio-search');
const searchResults = byId<HTMLDivElement>('search-results');
const searchHint = byId<HTMLParagraphElement>('search-hint');

const engine = new KuroCatEngine(canvas, { embedded: true });
engine.showKeyBubbles = true;
engine.setKeyboardConfig('65', 'cat');
engine.setTailKeyConfig('smart', DEFAULT_TAIL_KEY_IDS);
// The workshop stage is a showcase, so let the 2D preview fill a bit more of it.
engine.setRenderScale(1.35);
engine.start();

let engine3d: KuroCatEngine3D | null = null;
let loading3d = false;
let webglBlocked = false;
let active3d = false;
let mode: '2d' | '3d' = '2d';
let current: PetDesignResult | null = null;
let currentPrompt = '';
let seed = Date.now();
let savedCats: CatSkinConfig[] = [];
let toastTimer: number | null = null;
let activeCharacter: CharacterMatch | null = null;
let characterPrompt = '';
let searchSeq = 0;

/* ------------------------------------------------------------------ */
/* Local storage helpers                                               */
/* ------------------------------------------------------------------ */

function readLocalCats(): CatSkinConfig[] {
  try {
    const raw = localStorage.getItem(LOCAL_CATS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CatSkinConfig[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalCat(cat: CatSkinConfig): void {
  try {
    const list = readLocalCats();
    const idx = list.findIndex((c) => c.id === cat.id);
    if (idx >= 0) list[idx] = cat;
    else list.push(cat);
    localStorage.setItem(LOCAL_CATS_KEY, JSON.stringify(list));
  } catch {
    // localStorage can be unavailable in hardened webviews; saving is best-effort.
  }
}

function savePromptForCat(id: string, prompt: string): void {
  try {
    const raw = localStorage.getItem(LOCAL_PROMPTS_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    map[id] = prompt;
    localStorage.setItem(LOCAL_PROMPTS_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

function promptForCat(id: string): string | null {
  try {
    const raw = localStorage.getItem(LOCAL_PROMPTS_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, string>;
    return map[id] ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* UI helpers                                                          */
/* ------------------------------------------------------------------ */

function toast(message: string, error = false): void {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  toastEl.classList.toggle('error', error);
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.classList.add('hidden');
    toastTimer = null;
  }, error ? 3600 : 2400);
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function syncModeButtons(): void {
  stage.querySelectorAll<HTMLButtonElement>('[data-studio-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.studioMode === mode);
  });
}

function updateCharCount(): void {
  charCountEl.textContent = `${promptInput.value.length} / 240`;
}

function renderPalette(cat: CatSkinConfig): void {
  const items: Array<{ label: string; color: string }> = [
    { label: '毛色', color: cat.furColor },
    {
      label: '花纹',
      color:
        cat.stripeColor ||
        cat.maskColor ||
        cat.calicoPatchColor ||
        cat.furSecondaryColor ||
        cat.furColor,
    },
    { label: '眼睛', color: cat.eyeColorTop },
    { label: '键盘光', color: cat.accentColor || '#d4f044' },
  ];
  paletteEl.innerHTML = '';
  for (const item of items) {
    const swatch = document.createElement('div');
    swatch.className = 'palette-swatch';
    const chip = document.createElement('i');
    chip.style.background = item.color;
    const label = document.createElement('span');
    label.textContent = item.label;
    swatch.append(chip, label);
    paletteEl.appendChild(swatch);
  }
}

function renderTraits(result: PetDesignResult): void {
  const cat = result.cat;
  const chips: Array<{ label: string; color?: string; accent?: boolean }> = [
    { label: result.summary.moodLabel, accent: true },
    { label: result.summary.patternLabel, color: cat.stripeColor || cat.maskColor || cat.calicoPatchColor },
    { label: result.summary.furLabel, color: cat.furColor },
    { label: result.summary.eyeLabel, color: cat.eyeColorTop },
    { label: result.summary.accentLabel, color: cat.accentColor },
    ...result.summary.traits.map((t) => ({ label: t })),
  ];
  traitsEl.innerHTML = '';
  for (const chip of chips) {
    const el = document.createElement('span');
    el.className = `trait-chip${chip.accent ? ' accent' : ''}`;
    if (chip.color) {
      const dot = document.createElement('i');
      dot.style.setProperty('--chip-color', chip.color);
      el.appendChild(dot);
    }
    el.appendChild(document.createTextNode(chip.label));
    traitsEl.appendChild(el);
  }
}

function renderPatternChips(pattern: CatPattern): void {
  patternRow.querySelectorAll<HTMLButtonElement>('[data-studio-pattern]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.studioPattern === pattern);
  });
}

function summaryForSavedCat(cat: CatSkinConfig): PetDesignSummary {
  return {
    moodLabel: '我的角色',
    patternLabel: patternDisplayName(cat.pattern),
    furLabel: colorName(cat.furColor),
    eyeLabel: colorName(cat.eyeColorTop),
    accentLabel: colorName(cat.accentColor || '#d4f044'),
    traits: cat.tailFluffy ? ['蓬松尾巴'] : [],
  };
}

function applyResult(result: PetDesignResult): void {
  current = result;
  const cat = result.cat;

  engine.setCatAppearance(cat.id, cat);
  engine3d?.setCatSkin(cat);

  if (document.activeElement !== nameInput) nameInput.value = cat.name;
  emojiBtn.textContent = cat.emoji || '🐱';
  subtitleEl.textContent = `${patternDisplayName(cat.pattern)} · ${result.summary.eyeLabel} · ${result.summary.moodLabel}`;
  tuneFur.value = cat.furColor;
  tuneEye.value = cat.eyeColorTop;
  tuneAccent.value = cat.accentColor || '#d4f044';
  fluffyToggle.checked = Boolean(cat.tailFluffy);

  renderPatternChips(cat.pattern || 'solid');
  renderPalette(cat);
  renderTraits(result);
  setStatus(`已生成 · ${patternDisplayName(cat.pattern)} · ${result.summary.furLabel}`);
}

function generateFromPrompt(nextSeed = Date.now()): void {
  const prompt = promptInput.value.trim() || randomInspiration(nextSeed);
  currentPrompt = prompt;
  seed = nextSeed;
  // When the prompt is still the auto-written description of a searched
  // character, keep the exact adapted palette instead of re-parsing the text.
  const result =
    activeCharacter && prompt === characterPrompt
      ? generateCatFromPalette(activeCharacter.palette, nextSeed)
      : generateCatFromPrompt(prompt, nextSeed);
  if (!activeCharacter || prompt !== characterPrompt) activeCharacter = null;
  applyResult(result);
  stage.classList.remove('flash');
  // Force a reflow so the flash animation can restart on rapid regeneration.
  void stage.offsetWidth;
  stage.classList.add('flash');
}

function setPrompt(prompt: string, generate = true): void {
  promptInput.value = prompt;
  updateCharCount();
  if (generate) generateFromPrompt(Date.now());
}

/* ------------------------------------------------------------------ */
/* Character search                                                    */
/* ------------------------------------------------------------------ */

const EAR_SHAPE_PROMPT: Record<string, string> = {
  long: '长耳朵',
  round: '圆耳朵',
  fold: '垂耳',
};

const ACCESSORY_PROMPT: Record<string, string> = {
  bow: '蝴蝶结',
  bell: '铃铛',
  glasses: '眼镜',
  ahoge: '呆毛',
  headband: '发带',
  hat: '帽子',
};

function describeCharacterPrompt(match: CharacterMatch): string {
  const palette = match.palette;
  const parts = [`${match.name}风格`, `${colorName(palette.fur)}毛色`];
  if (palette.belly) parts.push('白色肚皮');
  parts.push(`${colorName(palette.eye ?? '#c98a2e')}眼睛`);
  if (palette.stripe) parts.push('虎斑条纹');
  if (palette.mask) parts.push('深色重点色');
  if (palette.patch) parts.push('三色斑块');
  if (palette.fluffy) parts.push('尾巴蓬松');
  if (palette.earShape && EAR_SHAPE_PROMPT[palette.earShape]) {
    parts.push(EAR_SHAPE_PROMPT[palette.earShape]);
  }
  for (const item of palette.accessories ?? []) {
    const word = ACCESSORY_PROMPT[item];
    if (word) parts.push(word);
  }
  if (palette.cheek) parts.push('腮红');
  return parts.join('，');
}

function applyCharacterMatch(match: CharacterMatch): void {
  const result = generateCatFromPalette(match.palette, Date.now());
  activeCharacter = match;
  characterPrompt = describeCharacterPrompt(match);
  promptInput.value = characterPrompt;
  updateCharCount();
  applyResult(result);
  stage.classList.remove('flash');
  void stage.offsetWidth;
  stage.classList.add('flash');
  searchResults.classList.add('hidden');
  searchHint.textContent = `已还原「${match.name}」的外形与配色，下面还能继续微调`;
  toast(`已还原「${match.name}」（耳朵 / 配件 / 配色）`);
}

function renderSearchResults(matches: CharacterMatch[], query: string): void {
  searchResults.innerHTML = '';
  if (matches.length === 0) {
    searchResults.classList.add('hidden');
    searchHint.textContent = `没找到「${query}」。试试英文名 / 罗马音（如 Rem、Pikachu），或直接用下面的文字描述。`;
    return;
  }

  for (const match of matches) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'search-hit';
    btn.setAttribute('role', 'option');

    const swatches = [
      match.palette.fur,
      match.palette.belly ?? match.palette.furSecondary ?? match.palette.fur,
      match.palette.eye ?? '#c98a2e',
      match.palette.accent ?? match.palette.eye ?? '#d4f044',
    ];
    const swatchHtml = swatches.map((color) => `<i style="background:${color}"></i>`).join('');
    btn.innerHTML = `<span class="hit-swatches">${swatchHtml}</span><span class="hit-text"><strong></strong><small></small></span><span class="hit-go">→</span>`;
    const nameEl = btn.querySelector('strong');
    const metaEl = btn.querySelector('small');
    if (nameEl) nameEl.textContent = match.name;
    const shapeBits = [
      match.palette.earShape && EAR_SHAPE_PROMPT[match.palette.earShape],
      ...(match.palette.accessories ?? []).map((item) => ACCESSORY_PROMPT[item]),
      match.palette.cheek ? '腮红' : '',
    ].filter(Boolean);
    if (metaEl) {
      metaEl.textContent = [match.source, match.origin, shapeBits.length ? shapeBits.join(' + ') : '']
        .filter(Boolean)
        .join(' · ');
    }

    btn.addEventListener('click', () => applyCharacterMatch(match));
    searchResults.appendChild(btn);
  }

  searchResults.classList.remove('hidden');
  searchHint.textContent = `找到 ${matches.length} 个，点击即可变成该角色（耳朵 / 配件 / 毛色 / 眼睛一起还原）`;
}

async function runCharacterSearch(): Promise<void> {
  const query = searchInput.value.trim();
  if (!query) {
    toast('先输入角色名，比如「初音未来」');
    searchInput.focus();
    return;
  }

  const seq = ++searchSeq;
  searchBtn.disabled = true;
  searchBtn.textContent = '搜索中…';
  searchHint.textContent = '正在搜索…';
  searchResults.classList.add('hidden');

  try {
    const matches = await searchCharacters(query);
    if (seq !== searchSeq) return;
    renderSearchResults(matches, query);
  } catch {
    if (seq !== searchSeq) return;
    searchHint.textContent = '联网搜索失败了，检查一下网络；也可以直接用下面的文字描述。';
  } finally {
    if (seq === searchSeq) {
      searchBtn.disabled = false;
      searchBtn.textContent = '搜索';
    }
  }
}

function renderSavedChips(): void {
  const custom = savedCats.filter((c) => !c.builtin).slice(0, 10);
  savedRow.classList.toggle('hidden', custom.length === 0);
  savedChips.innerHTML = '';
  for (const cat of custom) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'saved-chip';
    btn.classList.toggle('active', current?.cat.id === cat.id);
    btn.textContent = `${cat.emoji || '🐱'} ${cat.name}`;
    btn.title = cat.name;
    btn.addEventListener('click', () => loadSavedCat(cat));
    savedChips.appendChild(btn);
  }
}

function loadSavedCat(cat: CatSkinConfig): void {
  currentPrompt = promptForCat(cat.id) || `${patternDisplayName(cat.pattern)} ${cat.name}`;
  promptInput.value = currentPrompt;
  updateCharCount();
  applyResult({ cat: { ...cat }, summary: summaryForSavedCat(cat) });
  renderSavedChips();
  toast(`已载入「${cat.name}」`);
}

async function refreshSavedCats(): Promise<void> {
  if (isTauri) {
    try {
      const cats = await invoke<CatSkinConfig[]>('get_cats');
      savedCats = Array.isArray(cats) ? cats : [];
    } catch {
      savedCats = [];
    }
  } else {
    savedCats = readLocalCats();
  }
  renderSavedChips();
}

/* ------------------------------------------------------------------ */
/* Save                                                                */
/* ------------------------------------------------------------------ */

function currentCatForSave(): CatSkinConfig | null {
  if (!current) return null;
  const name = nameInput.value.trim() || current.cat.name;
  const emoji = emojiBtn.textContent?.trim() || current.cat.emoji;
  return {
    ...current.cat,
    name,
    emoji,
    pattern: current.cat.pattern || 'solid',
    furColor: tuneFur.value,
    eyeColorTop: tuneEye.value,
    accentColor: tuneAccent.value,
    tailFluffy: fluffyToggle.checked,
  };
}

async function saveCat(): Promise<void> {
  const cat = currentCatForSave();
  if (!cat) {
    toast('还没有可保存的角色', true);
    return;
  }
  saveBtn.disabled = true;
  const previousLabel = saveBtn.textContent;
  saveBtn.textContent = '保存中…';
  try {
    if (isTauri) {
      const saved = await invoke<CatSkinConfig>('save_studio_cat', { cat });
      current = { cat: saved, summary: current?.summary ?? summaryForSavedCat(saved) };
      savePromptForCat(saved.id, currentPrompt);
      toast('已保存并切换到桌面宠物');
      saveNote.textContent = `已保存「${saved.name}」— 右键桌面宠物即可切换角色`;
    } else {
      writeLocalCat(cat);
      savePromptForCat(cat.id, currentPrompt);
      current = { cat, summary: current?.summary ?? summaryForSavedCat(cat) };
      toast('已保存到浏览器预览');
      saveNote.textContent = `已保存「${cat.name}」— 桌面端会自动写入猫咪列表`;
    }
    await refreshSavedCats();
  } catch (err) {
    console.error('Failed to save studio cat:', err);
    toast(`保存失败：${typeof err === 'string' ? err : String(err)}`, true);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = previousLabel;
  }
}

/* ------------------------------------------------------------------ */
/* 2D / 3D preview                                                     */
/* ------------------------------------------------------------------ */

function activate2D(): void {
  mode = '2d';
  active3d = false;
  engine3d?.stop();
  canvas3d.classList.add('hidden');
  canvas.classList.remove('hidden');
  engine.resize();
  engine.start();
  syncModeButtons();
  setStatus(`2D 预览 · ${patternDisplayName(current?.cat.pattern)}`);
}

function activate3D(): void {
  if (!engine3d) return;
  mode = '3d';
  active3d = true;
  engine.stop();
  canvas.classList.add('hidden');
  canvas3d.classList.remove('hidden');
  engine3d.resize();
  engine3d.start();
  syncModeButtons();
  setStatus(`3D 预览 · ${patternDisplayName(current?.cat.pattern)}`);
}

async function enable3D(): Promise<void> {
  if (webglBlocked || loading3d) return;
  if (engine3d) {
    activate3D();
    return;
  }
  loading3d = true;
  loadingEl.classList.remove('hidden');
  try {
    const mod = await import('./catEngine3d');
    engine3d = new mod.KuroCatEngine3D(canvas3d, { embedded: true });
    engine3d.showKeyBubbles = true;
    engine3d.setRenderStyle('3d');
    if (current) engine3d.setCatSkin(current.cat);
    engine3d.setCollar('none');
    engine3d.setHeadphones(false);
    engine3d.setKeyboardConfig('65', 'cat');
    engine3d.setTailKeyConfig('smart', DEFAULT_TAIL_KEY_IDS);
    engine3d.setPrivacyMode(false);
    loading3d = false;
    activate3D();
  } catch (err) {
    console.warn('3D preview unavailable, falling back to 2D:', err);
    webglBlocked = true;
    loading3d = false;
    activate2D();
    toast('3D 预览不可用，已切换到 2D', true);
  } finally {
    loadingEl.classList.add('hidden');
  }
}

/* ------------------------------------------------------------------ */
/* Pointer + keyboard                                                  */
/* ------------------------------------------------------------------ */

function pointInStage(clientX: number, clientY: number): boolean {
  const rect = stage.getBoundingClientRect();
  return (
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}

function pointerToLogical(clientX: number, clientY: number): {
  relX: number;
  relY: number;
  inside: boolean;
} {
  const rect = stage.getBoundingClientRect();
  const { w: lw, h: lh } = engine.getLogicalSize();
  const fit = Math.min((rect.width * 0.86) / lw, (rect.height * 0.86) / lh);
  const drawW = lw * fit;
  const drawH = lh * fit;
  const ox = (rect.width - drawW) * 0.5;
  const oy = (rect.height - drawH) * 0.52;
  const relX = (clientX - rect.left - ox) / Math.max(1, drawW);
  const relY = (clientY - rect.top - oy) / Math.max(1, drawH);
  return { relX, relY, inside: pointInStage(clientX, clientY) };
}

function handlePointerMove(clientX: number, clientY: number): void {
  const { relX, relY, inside } = pointerToLogical(clientX, clientY);
  if (active3d && engine3d) {
    const overHead = engine3d.onPointerMove(clientX, clientY, inside, true);
    stage.classList.toggle('petting', overHead);
    return;
  }
  const overHead = inside && relX >= 0.3 && relX <= 0.72 && relY >= 0.14 && relY <= 0.52;
  stage.classList.toggle('petting', overHead);
  engine.onWindowCursor(relX, relY, overHead);
  engine.onPointerSpeedSample(clientX / 1440, clientY / 1440);
  if (inside) {
    const rect = stage.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const ny = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    engine.onGlobalMouseMove(nx, ny);
  }
}

window.addEventListener('pointermove', (e) => {
  handlePointerMove(e.clientX, e.clientY);
});

stage.addEventListener('pointerleave', () => {
  stage.classList.remove('petting');
});

stage.addEventListener('pointerdown', (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.closest('button')) return;
  const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
  engine.onMouseDown(button);
  engine3d?.onMouseDown(button);
  stageTypeInput.focus({ preventScroll: true });
});

window.addEventListener('pointerup', (e) => {
  const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
  engine.onMouseUp(button);
  engine3d?.onMouseUp(button);
});

stage.addEventListener('contextmenu', (e) => e.preventDefault());

stage.addEventListener(
  'wheel',
  () => {
    engine.onMouseWheel();
    engine3d?.onMouseWheel();
  },
  { passive: true },
);

function forwardKey(e: KeyboardEvent, down: boolean): void {
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  const isTextField = tag === 'INPUT' || tag === 'TEXTAREA';
  const vk = keyboardEventToVk(e);
  if (vk === null) return;

  if (down) {
    engine.onKeyDown(vk, e.repeat);
    engine3d?.onKeyDown(vk, e.repeat);
  } else {
    engine.onKeyUp(vk);
    engine3d?.onKeyUp(vk);
  }

  if (target === stageTypeInput) {
    e.preventDefault();
    if (stageTypeInput.value) stageTypeInput.value = '';
  } else if (!isTextField) {
    // Keep browser shortcuts (Ctrl/Cmd+R etc.) untouched.
    if (e.key === ' ' && !e.ctrlKey && !e.metaKey) e.preventDefault();
  }
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    generateFromPrompt(Date.now());
    return;
  }
  if (e.key === 'Escape') {
    const target = e.target as HTMLElement | null;
    const inTextField =
      target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    if (inTextField) return;
    if (!emojiPop.classList.contains('hidden')) {
      emojiPop.classList.add('hidden');
      return;
    }
    void closeStudio();
    return;
  }
  forwardKey(e, true);
});

window.addEventListener('keyup', (e) => {
  forwardKey(e, false);
});

stageTypeInput.addEventListener('input', () => {
  stageTypeInput.value = '';
});

/* ------------------------------------------------------------------ */
/* Resize                                                              */
/* ------------------------------------------------------------------ */

let resizeRaf = 0;
function scheduleResize(): void {
  if (resizeRaf) return;
  resizeRaf = window.requestAnimationFrame(() => {
    resizeRaf = 0;
    if (active3d) {
      engine3d?.resize();
    } else {
      engine.resize();
    }
  });
}

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(scheduleResize).observe(stage);
} else {
  window.addEventListener('resize', scheduleResize);
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

promptInput.addEventListener('input', () => {
  updateCharCount();
  if (activeCharacter && promptInput.value !== characterPrompt) activeCharacter = null;
});

generateBtn.addEventListener('click', () => generateFromPrompt(Date.now()));

searchBtn.addEventListener('click', () => {
  void runCharacterSearch();
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void runCharacterSearch();
    return;
  }
  if (e.key === 'Escape') {
    e.stopPropagation();
    searchResults.classList.add('hidden');
    searchInput.blur();
  }
});

searchInput.addEventListener('input', () => {
  if (!searchInput.value.trim()) searchResults.classList.add('hidden');
});

document.addEventListener('pointerdown', (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.closest?.('.search-row')) return;
  searchResults.classList.add('hidden');
});

diceBtn.addEventListener('click', () => {
  setPrompt(randomInspiration(Date.now()));
});

nameInput.addEventListener('input', () => {
  if (current) current.cat.name = nameInput.value;
});

emojiBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  emojiPop.classList.toggle('hidden');
});

document.addEventListener('click', (e) => {
  if (!emojiPop.classList.contains('hidden') && !(e.target as HTMLElement).closest('#emoji-pop')) {
    emojiPop.classList.add('hidden');
  }
});

for (const emoji of EMOJI_CHOICES) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = emoji;
  btn.setAttribute('role', 'menuitem');
  btn.addEventListener('click', () => {
    emojiBtn.textContent = emoji;
    if (current) current.cat.emoji = emoji;
    emojiPop.classList.add('hidden');
  });
  emojiPop.appendChild(btn);
}

tuneFur.addEventListener('input', () => {
  if (!current) return;
  const old = current.cat.furColor;
  const next = tuneFur.value;
  current.cat.furColor = next;
  current.cat.furSecondaryColor = shiftLuminance(next, -0.1);
  if (current.cat.earOuterColor === old) current.cat.earOuterColor = next;
  if (current.cat.tailColor === old) current.cat.tailColor = next;
  if (current.cat.armColor === old) current.cat.armColor = next;
  if (current.cat.pawColor === old) current.cat.pawColor = next;
  applyResult(current);
});

tuneEye.addEventListener('input', () => {
  if (!current) return;
  current.cat.eyeColorTop = tuneEye.value;
  current.cat.eyeColorBottom = shiftLuminance(tuneEye.value, 0.32);
  current.cat.squintColor = tuneEye.value;
  applyResult(current);
});

tuneAccent.addEventListener('input', () => {
  if (!current) return;
  current.cat.accentColor = tuneAccent.value;
  current.cat.accentSideColor = shiftLuminance(tuneAccent.value, -0.18);
  applyResult(current);
});

fluffyToggle.addEventListener('change', () => {
  if (!current) return;
  current.cat.tailFluffy = fluffyToggle.checked;
  engine.setCatAppearance(current.cat.id, current.cat);
  engine3d?.setCatSkin(current.cat);
});

patternRow.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-studio-pattern]');
  if (!btn) return;
  const pattern = btn.dataset.studioPattern as CatPattern;
  if (!pattern) return;
  const prompt = currentPrompt || promptInput.value || `${current?.cat.name || ''} ${patternDisplayName(pattern)}`;
  currentPrompt = prompt;
  promptInput.value = prompt;
  const result = regenerateWithPattern(prompt, pattern, seed);
  applyResult(result);
});

saveBtn.addEventListener('click', () => void saveCat());

async function closeStudio(): Promise<void> {
  if (isTauri) {
    try {
      await getCurrentWindow().close();
      return;
    } catch {
      // fall through
    }
  }
  window.close();
}

closeBtn.addEventListener('click', () => void closeStudio());

/* ------------------------------------------------------------------ */
/* Mode switch + inspiration                                           */
/* ------------------------------------------------------------------ */

stage.querySelectorAll<HTMLButtonElement>('[data-studio-mode]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = btn.dataset.studioMode;
    if (next === '3d') void enable3D();
    else activate2D();
  });
});

for (const text of allInspirations().slice(0, 9)) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'inspiration-chip';
  chip.textContent = text;
  chip.title = text;
  chip.addEventListener('click', () => setPrompt(text));
  inspirationRow.appendChild(chip);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot(): Promise<void> {
  syncModeButtons();
  const initial = allInspirations()[0];
  setPrompt(initial, true);

  await refreshSavedCats();

  // Try the richer 3D preview after the first paint, but keep 2D as the
  // guaranteed fallback (Win7 WebView2 / blocked WebGL).
  window.setTimeout(() => {
    void enable3D();
  }, 260);
}

void boot();
