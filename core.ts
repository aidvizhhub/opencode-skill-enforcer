import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

/**
 * skill-enforcer — чистая логика плагина: разбор опций, токены, нарезка
 * справочников, отбор, кэш, запрос к брокеру. Без хуков и состояния сессии —
 * всё это в `index.ts`, а всё проверяемое — здесь.
 */

export const TAG = "[skill-enforcer]"

export interface DocSpec {
  path: string
  title?: string
  maxBlocks?: number
  maxChars?: number
}

export interface Options {
  minSkills: number
  maxSkills: number
  autoAttach: boolean
  attachAlways: boolean
  attachPicked: boolean
  /**
   * Второй слой отбора по смыслу, когда лексика не нашла ничего.
   * Тянет модель 130 МБ в ~/.cache/skill-enforcer — выключается флагом.
   */
  embed: boolean
  skillLlm: boolean
  minPromptChars: number
  /** Абсолютный пол счёта: ниже — не берём вообще. */
  minScore: number
  /** Доля от лучшего счёта в ходе: отсекает тех, кто просто рядом стоял. */
  minRatio: number
  /** Сколько разных слов промпта должно совпасть с описанием скилла. */
  minWords: number
  alwaysSkills: string[]
  maxAttach: number
  documents: DocSpec[]
  minDocScore: number
  maxDocBlocks: number
  docWindow: number
  maxDocChars: number
  docLlm: boolean
  docLlmMax: number
  skillLlmMax: number
  brokerHints: string
  cacheFile: string
  cacheHours: number
  logFile?: string
}

/** База общения под конкретного человека: имена скиллов у каждого свои. */
const DEFAULT_ALWAYS: string[] = []

export function readOptions(raw: unknown): Options {
  const o = (raw ?? {}) as Record<string, unknown>
  const int = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback)
  const list = (v: unknown, fallback: string[]) =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : fallback
  const docs = (v: unknown): DocSpec[] => {
    if (!Array.isArray(v)) return []
    const out: DocSpec[] = []
    for (const item of v) {
      if (typeof item === "string" && item.length > 0) {
        out.push({ path: item })
        continue
      }
      if (!item || typeof item !== "object") continue
      const d = item as Record<string, unknown>
      if (typeof d.path !== "string" || d.path.length === 0) continue
      out.push({
        path: d.path,
        title: typeof d.title === "string" ? d.title : undefined,
        maxBlocks: typeof d.maxBlocks === "number" ? Math.max(1, Math.trunc(d.maxBlocks)) : undefined,
        maxChars: typeof d.maxChars === "number" ? Math.max(200, Math.trunc(d.maxChars)) : undefined,
      })
    }
    return out
  }
  return {
    minSkills: Math.max(0, int(o.minSkills, 3)),
    maxSkills: Math.max(1, int(o.maxSkills, 5)),
    autoAttach: bool(o.autoAttach, true),
    attachAlways: bool(o.attachAlways, true),
    attachPicked: bool(o.attachPicked, true),
    embed: bool(o.embed, true),
    skillLlm: bool(o.skillLlm, false),
    minPromptChars: Math.max(0, int(o.minPromptChars, 12)),
    // Счёт с IDF, поэтому абсолютные числа зависят от размера каталога: работает
    // доля (minRatio). minScore — грубый нижний клапан, по умолчанию 0.
    minScore: Math.max(0, int(o.minScore, 0)),
    minRatio: Math.min(1, Math.max(0, o.minRatio === undefined ? 0.6 : Number(o.minRatio))),
    // одно-единственное слово с высоким IDF («проверь» → discuss-with-user)
    // не должно втаскивать скилл, поэтому нужно минимум два совпадения
    minWords: Math.max(1, int(o.minWords, 2)),
    alwaysSkills: list(o.alwaysSkills, DEFAULT_ALWAYS),
    maxAttach: Math.max(0, int(o.maxAttach, 6)),
    documents: docs(o.documents),
    minDocScore: Math.max(1, int(o.minDocScore, 3)),
    maxDocBlocks: Math.max(1, int(o.maxDocBlocks, 2)),
    docWindow: Math.max(0, int(o.docWindow, 1)),
    maxDocChars: Math.max(200, int(o.maxDocChars, 8000)),
    docLlm: bool(o.docLlm, false),
    docLlmMax: Math.max(10, int(o.docLlmMax, 300)),
    skillLlmMax: Math.max(3, int(o.skillLlmMax, 12)),
    brokerHints: typeof o.brokerHints === "string" ? o.brokerHints : "",
    // "" — кэш выключен; не задан — дефолт в системной папке
    cacheFile:
      typeof o.cacheFile === "string"
        ? o.cacheFile
        : join(tmpdir(), "opencode-skill-enforcer", "broker-cache.json"),
    cacheHours: Math.max(1, int(o.cacheHours, 72)),
    logFile:
      typeof o.logFile === "string" && o.logFile.length > 0
        ? o.logFile
        : process.env.SKILL_ENFORCER_DEBUG || undefined,
  }
}

