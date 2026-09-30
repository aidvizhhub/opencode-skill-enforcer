import { appendFileSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
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
 *   padToMin        — добивать авто-подбор до minSkills даже без совпадений (по умолчанию false)
 *   defaultSkills   — список ID для добивки, когда padToMin включён
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
 *   announce        — писать в лог, что правило вставлено (по умолчанию false)
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
  padToMin: boolean
  defaultSkills: string[]
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
  announce: boolean
  logFile?: string
}

/** Описание файла-справочника: путь и персональные лимиты. */
interface DocSpec {
  path: string
  title?: string
  maxBlocks?: number
  maxChars?: number
}

/** База общения: структура ответа, живой контакт, язык без нейрослопа. */
const DEFAULT_ALWAYS = ["result-first", "dialog-humanity", "anti-ai-sludge"]

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
    padToMin: bool(o.padToMin, false),
    defaultSkills: list(o.defaultSkills, []),
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
    announce: bool(o.announce, false),
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
async function llmSelect(
  prompt: string,
  units: DocUnit[],
  generate: (text: string) => Promise<string>,
  limit: number,
  window: number,
  maxCandidates: number,
  log?: (message: string) => void,
): Promise<DocPick[]> {
  const preview = (unit: DocUnit) => unit.text.split("\n").slice(0, 3).join(" ").slice(0, 200)
  let candidates = units.map((unit, index) => ({ unit, index }))
  if (candidates.length > maxCandidates) {
    const promptWords = new Set([...stemWords(prompt), ...words(prompt)])
    const overlap = candidates.filter((c) => [...c.unit.words].some((w) => promptWords.has(w)))
    const rest = candidates.filter((c) => !overlap.includes(c))
    candidates = [...overlap, ...rest].slice(0, maxCandidates)
  }
  const listing = candidates.map((c, i) => `${i}: ${preview(c.unit)}`).join("\n")
  const ask = [
    "Ниже пронумерованные абзацы из файла-справочника и запрос пользователя.",
    "Выбери номера абзацев, которые реально нужны для ответа на запрос.",
    `Ответь только номерами через запятую (не больше ${limit}), или NONE.`,
    "",
    `Запрос: ${prompt}`,
    "",
    listing,
  ].join("\n")
  const answer = await generate(ask)
  log?.(`raw: ${answer.replace(/\s+/g, " ").slice(0, 160)}`)
  const indices = (answer.match(/\d+/g) ?? []).map(Number).filter((n) => n >= 0 && n < candidates.length)
  if (indices.length === 0) return []
  const hits = indices.slice(0, limit).map((n, order) => ({ index: candidates[n].index, score: 1 - order / 100 }))
  return picksFromHits(units, hits, limit, window)
}

/**
 * Семантический пик скиллов: когда словесный добор недобрал, спрашиваем модель по
 * списку «id — описание». Возвращает ID из списка, максимум `need`.
 */
