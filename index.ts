import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Plugin } from "@opencode/plugin"

/**
 * skill-enforcer — заставляет агента реально работать со скиллами.
 *
 * Три рычага:
 *  1. session.hook("context") — на каждом шаге модели (включая продолжения после
 *     инструментов) добавляет в system короткое правило: сверься со скиллами,
 *     загрузи минимум N, а уже загруженные — соблюдай.
 *  2. session.hook("prompt") — на входе нового сообщения сбрасывает счётчик хода и,
 *     если включено, прикрепляет подобранные по смыслу скиллы к промпту, чтобы они
 *     гарантированно попали в контекст.
 *  3. tool.hook("execute.before") — считает вызовы инструмента `skill`, чтобы
 *     правило знало, сколько скиллов уже загружено в этом ходе.
 *
 * Опции (через объектную форму в plugins):
 *   minSkills       — сколько скиллов минимум на ход (по умолчанию 3)
 *   maxSkills       — верхняя граница авто-подбора (по умолчанию 5)
 *   autoAttach      — мастер-выключатель автоприцепки (по умолчанию true)
 *   attachAlways    — цеплять базовый набор общения (по умолчанию true)
 *   attachPicked    — цеплять добор по смыслу запроса (по умолчанию true)
 *   skillLlm        — если словесный добор недобрал до minSkills, спросить модель (по умолчанию false)
 *   minPromptChars  — не трогать короткие реплики короче этого (по умолчанию 12)
 *   minScore        — порог совпадения для авто-подбора; триггер весит 2, описание 1 (по умолчанию 3)
 *   documents       — файлы-справочники: по промпту находим релевантный кусок текста
 *                     (по абзацам, не по заголовкам) и подкладываем его в контекст.
 *                     Пусто — выключено.
 *   minDocScore     — сколько разных слов промпта должно совпасть с абзацем (по умолчанию 2)
 *   maxDocBlocks    — сколько попаданий из одного файла максимум (по умолчанию 2)
 *   docWindow       — на сколько соседних абзацев раздувать попадание (по умолчанию 1)
 *   maxDocChars     — потолок символов из одного файла за ход (по умолчанию 8000)
 *   docLlm          — семантический добор: если словесный поиск пуст, спросить модель (по умолчанию false)
 *   docLlmMax       — сколько абзацев показывать модели на выбор (по умолчанию 300)
 *   skillLlmMax     — сколько скиллов показывать модели на выбор; берём только те, у кого
 *                     есть словесное совпадение с запросом (по умолчанию 12)
 *   brokerHints     — указания брокеру под свой набор скиллов (по умолчанию пусто)
 *   cacheFile       — файл кэша выбора брокера; по умолчанию в системной папке /tmp
 *                     (пустая строка — кэш выключен)
 *   cacheHours      — сколько дней запись в кэше живёт (по умолчанию 3)
 *   logFile         — путь к файлу-маркеру; если задан, туда пишутся все события
 */

const TAG = "[skill-enforcer]"

interface Options {
  minSkills: number
  maxSkills: number
  /** Мастер-выключатель всей автоприцепки. false — остаётся только правило-напоминание. */
  autoAttach: boolean
  /** Цеплять базовый набор общения (alwaysSkills). */
  attachAlways: boolean
  /** Цеплять добор по смыслу запроса. */
  attachPicked: boolean
  /** Семантический добор скиллов через модель, когда словесный недобрал. */
  skillLlm: boolean
  minPromptChars: number
  minScore: number
  /** Скиллы «человеческого общения», которые держим в контакте всегда (цепляем один раз за сессию). */
  alwaysSkills: string[]
  /** Потолок на всё, что плагин цепляет к одному промпту (база + добор). */
  maxAttach: number
  /** Файлы-справочники: релевантный раздел уезжает в контекст целиком. */
  documents: DocSpec[]
  minDocScore: number
  maxDocBlocks: number
  docWindow: number
  maxDocChars: number
  docLlm: boolean
  docLlmMax: number
  /** Сколько скиллов-кандидатов показывать модели (только с лексическим совпадением). */
  skillLlmMax: number
  /** Указания брокеру под свой набор скиллов: «правка кода — вот этот скилл». */
  brokerHints: string
  /** Файл кэша выбора брокера; пусто — кэш выключен. */
  cacheFile: string
  /** Сколько дней запись в кэше живёт. */
  cacheHours: number
  logFile?: string
}