/** Слова, которые не считаем за совпадение — они есть почти в любом скилле. */
const STOP = new Set([
  "что", "чтобы", "чтоб", "как", "когда", "зачем", "почему", "если", "или", "для",
  "тебя", "меня", "него", "нее", "них", "нам", "вам", "это", "этот", "эта", "эти",
  "все", "всё", "дает", "дать", "будет", "было", "есть", "надо", "нужно", "можно",
  "ещё", "еще", "уже", "даже", "тоже", "также", "просто", "только", "очень", "самый",
  "такой", "такая", "такое", "такие", "делать", "сделать", "делай", "хочешь", "хочет",
  "скилл", "скиллы", "скиллов", "скиллам", "skills", "skill", "workflow", "tool", "tools",
  "which", "what", "when", "where", "with", "from", "this", "that", "these", "those",
  "your", "yours", "have", "make", "want", "need", "just", "like", "does", "doing",
  "the", "and", "for", "not", "are", "was", "were", "will", "would", "should",
])

/**
 * Выкидываем пути и ссылки: «проверь ~/Projects/opencode-skill-enforcer» не должен
 * цеплять скилл про opencode из-за имени каталога. Пробел, а не пустая строка —
 * чтобы соседние слова не склеились.
 */
function withoutPaths(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(?:^|\s)[~/.][^\s]*/g, " ")
    .replace(/(?:^|\s)[A-Za-z]:\\[^\s]*/g, " ")
}

/**
 * Порог среза зависит от языка текста. Русские формы длинные (6+ букв), срез
 * до 5 работает: «сабагент»/«сабагентов» → «сабаг». Английские основы короткие
 * (test, parse, cache) — до порога 6 не дотягивают, а срез 5 режет их не с той
 * стороны: «test»/«tests» → «test»/«tests» и не сходится. Срез до 4 чинит
 * английский полностью, русский при этом не ломается.
 *
 * Срез выбирается по алфавиту самого слова, а не по доле кириллицы во всём
 * тексте. Раньше порог брался один на текст, и смешанное описание (английская
 * база плюс русские триггеры, как у fable-*) уходило в срез 4: «проверь» →
 * «пров» при промптовом «прове». Пересечение пустело, скилл ловил ноль при
 * полном совпадении слов. У настоящего fable-judge доля кириллицы в
 * триггерах — 6%.
 */
const CUT_RU = 5
const CUT_EN = 4

/**
 * Значимые слова в нижнем регистре, с грубым стеммингом по правилам языка.
 * Без этого скилл про сабагентов не ловится на «расскажи про сабагента», а
 * скилл про кэш — на «caching». Короткие латинские токены (mcp, api, ssh)
 * пропускаем — это имена, не мусор.
 */
export function stemWords(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of withoutPaths(text).toLowerCase().split(/[^0-9a-zа-яё]+/)) {
    const latinShort = /^[a-z0-9]{3}$/.test(w)
    if ((w.length < 4 && !latinShort) || STOP.has(w)) continue
    const cut = /[а-яё]/.test(w) ? CUT_RU : CUT_EN
    out.add(w.length >= cut + 1 ? w.slice(0, cut) : w)
  }
  return out
}

export interface SkillRef {
  id: string
  description: string
  /** Слова из ID и из секции «Загружай, когда:» — вес 2. */
  trigger: Set<string>
  /** Остальное описание (кроме «Не грузи, когда:») — вес 1. */
  body: Set<string>
}

export function referenceOf(skill: { id: string; name?: string; description?: string }): SkillRef {
  const description = skill.description ?? ""
  const [beforeNegative] = description.split(/Не грузи/i)
  const parts = beforeNegative.split(/Загружай,?\s*когда:?/i)
  const triggerText = parts.length > 1 ? parts.slice(1).join(" ") : ""
  const bodyText = parts[0] ?? ""
  return {
    id: skill.id,
    description,
    trigger: stemWords(`${skill.id} ${skill.name ?? ""} ${triggerText}`),
    body: stemWords(bodyText),
  }
}