async function llmPickSkills(
  prompt: string,
  refs: SkillRef[],
  generate: (text: string) => Promise<string>,
  need: number,
  log?: (message: string) => void,
): Promise<string[]> {
  if (refs.length === 0 || need <= 0) return []
  const listing = refs.map((r) => `- ${r.id}: ${r.description.slice(0, 160)}`).join("\n")
  const ask = [
    "Ты подбираешь скиллы-инструкции под задачу пользователя.",
    "Выбирай только те, что реально помогут ответить. Не выбирай скилл по названию инструмента.",
    `Ответь не больше чем ${need} ID через запятую, ровно из списка ниже. Если подходящих нет — ответь NONE.`,
    "",
    `Запрос: ${prompt}`,
    "",
    "Скиллы:",
    listing,
  ].join("\n")
  const answer = await generate(ask)
  log?.(`skill llm raw: ${answer.replace(/\s+/g, " ").slice(0, 160)}`)
  return refs
    .map((r) => r.id)
    .filter((id) => new RegExp(`(^|[^\\w-])${id}([^\\w-]|$)`).test(answer))
    .slice(0, need)
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
    /** sessionID -> какие разделы справочников уже подставлены (кэш поверх durable-хранилища). */
    const injectedDocs = new Map<string, Set<string>>()
    const seenKey = (sessionID: string) => `injected/${sessionID}`

    /** Читает список подставленного: сначала память, потом ctx.storage (переживает reload). */
    const loadSeen = async (sessionID: string): Promise<Set<string>> => {
      const cached = injectedDocs.get(sessionID)
      if (cached) return cached
      const set = new Set<string>()
      try {
        const raw = await ctx.storage.get(seenKey(sessionID))
        if (Array.isArray(raw)) {
          for (const item of raw) if (typeof item === "string") set.add(item)
        }
      } catch (error) {
        note(`doc storage get failed: ${String(error)}`)
      }
      injectedDocs.set(sessionID, set)
      return set
    }

    /** Пишет список подставленного в ctx.storage; длинный список подрезаем. */
    const saveSeen = async (sessionID: string, set: Set<string>): Promise<void> => {
      const list = [...set].slice(-400)
      try {
        await ctx.storage.set(seenKey(sessionID), list)
      } catch (error) {
        note(`doc storage set failed: ${String(error)}`)
      }
    }

    const note = (message: string) => {
      const line = `${new Date().toISOString()} ${TAG} ${message}\n`
      if (options.announce) console.error(line.trimEnd())
      if (options.logFile) {
        try {
          appendFileSync(options.logFile, line)
        } catch {
          // маркерный файл — вспомогательный канал; его отказ не должен ронять хук
        }
      }
    }

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

    const docsFor = async (prompt: string, sessionID: string, history: string | null): Promise<string[]> => {
      const seen = await loadSeen(sessionID)
      const chunks: string[] = []
      let dirty = false
      for (const spec of options.documents) {
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
          continue
        }
        const limit = spec.maxBlocks ?? options.maxDocBlocks
        const budget = spec.maxChars ?? options.maxDocChars
        const label = spec.title ?? spec.path
        let picks = selectBlocks(prompt, cached.units, options.minDocScore, limit, options.docWindow)
        if (picks.length === 0 && options.docLlm) {
          try {
            picks = await llmSelect(prompt, cached.units, (t) => askModel(t, sessionID), limit, options.docWindow, options.docLlmMax, note)
            note(`doc llm: picked ${picks.length} (${path}) ${picks.map((p) => p.title).join(" | ")}`)
          } catch (error) {
            note(`doc llm failed ${path}: ${String(error)}`)
          }
        }
        let used = 0
        let added = 0
        for (const block of picks) {
          const key = `${path}#${block.start}#${contentHash(block.text)}`
          if (used >= budget) continue
          const header = `[${label} — «${block.title}» #${contentHash(block.text)}]`
          if (history !== null) {
            // кусок уже в контексте сессии — не дублируем; выпал (сжатие) или изменён — подставим
            if (history.includes(header)) continue
          } else if (seen.has(key)) {
            continue
          }
          const piece = clipBlock(block.text, budget - used)
          if (piece.length === 0) continue
          chunks.push(`${header}\n${piece}`)
          seen.add(key)
          dirty = true
          used += piece.length
          added += 1
        }
        note(`doc ${path}: ${cached.units.length} units, added ${added}, ${used} chars`)
      }
      if (dirty) await saveSeen(sessionID, seen)
      return chunks
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
        const substantive = text.trim().length >= options.minPromptChars
        const history = substantive ? await recentHistory(sessionID) : null
        // скилл уже в контексте сессии? Проверяем по истории (после сжатия вернём заново)
        const skillInContext = (id: string) =>
          history !== null ? new RegExp(`/skills/${id}(\\b|/)`).test(history) : contact.has(id)

        // справочники: релевантный раздел уезжает в контекст целиком; включается списком documents
        if (substantive && options.documents.length > 0) {
          const chunks = await docsFor(text, sessionID, history)
          if (chunks.length > 0) {
            const labels = options.documents.map((d) => d.path).join(", ")
            event.prompt.text = `${text}\n\n<!-- skill-enforcer:doc-context -->\n[Выдержки из ${labels} — подставлены автоматически по смыслу запроса]\n\n${chunks.join("\n\n")}`
            const total = chunks.reduce((n, c) => n + c.length, 0)
            const titles = chunks.map((c) => c.split("\n")[0].slice(0, 70))
            note(`doc-inject: ${chunks.length} section(s), ${total} chars [${titles.join(" | ")}] (session ${sessionID})`)
          }
        }

        if (!options.autoAttach) return
        if (!options.attachAlways && !options.attachPicked && !options.skillLlm) return
        if (!substantive) return

        const all = await skillsAtHand()
        if (all.length === 0) return
        const available = new Set(all.map((s) => s.id))
        const atCap = () => options.maxAttach > 0 && attach.length >= options.maxAttach
        const attach: string[] = []
        const taskAttached: string[] = []

        // база общения — обязательна, цепляем один раз за сессию
        if (options.attachAlways) {
          for (const id of options.alwaysSkills) {
            if (atCap()) break
            if (!available.has(id) || skillInContext(id) || attach.includes(id)) continue
            attach.push(id)
          }
        }

        // добор по смыслу текущего запроса
        if (options.attachPicked) {
          const matched = pickSkills(text, all, options.maxSkills, options.minScore)
          if (options.padToMin && matched.length < options.minSkills) {
            for (const id of options.defaultSkills) {
              if (matched.length >= options.minSkills) break
              if (!matched.includes(id)) matched.push(id)
            }
          }
          for (const id of matched) {
            if (atCap()) break
            if (skillInContext(id) || attach.includes(id)) continue
            attach.push(id)
            taskAttached.push(id)
          }
        }

        // гарантия: если рабочих скиллов меньше minSkills — спрашиваем модель и подкладываем
        if (options.skillLlm && taskAttached.length < options.minSkills) {
          try {
            const need = options.minSkills - taskAttached.length
            const candidates = all.filter((s) => !skillInContext(s.id) && !attach.includes(s.id))
            const picked = await llmPickSkills(text, candidates, (t) => askModel(t, sessionID), need, note)
            for (const id of picked) {
              if (atCap()) break
              if (contact.has(id) || attach.includes(id)) continue
              attach.push(id)
              taskAttached.push(id)
            }
            note(`skill llm: picked ${picked.join(", ") || "—"} (session ${sessionID})`)
          } catch (error) {
            note(`skill llm failed: ${String(error)}`)
          }
        }

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