/** Описание файла-справочника: путь и персональные лимиты. */
interface DocSpec {
  path: string
  title?: string
  maxBlocks?: number
  maxChars?: number
}

/** База общения под конкретного человека: имена скиллов у каждого свои. */
const DEFAULT_ALWAYS: string[] = []

function readOptions(raw: unknown): Options {
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
    skillLlm: bool(o.skillLlm, false),
    minPromptChars: Math.max(0, int(o.minPromptChars, 12)),
    minScore: Math.max(1, int(o.minScore, 3)),
    alwaysSkills: list(o.alwaysSkills, DEFAULT_ALWAYS),
    maxAttach: Math.max(0, int(o.maxAttach, 6)),
    documents: docs(o.documents),
    minDocScore: Math.max(1, int(o.minDocScore, 2)),
    maxDocBlocks: Math.max(1, int(o.maxDocBlocks, 2)),
    docWindow: Math.max(0, int(o.docWindow, 1)),
    maxDocChars: Math.max(200, int(o.maxDocChars, 8000)),
    docLlm: bool(o.docLlm, false),
    docLlmMax: Math.max(10, int(o.docLlmMax, 300)),
    skillLlmMax: Math.max(3, int(o.skillLlmMax, 12)),
    brokerHints: typeof o.brokerHints === "string" ? o.brokerHints : "",
    cacheFile:
      typeof o.cacheFile === "string" && o.cacheFile.length > 0
        ? o.cacheFile
        : join(tmpdir(), "opencode-skill-enforcer", "broker-cache.json"),
    cacheHours: Math.max(1, int(o.cacheHours, 72)),
    logFile: typeof o.logFile === "string" && o.logFile.length > 0
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

/** Значимые слова (от 4 букв, без стоп-слов) в нижнем регистре. */
function words(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text.toLowerCase().split(/[^0-9a-zа-яё]+/)) {
    if (w.length >= 4 && !STOP.has(w)) out.add(w)
  }
  return out
}

/**
 * То же, но с грубым стеммингом: у слов от 6 букв берём первые 5. Русская
 * морфология гуляет по падежам («ресёрча» / «ресёрч»), без этого не сходится.
 * Короткие латинские токены (mcp, api, ssh) пропускаем — это имена, не мусор.
 */
function stemWords(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text.toLowerCase().split(/[^0-9a-zа-яё]+/)) {
    const latinShort = /^[a-z0-9]{3}$/.test(w)
    if ((w.length < 4 && !latinShort) || STOP.has(w)) continue
    out.add(w.length >= 6 ? w.slice(0, 5) : w)
  }
  return out
}

interface SkillRef {
  id: string
  /** Короткое описание — для семантического пика. */
  description: string
  /** Слова из ID и из секции «Загружай, когда:» — вес 2. */
  trigger: Set<string>
  /** Остальное описание (кроме «Не грузи, когда:») — вес 1. */
  body: Set<string>
}

function referenceOf(skill: { id: string; name?: string; description?: string }): SkillRef {
  const description = skill.description ?? ""
  const [beforeNegative] = description.split(/Не грузи/i)
  const parts = beforeNegative.split(/Загружай,?\s*когда:?/i)
  const triggerText = parts.length > 1 ? parts.slice(1).join(" ") : ""
  const bodyText = parts[0] ?? ""
  return {
    id: skill.id,
    description,
    trigger: words(`${skill.id} ${skill.name ?? ""} ${triggerText}`),
    body: words(bodyText),
  }
}

/** Сколько весит совпадение слов запроса со скиллом: триггер 2, описание 1. */
function overlap(prompt: string, skill: SkillRef): number {
  const promptWords = words(prompt)
  let score = 0
  for (const w of skill.trigger) if (promptWords.has(w)) score += 2
  for (const w of skill.body) if (promptWords.has(w)) score += 1
  return score
}