/**
 * Подбор по смыслу запроса. Слова и у промпта, и у описания идут через
 * stemWords — иначе падежи не сходятся и скилл про сабагентов не ловится на
 * запрос «расскажи про сабагента».
 */
export function pickSkills(
  prompt: string,
  skills: SkillRef[],
  limit: number,
  minScore: number,
  minRatio = 0,
  minWords = 2,
): string[] {
  const promptWords = stemWords(prompt)
  // Порог совпадений не может превышать число слов запроса: в промпте
  // «подключи mcp» их два, и minWords: 3 не нашёл бы ничего никогда.
  const needWords = Math.min(minWords, Math.max(1, promptWords.size))
  const ranked = rankSkills(prompt, skills)
  if (ranked.length === 0) return []
  // Доля отсекает тех, кто просто рядом стоял с настоящим совпадением: на
  // каталоге из 40+ скиллов без неё на «итог сессии» цеплялись пять штук
  // с третьего слова описания. Абсолютный пол — аварийный клапан на случай
  // если верхний скилл сам по себе ерунда.
  const floor = Math.max(minScore, ranked[0].score * minRatio)
  return ranked.filter((r) => r.score >= floor && r.words >= needWords).slice(0, limit).map((r) => r.id)
}

/**
 * Счёт с поправкой на редкость слова (IDF). Без неё «ответ» весит одинаково и
 * в `result-first`, и в шести других скиллах, и цепляется вместе с каждым:
 * на «итог сессии» подтягивались result-first и context-and-paths. Редкое
 * слово («подключение» — только в mcp-setup) весит много, банальное («ответ»)
 * почти ничего.
 *
 * Ровно тот же приём, что в `selectBlocks` для кусков документов.
 */
function rankSkills(prompt: string, skills: SkillRef[]): { id: string; score: number; words: number }[] {
  const promptWords = stemWords(prompt)
  if (promptWords.size === 0) return []

  const df = new Map<string, number>()
  for (const skill of skills) {
    for (const w of skill.trigger) df.set(w, (df.get(w) ?? 0) + 1)
    for (const w of skill.body) df.set(w, (df.get(w) ?? 0) + 1)
  }
  const total = skills.length
  const idf = (w: string) => Math.log(1 + total / (df.get(w) ?? 1))

  const scored: { id: string; score: number; words: number }[] = []
  for (const skill of skills) {
    let score = 0
    let hits = 0
    for (const w of skill.trigger) if (promptWords.has(w)) (score += 2 * idf(w), (hits += 1))
    for (const w of skill.body) if (promptWords.has(w)) (score += 1 * idf(w), (hits += 1))
    if (score > 0) scored.push({ id: skill.id, score, words: hits })
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return scored
}

/**
 * Счёт нормирован в 0..1 относительно лучшего скилла в ходе. Абсолютные числа
 * зависят от размера каталога (одно уникальное слово в 42 скиллах весит 7.5,
 * в 200 — 10.5), поэтому сравнивать надо по доле, а не по порогу.
 */
export function topScore(prompt: string, skills: SkillRef[]): number {
  return rankSkills(prompt, skills)[0]?.score ?? 0
}

/**
 * Есть ли хоть одно совпадение по словам. Порог тут другой: для кандидатов
 * брокеру достаточно намёка, а не уверенного попадания.
 */
export function hasOverlap(prompt: string, skill: SkillRef): boolean {
  return numMatches(prompt, skill) > 0
}

/** Сколько разных слов запроса попало в скилл. */
export function numMatches(prompt: string, skill: SkillRef): number {
  const promptWords = stemWords(prompt)
  if (promptWords.size === 0) return 0
  let n = 0
  for (const w of skill.trigger) if (promptWords.has(w)) n++
  for (const w of skill.body) if (promptWords.has(w)) n++
  return n
}

/** `~` и `~/x` — в домашний каталог. */
export function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

export interface DocUnit {
  start: number
  end: number
  title: string
  text: string
  words: Set<string>
}

export interface DocPick {
  start: number
  title: string
  text: string
}

const HEADING = /^(#{1,6})\s+(.+)$/

/** Абзацы файла: единица кончается на пустой строке, код и списки не рвём. */
function atomsOf(text: string): DocUnit[] {
  const lines = text.split(/\r?\n/)
  const units: DocUnit[] = []
  let start = -1
  let buf: string[] = []
  let fence = false
  let heading: string | undefined

  const flush = (end: number) => {
    if (start < 0) return
    const chunk = buf.join("\n").trim()
    const from = start
    start = -1
    buf = []
    if (!chunk) return
    const title = labelOf(chunk) ?? heading ?? chunk.split("\n")[0].trim().slice(0, 80)
    units.push({ start: from, end, title, text: chunk, words: stemWords(chunk) })
  }

  const nextMeaningful = (i: number): string | undefined => {
    for (let j = i + 1; j < lines.length; j++) if (lines[j].trim() !== "") return lines[j]
    return undefined
  }
  const lastBuffered = (): string => {
    for (let j = buf.length - 1; j >= 0; j--) if (buf[j].trim() !== "") return buf[j]
    return ""
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (line.trim() === "" && !fence) {
      // список из пунктов, разделённых пустой строкой, — один кусок, не рвём
      const next = nextMeaningful(i)
      if (LIST_ITEM.test(lastBuffered()) && next !== undefined && LIST_ITEM.test(next)) continue
      flush(i)
      continue
    }
    const m = !fence ? line.trim().match(HEADING) : null
    if (m) heading = m[2].trim()
    if (start < 0) start = i
    buf.push(line)
  }
  flush(lines.length)

  const merged: DocUnit[] = []
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]
    const next = units[i + 1]
    if (next && isHeadingOnly(unit.text)) {
      next.start = unit.start
      next.text = `${unit.text}\n${next.text}`
      next.words = stemWords(next.text)
      next.title = labelOf(next.text) ?? next.title
      continue
    }
    merged.push(unit)
  }
  return merged
}

/** Целевой размер блока: меньше — огрызок, больше — лишний вес. */
const DOC_BLOCK_MIN = 600
const DOC_BLOCK_MAX = 1200

/**
 * Режет файл на блоки по размеру: копим абзацы, пока блок не станет весомым.
 * Новый блок начинаем у заголовка (если минимум уже набран) или по достижении
 * максимума. Так вместо сотни огрызков выходят нормальные куски текста.
 */
export function splitDoc(text: string): DocUnit[] {
  const atoms = atomsOf(text)
  const blocks: DocUnit[] = []
  let parts: string[] = []
  let start = -1
  let end = -1
  let title = ""
  const size = () => parts.reduce((n, p) => n + p.length + 2, 0)
  const flush = () => {
    if (!parts.length) return
    const chunk = parts.join("\n\n")
    blocks.push({
      start,
      end,
      title: title || chunk.split("\n")[0].trim().slice(0, 80),
      text: chunk,
      words: stemWords(chunk),
    })
    parts = []
  }
  for (const atom of atoms) {
    const sectionStart = HEADING.test(atom.text.split("\n")[0].trim())
    if (parts.length > 0 && ((sectionStart && size() >= DOC_BLOCK_MIN) || size() >= DOC_BLOCK_MAX)) flush()
    if (parts.length === 0) {
      start = atom.start
      title = atom.title
    }
    parts.push(atom.text)
    end = atom.end
  }
  flush()
  return blocks
}

function isHeadingOnly(text: string): boolean {
  return text.split("\n").every((line) => HEADING.test(line.trim()))
}

/** Подпись куска: заголовок внутри, иначе последний виденный заголовок, иначе первая строка. */
export function labelOf(text: string): string | undefined {
  let heading: string | undefined
  for (const line of text.split("\n")) {
    const m = line.trim().match(HEADING)
    if (m) heading = m[2].trim()
  }
  return heading
}

/** Короткий хэш текста: меняется — значит кусок в контексте устарел. */
export function contentHash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

export interface CacheEntry {
  skills: string[]
  /** куски справочников по хэшу текста, а не по номеру: при правке файла номер сдвинется, хэш — нет. */
  docs: string[]
  at: number
}

/** Ключ — от текста запроса без регистра, пунктуации и хвоста: «объясни API» и «Объясни API!!» — одно и то же. */
function cacheKey(prompt: string): string {
  const norm = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  return contentHash(norm.slice(0, 400))
}