function pickSkills(prompt: string, skills: SkillRef[], limit: number, minScore: number): string[] {
  const promptWords = words(prompt)
  if (promptWords.size === 0) return []
  const scored: { id: string; score: number }[] = []
  for (const skill of skills) {
    let score = 0
    for (const w of skill.trigger) if (promptWords.has(w)) score += 2
    for (const w of skill.body) if (promptWords.has(w)) score += 1
    if (score >= minScore) scored.push({ id: skill.id, score })
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return scored.slice(0, limit).map((s) => s.id)
}

/** `~` и `~/x` — в домашний каталог. */
function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

interface DocUnit {
  start: number
  end: number
  title: string
  text: string
  words: Set<string>
}

interface DocPick {
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
function splitDoc(text: string): DocUnit[] {
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
function labelOf(text: string): string | undefined {
  let heading: string | undefined
  for (const line of text.split("\n")) {
    const m = line.trim().match(HEADING)
    if (m) heading = m[2].trim()
  }
  return heading
}

/** Короткий хэш текста: меняется — значит кусок в контексте устарел. */
function contentHash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

interface CacheEntry {
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
function makeCache(file: string, ttlHours: number, note: (m: string) => void) {
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
function clipBlock(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const lastParagraph = cut.lastIndexOf("\n\n")
  return (lastParagraph > limit * 0.5 ? cut.slice(0, lastParagraph) : cut).trimEnd()
}

/**
 * Строит куски из попаданий: раздувает на `window` соседей, склеивает
 * пересекающиеся окна, сортирует по позиции.
 */
function picksFromHits(units: DocUnit[], hits: { index: number; score: number }[], limit: number, window: number): DocPick[] {
  const ranges: { lo: number; hi: number; best: number; score: number }[] = []
  for (const hit of hits) {
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
function selectBlocks(prompt: string, units: DocUnit[], minMatches: number, limit: number, window: number): DocPick[] {
  const promptWords = stemWords(prompt)
  if (promptWords.size === 0 || units.length === 0) return []
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
    .filter((x) => x.matches >= minMatches)
    .sort((a, b) => b.score - a.score || a.index - b.index)

  return picksFromHits(units, hits, limit, window)
}

/**
 * Семантический отбор: спрашиваем модель, какие абзацы подходят запросу.
 * Нужен там, где словесный поиск промахнулся (синонимы, другой корень).
 * Список кандидатов режем по `maxCandidates`, чтобы не раздувать запрос.
 */
/** Короткое превью абзаца для показа модели. */
function unitPreview(unit: DocUnit): string {
  return unit.text.split("\n").slice(0, 3).join(" ").slice(0, 200)
}

interface BrokerDocCandidate {
  doc: number
  unit: number
  preview: string
}

interface BrokerResult {
  skills: string[]
  docs: { doc: number; unit: number }[]
}

/**
 * Один вызов модели на оба источника: выбирает и скиллы, и абзацы справочников.
 * Ответ ждём двумя строками: `SKILLS: ...` и `DOCS: D<док>.<абзац>, ...`.
 */
async function llmBroker(input: {
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

function renderRule(
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
  const contactLine = taskInContact.length === 0
    ? "Рабочих скиллов в контакте пока нет — загрузи первым делом, прежде чем отвечать по существу."
    : `Уже в контакте по задаче: ${taskInContact.join(", ")}. Следуй им и не перезагружай без нужды; сменилась задача — добери по теме.`
  return [
    "ПРАВИЛО СКИЛЛОВ (проверка на каждом шаге):",
    `1. ${baseLine}`,
    `2. Перед содержательным ответом сверься со списком скиллов и загрузи через инструмент skill минимум ${min} подходящих по задаче (цель ${min}–${max}). Сейчас по задаче в контакте: ${taskLoaded}/${min}.`,
    `3. ${contactLine}`,
  ].join("\n")
}

export default Plugin.define({
  id: "skill-enforcer",
  setup(ctx) {
    const options = readOptions(ctx.options)
    /** sessionID -> всё, что уже в контексте (база + рабочие, прицепленные или загруженные инструментом). */
    const inContact = new Map<string, Set<string>>()
    /** sessionID -> рабочие скиллы, попавшие в контекст в текущем ходе (для счётчика «минимум N»). */
    const turnTask = new Map<string, Set<string>>()
    /** путь -> разобранный файл-справочник (кэш по mtime). */
    const docCache = new Map<string, { mtimeMs: number; units: DocUnit[] }>()
    /** sessionID -> какие куски справочников уже подставлены (фолбэк, когда история недоступна). */
    const injectedDocs = new Map<string, Set<string>>()

    const note = (message: string) => {
      const line = `${new Date().toISOString()} ${TAG} ${message}\n`
      if (options.logFile) {
        try {
          appendFileSync(options.logFile, line)
        } catch {
          // маркерный файл — вспомогательный канал; его отказ не должен ронять хук
        }
      }
    }

    const cache = makeCache(options.cacheFile, options.cacheHours, note)

    const skillsAtHand = async (): Promise<SkillRef[]> => {
      try {
        const all = (await ctx.skill.list()).data
        return all
          .filter((s) => s.autoinvoke !== false && typeof s.description === "string" && s.description.length > 0)
          .map(referenceOf)
      } catch (error) {
        note(`skill.list failed: ${String(error)}`)
        return []
      }
    }

    /** Один вопрос модели внутри сессии: нужна для семантического добора по справочникам. */
    const askModel = async (text: string, sessionID: string): Promise<string> => {
      const answer = await ctx.session.generate({ sessionID, prompt: text })
      return answer.text
    }

    /**
     * Подбирает по промпту разделы из файлов-справочников. Возвращает готовые куски
     * для вставки в сообщение; один и тот же раздел в сессии не повторяем.
     */
    /**
     * Текст последних сообщений сессии — по нему видно, лежит ли кусок в контексте
     * прямо сейчас (после сжатия истории он может выпасть, тогда подставим снова).
     */
    const recentHistory = async (sessionID: string): Promise<string | null> => {
      try {
        const messages = await ctx.session.context({ sessionID })
        return JSON.stringify(messages.slice(-60))
      } catch (error) {
        note(`doc history failed: ${String(error)}`)
        return null
      }
    }

    /** Читает файл-справочник (кэш по mtime) и режет на блоки. */
    const docUnitsFor = (spec: DocSpec): { path: string; label: string; units: DocUnit[] } | null => {
      const path = expandHome(spec.path)
      let cached = docCache.get(path)
      try {
        const mtimeMs = statSync(path).mtimeMs
        if (!cached || cached.mtimeMs !== mtimeMs) {
          cached = { mtimeMs, units: splitDoc(readFileSync(path, "utf8")) }
          docCache.set(path, cached)
        }
      } catch (error) {
        note(`doc read failed ${path}: ${String(error)}`)
        return null
      }
      return { path, label: spec.title ?? spec.path, units: cached.units }
    }

    interface DocPlan {
      path: string
      label: string
      units: DocUnit[]
      picks: DocPick[]
      limit: number
      budget: number
    }

    ctx.session.hook("prompt", async (event) => {
      try {
        const sessionID = event.sessionID
        const current = event.prompt.skills ?? []
        const contact = inContact.get(sessionID) ?? new Set<string>()
        for (const s of current) contact.add(String(s.id))
        inContact.set(sessionID, contact)
        turnTask.set(sessionID, new Set())

        const text = event.prompt.text ?? ""
        if (text.trim().length < options.minPromptChars) return
        const history = await recentHistory(sessionID)
        // скилл уже в контексте сессии? Проверяем по истории (после сжатия вернём заново)
        const skillInContext = (id: string) =>
          history !== null ? new RegExp(`/skills/${id}(\\b|/)`).test(history) : contact.has(id)

        // справочники: читаем файлы и делаем словесный отбор
        const plans: DocPlan[] = []
        for (const spec of options.documents) {
          const got = docUnitsFor(spec)
          if (!got) continue
          const limit = spec.maxBlocks ?? options.maxDocBlocks
          plans.push({
            path: got.path,
            label: got.label,
            units: got.units,
            limit,
            budget: spec.maxChars ?? options.maxDocChars,
            picks: selectBlocks(text, got.units, options.minDocScore, limit, options.docWindow),
          })
        }

        // скиллы: база и словесный добор
        const wantSkills = options.autoAttach && (options.attachAlways || options.attachPicked || options.skillLlm)
        const all = wantSkills ? await skillsAtHand() : []
        const available = new Set(all.map((s) => s.id))
        const attach: string[] = []
        const taskAttached: string[] = []
        const atCap = () => options.maxAttach > 0 && attach.length >= options.maxAttach

        if (options.attachAlways) {
          for (const id of options.alwaysSkills) {
            if (atCap()) break
            if (!available.has(id) || skillInContext(id) || attach.includes(id)) continue
            attach.push(id)
          }
        }
        if (options.attachPicked) {
          const matched = pickSkills(text, all, options.maxSkills, options.minScore)
          for (const id of matched) {
            if (atCap()) break
            if (skillInContext(id) || attach.includes(id)) continue
            attach.push(id)
            taskAttached.push(id)
          }
        }

        // один вызов модели на оба источника, когда хоть где-то недобор
        let needSkills =
          options.skillLlm && taskAttached.length < options.minSkills
            ? options.minSkills - taskAttached.length
            : 0
        const skillCandidates = options.skillLlm
          ? all
              .filter((s) => !skillInContext(s.id) && !attach.includes(s.id))
              .filter((s) => overlap(text, s) > 0)
              .slice(0, options.skillLlmMax)
          : []
        const docNeeding = options.docLlm ? plans.filter((p) => p.picks.length === 0) : []
        const docCandidates: BrokerDocCandidate[] = []
        if (docNeeding.length > 0) {
          const promptWords = new Set([...stemWords(text), ...words(text)])
          const rank = (unit: DocUnit) => {
            let n = 0
            for (const w of unit.words) if (promptWords.has(w)) n++
            return n
          }
          let free = options.docLlmMax
          for (let di = 0; di < plans.length && free > 0; di++) {
            const plan = plans[di]
            if (!docNeeding.includes(plan)) continue
            const order = plan.units.map((u, i) => ({ u, i })).sort((a, b) => rank(b.u) - rank(a.u))
            for (const { u, i } of order) {
              if (free <= 0) break
              docCandidates.push({ doc: di, unit: i, preview: unitPreview(u) })
              free--
            }
          }
        }
        const needDocs = docNeeding.reduce((n, p) => n + p.limit, 0)
        // 1) кэш: повторяющийся запрос закрываем без вызова модели. Кусок справочника
        // узнаём по хэшу текста — после правки файла он переехал, но хэш тот же.
        let needModel = needDocs > 0 && docCandidates.length > 0
        const cached = needSkills > 0 || needModel ? cache.get(text) : null
        if (cached) {
          if (needSkills > 0) {
            for (const id of cached.skills) {
              if (atCap()) break
              if (!available.has(id) || skillInContext(id) || attach.includes(id)) continue
              attach.push(id)
              taskAttached.push(id)
            }
          }
          for (const plan of docNeeding) {
            const want = new Set(cached.docs)
            const found = plan.units
              .map((u, i) => ({ i, hash: contentHash(u.text) }))
              .filter(({ hash }) => want.has(hash))
              .map(({ i }) => i)
            if (found.length > 0) {
              plan.picks.push(...picksFromHits(plan.units, found.map((index) => ({ index, score: 1 })), plan.limit, options.docWindow))
            }
          }
          note(`broker: cache hit [${cached.skills.join(", ") || "—"}] docs [${cached.docs.length}] (${cache.size()} записей)`)
          needSkills = 0
          needModel = docNeeding.some((p) => p.picks.length === 0)
        } else if (needSkills > 0 && skillCandidates.length > 0) {
          needModel = true
        }
        if (needModel) {
          const started = Date.now()
          try {
            const broker = await llmBroker({
              prompt: text,
              skills: skillCandidates,
              needSkills,
              docs: docCandidates,
              needDocs,
              hints: options.brokerHints,
              generate: (t) => askModel(t, sessionID),
              log: note,
            })
            // пустой ответ не затирает прошлый удачный: иначе ход, где нужны были только
            // куски справочников, обнулил бы запись по скиллам
            const pickedDocs = broker.docs
              .map((pick) => plans[pick.doc]?.units[pick.unit])
              .filter(Boolean)
              .map((u) => contentHash(u!.text))
            if (broker.skills.length > 0 || pickedDocs.length > 0) cache.set(text, broker.skills, pickedDocs)
            for (const id of broker.skills) {
              if (atCap()) break
              if (!available.has(id) || skillInContext(id) || attach.includes(id)) continue
              attach.push(id)
              taskAttached.push(id)
            }
            for (const pick of broker.docs) {
              const plan = plans[pick.doc]
              if (!plan) continue
              plan.picks.push(...picksFromHits(plan.units, [{ index: pick.unit, score: 1 }], plan.limit, options.docWindow))
            }
            note(`broker: skills [${broker.skills.join(", ") || "—"}] docs [${broker.docs.map((d) => `D${d.doc}.${d.unit}`).join(", ") || "—"}] ${Date.now() - started}ms`)
          } catch (error) {
            note(`broker failed: ${String(error)}`)
          }
        }

        // вставка кусков справочников
        if (plans.length > 0) {
          const seen = injectedDocs.get(sessionID) ?? new Set<string>()
          injectedDocs.set(sessionID, seen)
          const chunks: string[] = []
          for (const plan of plans) {
            let used = 0
            let added = 0
            for (const block of plan.picks) {
              const hash = contentHash(block.text)
              const key = `${plan.path}#${block.start}#${hash}`
              if (used >= plan.budget) continue
              const header = `[${plan.label} — «${block.title}» #${hash}]`
              if (history !== null) {
                // кусок уже в контексте сессии — не дублируем; выпал или изменён — подставим
                if (history.includes(header)) continue
              } else if (seen.has(key)) {
                continue
              }
              const piece = clipBlock(block.text, plan.budget - used)
              if (piece.length === 0) continue
              chunks.push(`${header}\n${piece}`)
              seen.add(key)
              used += piece.length
              added += 1
            }
            note(`doc ${plan.path}: ${plan.units.length} units, added ${added}, ${used} chars`)
          }
          if (chunks.length > 0) {
            const labels = options.documents.map((d) => d.path).join(", ")
            event.prompt.text = `${text}\n\n<!-- skill-enforcer:doc-context -->\n[Выдержки из ${labels} — подставлены автоматически по смыслу запроса]\n\n${chunks.join("\n\n")}`
            const total = chunks.reduce((n, c) => n + c.length, 0)
            const titles = chunks.map((c) => c.split("\n")[0].slice(0, 70))
            note(`doc-inject: ${chunks.length} section(s), ${total} chars [${titles.join(" | ")}] (session ${sessionID})`)
          }
        }

        if (!wantSkills || all.length === 0) return

        // покрытие считаем по факту: что лежит в контексте сессии плюс что цепляем сейчас
        const touched = new Set<string>()
        for (const s of all) if (skillInContext(s.id) || attach.includes(s.id)) touched.add(s.id)
        const untouched = all.map((s) => s.id).filter((id) => !touched.has(id))
        note(`coverage: ${touched.size}/${all.length} скиллов; не трогали: ${untouched.join(", ") || "—"}`)

        if (attach.length === 0) return

        event.prompt.skills = [...current, ...attach.map((id) => ({ id }) as never)]
        for (const id of attach) contact.add(id)
        const turnSet = turnTask.get(sessionID) ?? new Set<string>()
        for (const id of taskAttached) turnSet.add(id)
        turnTask.set(sessionID, turnSet)
        note(`attached: ${attach.join(", ")} (session ${sessionID})`)
      } catch (error) {
        note(`prompt hook failed: ${String(error)}`)
      }
    })

    ctx.session.hook("context", (event) => {
      try {
        const contact = inContact.get(event.sessionID) ?? new Set<string>()
        const base = options.alwaysSkills.filter((id) => contact.has(id))
        const task = [...contact].filter((id) => !base.includes(id))
        const loaded = turnTask.get(event.sessionID)?.size ?? 0
        const rule = renderRule(options.minSkills, options.maxSkills, loaded, task, base, options.alwaysSkills)
        event.system.push({ type: "text", text: rule } as never)
        note(`injected rule: session=${event.sessionID} base=${base.length} task=${task.length}`)
      } catch (error) {
        note(`context hook failed: ${String(error)}`)
      }
    })

    note(`loaded: min=${options.minSkills} max=${options.maxSkills} always=${options.alwaysSkills.join(",") || "-"} attach=always:${options.attachAlways},picked:${options.attachPicked}`)

    ctx.tool.hook("execute.before", (event) => {
      try {
        if (event.tool !== "skill" && !event.tool.endsWith("_skill")) return
        const input = event.input as { id?: unknown } | undefined
        const id = typeof input?.id === "string" ? input.id : undefined
        if (!id) return
        const turnSet = turnTask.get(event.sessionID) ?? new Set<string>()
        turnSet.add(id)
        turnTask.set(event.sessionID, turnSet)
        const contact = inContact.get(event.sessionID) ?? new Set<string>()
        contact.add(id)
        inContact.set(event.sessionID, contact)
        note(`loaded: ${id} (session ${event.sessionID}, turn total ${turnSet.size})`)
      } catch (error) {
        note(`tool hook failed: ${String(error)}`)
      }
    })
  },
})