/** Кэш выбора брокера. Файл читается один раз за сессию плагина, запись переписывает его целиком. */
export function makeCache(file: string, ttlHours: number, note: (m: string) => void) {
  if (!file) return { get: (): CacheEntry | null => null, set: () => {}, size: () => 0 }

  let entries: Map<string, CacheEntry> | null = null

  const load = () => {
    if (entries) return entries
    entries = new Map()
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, CacheEntry>
      for (const [key, value] of Object.entries(raw)) {
        if (Array.isArray(value?.skills) && typeof value.at === "number") {
          entries.set(key, { skills: value.skills, docs: Array.isArray(value.docs) ? value.docs : [], at: value.at })
        }
      }
    } catch {
      // файла нет или он битый — просто начинаем с пустого кэша
    }
    return entries
  }

  const ttl = ttlHours * 3600_000

  return {
    get(prompt: string): CacheEntry | null {
      const entry = load().get(cacheKey(prompt))
      if (!entry) return null
      if (Date.now() - entry.at > ttl) {
        load().delete(cacheKey(prompt))
        return null
      }
      return entry
    },
    set(prompt: string, skills: string[], docs: string[]) {
      const map = load()
      const key = cacheKey(prompt)
      map.set(key, { skills, docs, at: Date.now() })
      const fresh: Record<string, CacheEntry> = {}
      for (const [k, v] of map) if (Date.now() - v.at <= ttl) fresh[k] = v
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(fresh))
      } catch (error) {
        note(`cache write failed: ${String(error)}`)
      }
    },
    size: () => load().size,
  }
}

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/

/** Обрезка по границе абзаца возле предела, чтобы не рвать фразу на полуслове. */
export function clipBlock(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const lastParagraph = cut.lastIndexOf("\n\n")
  return (lastParagraph > limit * 0.5 ? cut.slice(0, lastParagraph) : cut).trimEnd()
}

/**
 * Строит куски из попаданий: раздувает на `window` соседей, склеивает
 * пересекающиеся окна, сортирует по позиции.
 */
export function picksFromHits(
  units: DocUnit[],
  hits: { index: number; score: number }[],
  limit: number,
  window: number,
): DocPick[] {
  const ranges: { lo: number; hi: number; best: number; score: number }[] = []
  for (const hit of hits) {
    // модель могла назвать несуществующий документ или абзац (нумерация с 1,
    // опечатка) — такой ответ пропускаем, а не роняем весь ход
    if (hit.index < 0 || hit.index >= units.length) continue
    if (ranges.length >= limit) break
    const lo = Math.max(0, hit.index - window)
    const hi = Math.min(units.length - 1, hit.index + window)
    const touching = ranges.find((r) => lo <= r.hi + 1 && r.lo <= hi + 1)
    if (touching) {
      touching.lo = Math.min(touching.lo, lo)
      touching.hi = Math.max(touching.hi, hi)
      if (hit.score > touching.score) {
        touching.score = hit.score
        touching.best = hit.index
      }
      continue
    }
    ranges.push({ lo, hi, best: hit.index, score: hit.score })
  }
  ranges.sort((a, b) => a.lo - b.lo)
  return ranges.map((r) => ({
    start: units[r.lo].start,
    title: units[r.best].title,
    text: units.slice(r.lo, r.hi + 1).map((u) => u.text).join("\n\n"),
  }))
}

/**
 * Ищет по телу абзацев, вес слова — редкость (IDF): «сервер» весит мало,
 * «сабагент» много. `minMatches` — сколько разных слов промпта должно совпасть.
 */
export function selectBlocks(
  prompt: string,
  units: DocUnit[],
  minMatches: number,
  limit: number,
  window: number,
): DocPick[] {
  const promptWords = stemWords(prompt)
  if (promptWords.size === 0 || units.length === 0) return []
  // Порог не может превышать число слов запроса: в промпте из трёх слов
  // в лучшем блоке совпадёт максимум три, и minDocScore: 4 не нашёл бы
  // никогда ничего. Раньше из-за этого документы переставали попадать
  // в контекст целиком при коротких запросах.
  const need = Math.min(minMatches, promptWords.size)
  const df = new Map<string, number>()
  for (const unit of units) {
    for (const w of unit.words) df.set(w, (df.get(w) ?? 0) + 1)
  }
  const idf = (w: string) => Math.log(1 + units.length / (df.get(w) ?? 1))

  const hits = units
    .map((unit, index) => {
      let matches = 0
      let score = 0
      for (const w of promptWords) {
        if (!unit.words.has(w)) continue
        matches += 1
        score += idf(w)
      }
      return { index, matches, score }
    })
    .filter((x) => x.matches >= need)
    .sort((a, b) => b.score - a.score || a.index - b.index)

  return picksFromHits(units, hits, limit, window)
}

/** Короткое превью абзаца для показа модели. */
export function unitPreview(unit: DocUnit): string {
  return unit.text.split("\n").slice(0, 3).join(" ").slice(0, 200)
}

export interface BrokerDocCandidate {
  doc: number
  unit: number
  preview: string
}

export interface BrokerResult {
  skills: string[]
  docs: { doc: number; unit: number }[]
}

/**
 * Один вызов модели на оба источника: выбирает и скиллы, и абзацы справочников.
 * Ответ ждём двумя строками: `SKILLS: ...` и `DOCS: D<док>.<абзац>, ...`.
 */
export async function llmBroker(input: {
  prompt: string
  skills: SkillRef[]
  needSkills: number
  docs: BrokerDocCandidate[]
  needDocs: number
  hints?: string
  generate: (text: string) => Promise<string>
  log?: (message: string) => void
}): Promise<BrokerResult> {
  const lines = [
    "Ты подбираешь материалы под задачу. Выбирай только то, что реально поможет ответить.",
    "Не выбирай по названию инструмента: скилл про сам инструмент нужен, только когда",
    "задача прямо про этот инструмент. Если подходящего нет — пиши NONE.",
  ]
  // Указания под свой набор скиллов — из конфига, а не в коде плагина.
  if (input.hints) lines.push(input.hints)
  lines.push("", `Запрос: ${input.prompt}`, "")
  if (input.needSkills > 0 && input.skills.length > 0) {
    lines.push(`СКИЛЛЫ (выбери до ${input.needSkills}, или NONE):`)
    for (const s of input.skills) lines.push(`- ${s.id}: ${s.description.slice(0, 160)}`)
    lines.push("")
  }
  if (input.needDocs > 0 && input.docs.length > 0) {
    lines.push(`АБЗАЦЫ (выбери до ${input.needDocs}, формат D<документ>.<абзац>, или NONE):`)
    for (const c of input.docs) lines.push(`[D${c.doc}.${c.unit}] ${c.preview}`)
    lines.push("")
  }
  lines.push("Ответ строго двумя строками, без пояснений:")
  lines.push("SKILLS: <id, id | NONE>")
  lines.push("DOCS: <D0.3, D1.7 | NONE>")

  const answer = await input.generate(lines.join("\n"))
  input.log?.(`broker raw: ${answer.replace(/\s+/g, " ").slice(0, 200)}`)

  const skillsLine = answer.match(/SKILLS:\s*([^\n]*)/i)?.[1] ?? ""
  const docsLine = answer.match(/DOCS:\s*([^\n]*)/i)?.[1] ?? ""

  const skills = input.skills
    .map((s) => s.id)
    .filter((id) => new RegExp(`(^|[^\\w-])${id}([^\\w-]|$)`).test(skillsLine))
    .slice(0, Math.max(0, input.needSkills))

  const docs: { doc: number; unit: number }[] = []
  if (input.needDocs > 0) {
    for (const m of docsLine.matchAll(/D(\d+)\.(\d+)/gi)) {
      const doc = Number(m[1])
      const unit = Number(m[2])
      if (docs.some((d) => d.doc === doc && d.unit === unit)) continue
      docs.push({ doc, unit })
      if (docs.length >= input.needDocs) break
    }
  }
  return { skills, docs }
}

export function renderRule(
  min: number,
  max: number,
  taskLoaded: number,
  taskInContact: string[],
  baseInContact: string[],
  configuredBase: string[],
): string {
  let baseLine: string
  if (baseInContact.length > 0) {
    baseLine = `Базовые скиллы общения держим в контакте всегда: ${baseInContact.join(", ")}. Не отвечай вопреки им.`
  } else if (configuredBase.length > 0) {
    baseLine = `Базовый набор общения (${configuredBase.join(", ")}) ещё не в контакте — загрузи его через skill, если отвечаешь живым текстом.`
  } else {
    baseLine = "Базовых скиллов общения не задано."
  }
  const contactLine =
    taskInContact.length === 0
      ? "Рабочих скиллов в контакте пока нет — загрузи первым делом, прежде чем отвечать по существу."
      : `Уже в контакте по задаче: ${taskInContact.join(", ")}. Следуй им и не перезагружай без нужды; сменилась задача — добери по теме.`
  return [
    "ПРАВИЛО СКИЛЛОВ (проверка на каждом шаге):",
    `1. ${baseLine}`,
    `2. Перед содержательным ответом сверься со списком скиллов и загрузи через инструмент skill минимум ${min} подходящих по задаче (цель ${min}–${max}). Сейчас по задаче в контакте: ${taskLoaded}/${min}.`,
    `3. ${contactLine}`,
  ].join("\n")
}
