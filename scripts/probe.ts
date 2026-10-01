/**
 * probe — стенд плагина. Гоняет настоящий `index.ts` через поддельный `ctx`,
 * без вызова модели (`session.generate` заглушен), и меряет качество отбора.
 *
 *   bun run scripts/probe.ts            # все проверки
 *   bun run scripts/probe.ts check      # только корректность (код 1 при падении)
 *   bun run scripts/probe.ts quality    # только замеры recall/precision
 *   bun run scripts/probe.ts live       # один настоящий opencode run (нужна модель)
 *
 * Назначение: ловить регрессии без юнит-тестов и держать перед глазами цифры
 * отбора. «Работает» здесь значит «проходит проверки и не теряет recall».
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { referenceOf, readOptions, splitDoc, stemWords, pickSkills, selectBlocks, type SkillRef } from "../core.ts"

const plugin: any = (await import("../index.ts")).default

let failures = 0
let checks = 0

function ok(name: string, cond: boolean, detail = "") {
  checks++
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`)
  }
}

function eq(name: string, got: unknown, want: unknown) {
  const same = JSON.stringify(got) === JSON.stringify(want)
  ok(name, same, same ? "" : `получено ${JSON.stringify(got)}, ждали ${JSON.stringify(want)}`)
}

const head = (t: string) => console.log(`\n${t}`)
const line = (t: string) => console.log(`\n--- ${t}`)

// ---------------------------------------------------------------- harness

interface Harness {
  send(text: string, sessionID?: string): Promise<{ text: string; skills?: { id: string }[] }>
  context(sessionID?: string): string
  tool(id: string, sessionID?: string): void
  log(): string
  brokerCalls(): number
  setAnswer(fn: (n: number) => string): void
  cleanup(): void
}

interface HarnessConfig {
  options?: Record<string, unknown>
  skills?: { id: string; description: string }[]
  /** null — session.context падает (фолбэк на injectedDocs) */
  history?: any[] | null
  docs?: string
}

function harness(config: HarnessConfig = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "se-probe-"))
  const logFile = join(dir, "log.txt")
  const docPath = join(dir, "doc.md")
  if (config.docs) writeFileSync(docPath, config.docs)

  const skills = config.skills ?? []
  const hooks: Record<string, Function[]> = {}
  const toolHooks: Function[] = []
  let calls = 0
  let answer: (n: number) => string = () => "SKILLS: NONE\nDOCS: NONE"
  let history: any[] | null = config.history === undefined ? [] : config.history

  const ctx = {
    options: {
      minSkills: 3,
      maxSkills: 5,
      maxAttach: 6,
      alwaysSkills: [],
      skillLlm: true,
      docLlm: true,
      minPromptChars: 1,
      cacheFile: "",
      ...(config.docs
        ? { documents: [{ path: docPath, title: "DOC", maxBlocks: 2, maxChars: 4000 }] }
        : {}),
      logFile,
      ...config.options,
    },
    skill: { list: async () => ({ data: skills }) },
    session: {
      context: async () => {
        if (history === null) throw new Error("history unavailable")
        return history
      },
      generate: async () => ({ text: answer(calls++) }),
      hook: (n: string, f: Function) => {
        ;(hooks[n] ??= []).push(f)
      },
    },
    tool: {
      hook: (n: string, f: Function) => {
        if (n === "execute.before") toolHooks.push(f)
      },
    },
  }
  ;(plugin.setup ? plugin : plugin({})).setup(ctx)

  return {
    async send(text, sessionID = "s") {
      const ev: any = { sessionID, prompt: { text } }
      await hooks.prompt[0](ev)
      return ev.prompt
    },
    context(sessionID = "s") {
      const ev: any = { sessionID, system: [] }
      hooks.context[0](ev)
      return ev.system.map((x: any) => x.text).join("\n")
    },
    tool(id, sessionID = "s") {
      toolHooks[0]({ sessionID, tool: "skill", input: { id } })
    },
    log: () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : ""),
    brokerCalls: () => calls,
    setAnswer(fn) {
      answer = fn
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// ---------------------------------------------------------------- fixtures

const SKILLS = [
  { id: "result-first", description: "Result-first подача ответа. Загружай, когда: сформулируй ответ, итог, как подать." },
  { id: "research-subagents", description: "Ресёрч и волны сабагентов. Загружай, когда: ресёрч, найди источники, subagents." },
  { id: "web-surf", description: "Поиск в интернете и браузер. Загружай, когда: загугли, найди источники, поищи в интернете." },
  { id: "mcp-setup", description: "Как ставить и настраивать MCP-серверы. Загружай, когда: подключи MCP, настрой mcp, mcp не работает." },
]

/** Реальный каталог скиллов, если он есть: без него замеры на выдумке. */
function realCatalog(): SkillRef[] {
  const dir = join(homedir(), ".config/opencode/skills")
  if (!existsSync(dir)) return []
  const out: SkillRef[] = []
  for (const name of readdirSync(dir)) {
    let head = ""
    try {
      head = readFileSync(join(dir, name, "SKILL.md"), "utf8").slice(0, 4000)
    } catch {
      continue
    }
    const meta = head.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ""
    const desc = meta
      .match(/description:\s*>?-?\s*\n?([\s\S]*?)(?:\n[a-z_]+:|$)/)?.[1]
      ?.replace(/\s+/g, " ")
      .trim()
    if (desc) out.push(referenceOf({ id: name, description: desc }))
  }
  return out
}

/** Разметка: промпт → скиллы, которые обязаны попасть в отбор. */
const GOLD: [string, string[]][] = [
  ["расскажи про сабагента", ["research-subagents"]],
  ["подключение mcp сервера", ["mcp-setup"]],
  ["объяснение простыми словами", ["explain-simply"]],
  ["найди источники по ресёрчу", ["research-subagents"]],
  ["запиши это в память", ["memory", "context-and-paths"]],
  ["итог сессии", ["session-context", "context-and-paths"]],
  ["звучит как нейрослоп, перепиши", ["anti-ai-sludge"]],
  ["не согласен, объясни почему", ["respectful-disagreement"]],  // explain-simply тут спорно
  ["живой разговор, как тебе идея", ["dialog-humanity"]],
  ["сформулируй ответ кратко", ["result-first"]],
  ["telegram бот на telethon", ["telegram-viral-writing"]],
]

/** Промпты, из которых плагин цеплять ничего не должен. */
const GOLD_NEGATIVE: string[] = [
  "проверь /home/someone/Projects/GithubPublic/opencode-skill-enforcer",
  "проверь ~/Projects/opencode-skill-enforcer",
  "глянь https://github.com/aidvizhhub/opencode-skill-enforcer",
  "ok",
  "а если по-другому?",
]

// ---------------------------------------------------------------- checks

function checkOptions() {
  head("опции")
  const o = readOptions({})
  eq("дефолт minSkills/maxSkills", [o.minSkills, o.maxSkills], [3, 5])
  eq("cacheHours в часах", o.cacheHours, 72)
  ok("cacheFile: \"\" выключает кэш", readOptions({ cacheFile: "" }).cacheFile === "")
  ok(
    "cacheFile не задан → дефолт в tmp",
    readOptions({}).cacheFile.includes("opencode-skill-enforcer"),
  )
  eq("documents принимает строку", readOptions({ documents: ["~/a.md"] }).documents, [
    { path: "~/a.md" },
  ])
  eq("documents отбрасывает битое", readOptions({ documents: [1, null, {}, { path: "x" }] }).documents, [
    { path: "x" },
  ])
  eq("minDocScore по умолчанию 3", readOptions({}).minDocScore, 3)
  eq("minScore по умолчанию 0 — работает доля", readOptions({}).minScore, 0)
  eq("minRatio по умолчанию 0.6", readOptions({}).minRatio, 0.6)
  eq("minScore не падает ниже 0", readOptions({ minScore: -5 }).minScore, 0)
  eq("minWords не падает ниже 1", readOptions({ minWords: 0 }).minWords, 1)
  eq("minRatio зажат в 0..1", [readOptions({ minRatio: 5 }).minRatio, readOptions({ minRatio: -1 }).minRatio], [1, 0])
  eq("maxChars снизу 200", readOptions({ documents: [{ path: "x", maxChars: 1 }] }).documents[0].maxChars, 200)
}

function checkTokenizer() {
  head("токены")
  const cases: [string, string, string][] = [
    ["сабагент", "сабагентов", "сабаг"],
    ["ресёрч", "ресёрча", "ресёр"],
    ["подключение", "подключить", "подкл"],
  ]
  for (const [a, b, stem] of cases) {
    const sa = stemWords(a)
    ok(`«${a}» и «${b}» → ${stem}`, sa.has(stem) && stemWords(b).has(stem))
  }
  ok("путь вырезается", ![...stemWords("проверь ~/Projects/opencode-skill-enforcer")].includes("opencode"))
  ok("url вырезается", ![...stemWords("глянь https://x.dev/opencode")].includes("opencode"))
  ok("win-путь вырезается", ![...stemWords("глянь C:\\Users\\me\\opencode")].includes("opencode"))
  ok("слова промпта не теряются", stemWords("почини парсер конфига").has(stemWords("парсер").values().next().value!))
  // известная цена среза 4: telegram/telethon склеиваются в "tele".
  // Ловим осознанно — если срез поменяют, тест это покажет.
  {
    const stems = [...stemWords("telegram telethon api")]
    ok("telegram/telethon склеиваются — цена среза 4", stems.includes("tele"), stems.join(","))
    ok("api (3 буквы латинские) не срезается", stems.includes("api"), stems.join(","))
  }
  // английские формы: без среза 4 не сходятся
  {
    const en = (a: string, b: string) => [...stemWords(a)][0] === [...stemWords(b)][0]
    ok("en: test / tests", en("test", "tests"))
    ok("en: parse / parsing", en("parse", "parsing"))
    ok("en: cache / caching", en("cache", "caching"))
    ok("en: index / indexing", en("index", "indexing"))
    ok("ru: сабагент / сабагентов", en("сабагент", "сабагентов"))
    ok("ru: ресурр / ресурса", en("ресурс", "ресурса"))
  }
  ok("3-буквенные латинские целы", stemWords("почини mcp").has("mcp"))
  ok("стоп-слова выкинуты", !stemWords("скиллы и tools").has("скиллы"))
}

function checkDocSplit() {
  head("нарезка документов")
  const pad = "Дополнительный текст для объёма, чтобы блок набрал шестьсот символов и не слипся. "
  const text = Array.from({ length: 3 }, (_, i) => `# Раздел ${i}\n\n${pad.repeat(12)}\n`).join("\n")
  const units = splitDoc(text)
  ok("три блока на три раздела", units.length === 3, `получено ${units.length}`)
  const sizes = units.map((u) => u.text.length)
  ok("блоки не огрызки", sizes.every((s) => s >= 200), JSON.stringify(sizes))
  ok("подпись из заголовка", units[0].title === "Раздел 0", units[0].title)

  const code = "# A\n\n```\n\nпустая строка в коде\n\n```\n\nхвост\n"
  ok("пустая строка в fence не рвёт блок", splitDoc(code).length <= 2, `${splitDoc(code).length}`)

  const list = "# Список\n\n- пункт один\n\n- пункт два\n\n- пункт три\n"
  ok("список через пустые строки — один блок", splitDoc(list).length === 1, `${splitDoc(list).length}`)

  line("короткий запрос не должен ловить ноль из-за порога")
  {
    const three = "# Один\n\n" + "модель сабагентов и память плагина. ".repeat(20) + "\n"
    const u = splitDoc(three)
    // в промпте ровно 3 значимых слова — все три есть в блоке
    const p3 = "про сабагентов и память"
    const hits = selectBlocks(p3, u, 4, 2, 1)
    ok("minDocScore выше числа слов не даёт ложного нуля", hits.length === 1, `найдено ${hits.length}`)
    const p2 = "модель сабагентов"
    ok("промпт из 2 слов ловит свой блок", selectBlocks(p2, u, 4, 2, 1).length === 1)
    ok("абсолютно чужое слово не ловит ничего", selectBlocks("квантовая физика", u, 4, 2, 1).length === 0)

    // тот же баг в скиллах: minWords выше числа слов запроса отсекал всё
    const two = [{ id: "mcp-setup", description: "Подключение и настройка mcp. Загружай, когда: mcp, сервер." }].map(referenceOf)
    const short = pickSkills("настрой mcp", two, 5, 0, 0.6, 3)
    ok("minWords выше числа слов не режет скиллы", short.includes("mcp-setup"), JSON.stringify(short))
    ok("чужое слово всё равно не цепляет", pickSkills("квантовая физика", two, 5, 0, 0.6, 2).length === 0)
  }

  const real = join(homedir(), "AGENTS.md")
  if (existsSync(real)) {
    const u = splitDoc(readFileSync(real, "utf8"))
    // последний блок файла может быть коротким — это хвост, а не огрызок
    const tiny = u.slice(0, -1).filter((x) => x.text.length < 200).length
    ok("AGENTS.md без огрызков в середине", tiny === 0, `огрызков ${tiny} из ${u.length}`)
  }
}

async function checkBrokerIndexes() {
  head("ответ брокера: битые индексы")
  const pad = "Дополнительный текст для объёма. "
  const doc = Array.from({ length: 3 }, (_, i) => `# Р${i}\n\n${pad.repeat(12)}\n`).join("\n")
  for (const answer of [
    "SKILLS: research-subagents\nDOCS: D0.0",
    "SKILLS: research-subagents\nDOCS: D0.3",
    "SKILLS: research-subagents\nDOCS: D0.99",
    "SKILLS: research-subagents\nDOCS: D1.0",
    "SKILLS: research-subagents\nDOCS: D0.0, D0.55, D0.1",
    "SKILLS: research-subagents\nDOCS: D0.7, D1.1, D2.2",
    "SKILLS: research-subagents\nDOCS: D0.-1",
  ]) {
    const h = harness({
      skills: SKILLS,
      docs: doc,
      options: { minSkills: 2, alwaysSkills: [], attachPicked: false },
    })
    h.setAnswer(() => answer)
    const p = await h.send("найди источники по ресёрчу про сабагентов")
    const log = h.log()
    const crash = log.includes("broker failed")
    const skillsKept = (p.skills ?? []).some((s) => s.id === "research-subagents")
    ok(`${answer.split("\n")[1]} — без сбоя`, !crash, log.match(/broker failed.*/)?.[0] ?? "")
    ok(`${answer.split("\n")[1]} — скиллы из того же ответа целы`, skillsKept)
    h.cleanup()
  }
}

async function checkSkillsFlow() {
  head("поток скиллов")
  const h = harness({ skills: SKILLS, options: { alwaysSkills: ["result-first"], minSkills: 3 } })
  h.setAnswer(() => "SKILLS: research-subagents, web-surf\nDOCS: NONE")
  const p = await h.send("найди источники по ресёрчу про сабагентов")
  const ids = (p.skills ?? []).map((s) => s.id)
  ok("база цепляется", ids.includes("result-first"), JSON.stringify(ids))
  ok("добор по смыслу цепляется", ids.includes("research-subagents"), JSON.stringify(ids))
  ok("правило показывает прогресс", /2\/3/.test(h.context()))

  line("дедупликация по истории")
  const h2 = harness({
    skills: SKILLS,
    docs: "# П\n\n" + "текст про память плагина и сессии. ".repeat(20) + "\n",
  })
  h2.setAnswer(() => "SKILLS: research-subagents\nDOCS: D0.0")
  const first = await h2.send("память плагина и сессии")
  ok("документ приклеен", /\[DOC/.test(first.text))
  const seen = h2.log()
  ok("история в логе не пустая", seen.length > 0)
  h.cleanup()
  h2.cleanup()
}

async function checkToolHook() {
  head("tool-hook")
  const h = harness({ skills: SKILLS, options: { alwaysSkills: ["result-first"] } })
  h.setAnswer(() => "SKILLS: NONE\nDOCS: NONE")
  await h.send("найди источники по ресёрчу")
  h.tool("mcp-setup")
  h.tool("no-such-skill")
  const rule = h.context()
  ok("реальный скилл засчитан", rule.includes("mcp-setup"), rule)
  ok("выдуманный не попал", !rule.includes("no-such-skill"))
  ok("пропуск в логе", h.log().includes("skipped unknown skill"))
  h.cleanup()
}

async function checkCache() {
  head("кэш брокера")
  line("выключен пустой строкой")
  // 12 кандидатов-скиллов и 4 блока документа: лексики не хватает → нужен брокер
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: `filler-${i}`,
    description: "Универсальный скилл про много разных вещей. Загружай, когда: универсально, всякое, общее.",
  }))
  const skills = [...SKILLS, ...many]
  const pad = "текст про карты памяти плагина. "
  const doc = Array.from({ length: 4 }, (_, i) => `# Б${i}\n\n${pad.repeat(40)}\n`).join("\n\n")
  const Q = "заряди карту телефона и включи навигатор"
  line("выключен пустой строкой")
  const off = harness({ skills, docs: doc, options: { cacheFile: "" } })
  off.setAnswer(() => "SKILLS: NONE\nDOCS: D0.0")
  for (const s of ["a", "b", "c"]) await off.send(Q, s)
  const noCache = off.brokerCalls()
  line("включён файлом")
  void noCache
  const dir2 = mkdtempSync(join(tmpdir(), "se-cache-"))
  const file2 = join(dir2, "c.json")
  const on = harness({ skills, docs: doc, options: { cacheFile: file2 } })
  on.setAnswer(() => "SKILLS: NONE\nDOCS: D0.0")
  for (const s of ["a", "b", "c"]) await on.send(Q, s)
  const withCache = on.brokerCalls()
  ok("кэш не может сделать хуже", withCache <= noCache, `без кэша ${noCache}, с кэшем ${withCache}`)
  ok("короткое замыкание сработало, брокер не нужен", withCache === 0, `зван ${withCache} раз`)
  console.log(`    (брокер зван: без кэша ${noCache}, с кэшем ${withCache})`)
  rmSync(dir2, { recursive: true, force: true })
  off.cleanup()
  on.cleanup()
  return
}


async function checkNoBrokerWhenLexicalEnough() {
  head("экономия: лексики хватает → модель не зовётся")
  const doc = "# П\n\n" + "текст про карты памяти плагина. ".repeat(40) + "\n"
  // 2 кандидата, самим не хватает 1 → спросить некого
  const few = harness({ skills: SKILLS, docs: doc, options: { cacheFile: "" } })
  few.setAnswer(() => "SKILLS: web-surf\nDOCS: NONE")
  const p1 = await few.send("задача про mcp сервер и подключение")
  ok("брокер не вызван", few.brokerCalls() === 0, `вызовов ${few.brokerCalls()}`)
  ok("лексика цеплена сама", (p1.skills ?? []).length > 0, JSON.stringify(p1.skills))
  ok("в логе видна причина отсева", /lexical enough|no overlap/.test(few.log()), few.log().split("\n").filter((x) => /lexical|overlap/.test(x)).join(" | "))

  line("кандидатов много → брокер нужен")
  // Кандидаты пересекаются по ОДНОМУ слову: hasOverlap их видит, но до порога
  // minWords не дотягивают. Так лексика не добирает, а спросить есть кого.
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: `filler-${i}`,
    description: "Универсальный скилл про общие вещи. Загружай, когда: подключение, разное.",
  }))
  const rich = harness({ skills: [...SKILLS, ...many], docs: doc, options: { cacheFile: "" } })
  rich.setAnswer(() => "SKILLS: web-surf\nDOCS: D0.0")
  await rich.send("подключение сервера к агенту")
  const asked = rich.log().includes("broker raw")
  ok("брокер вызван", asked, `вызовов ${rich.brokerCalls()}, в логе broker raw: ${asked}`)

  few.cleanup()
  rich.cleanup()
}

async function checkShortPrompt() {
  head("короткие реплики")
  const h = harness({ skills: SKILLS, options: { minPromptChars: 12 } })
  h.setAnswer(() => "SKILLS: web-surf\nDOCS: NONE")
  const before = h.brokerCalls()
  const p = await h.send("ок")
  eq("«ок» не трогаем", [p.text, p.skills, h.brokerCalls() - before], ["ок", undefined, 0])
  h.setAnswer(() => "SKILLS: result-first\nDOCS: NONE")
  const long = await h.send("сформулируй ответ покрасивее")
  ok("длинная реплика цепляет скиллы", (long.skills ?? []).length > 0, JSON.stringify(long.skills))
  h.cleanup()
}

async function checkHistoryFallback() {
  head("фолбэк без истории")
  const h = harness({
    skills: SKILLS,
    docs: "# П\n\n" + "текст про память плагина и сессии. ".repeat(30) + "\n",
    history: null,
  })
  const a = await h.send("память плагина и сессии")
  const b = await h.send("память плагина и сессии")
  ok("первый ход приклеил", /\[DOC/.test(a.text))
  ok("второй не дублирует", !/\[DOC/.test(b.text))
  ok("падение истории в логе", h.log().includes("doc history failed"))
  h.cleanup()
}

function checkQuality() {
  head("качество отбора")
  const catalog = realCatalog()
  if (catalog.length === 0) {
    console.log("  (каталог ~/.config/opencode/skills не найден — замер пропущен)")
    return
  }
  console.log(`  каталог: ${catalog.length} скиллов`)

  for (const [minScore, minRatio, minWords] of [[4, 0, 1], [4, 0.6, 1], [4, 0, 2], [4, 0.5, 2], [4, 0.6, 2], [4, 0.7, 2], [4, 0.8, 2], [2, 0.6, 2]] as [number, number, number][]) {
    let want = 0
    let hit = 0
    const missed: string[] = []
    let extra = 0
    let cleanCount = 0
    for (const [prompt, expect] of GOLD) {
      const got = pickSkills(prompt, catalog, 5, minScore, minRatio, minWords)
      for (const e of expect) {
        want++
        if (got.includes(e)) hit++
        else missed.push(`${e} ← «${prompt}»`)
      }
      extra += got.filter((g) => !expect.includes(g)).length
      if (got.length > 0 && got.every((g) => expect.includes(g))) cleanCount++
    }
    const label = `пол=${minScore} `
    console.log(
      `  ${label}доля=${minRatio} слов≥${minWords}: recall ${((hit / want) * 100).toFixed(0)}% (${hit}/${want}), чистых ${cleanCount}/${GOLD.length}, лишних ${extra}`,
    )
    if (missed.length) console.log(`      промахи: ${missed.join(", ")}`)
  }

  const def = readOptions({})
  line(`дефолт из опций (пол ${def.minScore}, доля ${def.minRatio}, слов ≥ ${def.minWords})`)
  for (const [prompt, expect] of GOLD) {
    const got = pickSkills(prompt, catalog, 5, def.minScore, def.minRatio, def.minWords)
    const okHit = expect.every((e) => got.includes(e))
    const noise = got.filter((g) => !expect.includes(g))
    console.log(
      `  ${okHit && noise.length === 0 ? "✓" : okHit ? "~" : "✗"} «${prompt.slice(0, 32).padEnd(32)}» ${got.join(", ") || "—"}`,
    )
  }

  line("ложные срабатывания на пути и мусоре")
  for (const prompt of GOLD_NEGATIVE) {
    const got = pickSkills(prompt, catalog, 5, readOptions({}).minScore, readOptions({}).minRatio, readOptions({}).minWords)
    ok(`«${prompt.slice(0, 44)}» → пусто`, got.length === 0, got.join(", "))
  }

  line("сколько слов доходит до разбора")
  for (const prompt of [GOLD[0][0], GOLD_NEGATIVE[0]]) {
    console.log(`  «${prompt.slice(0, 40)}» → [${[...stemWords(prompt)].join(", ")}]`)
  }
}

async function checkLive() {
  head("живой прогон")
  const { spawnSync } = await import("node:child_process")
  const log = join(mkdtempSync(join(tmpdir(), "se-live-")), "log.txt")
  const r = spawnSync(
    "opencode",
    ["run", "-m", "opencode/big-pickle", "ответь одним словом: работает?"],
    { env: { ...process.env, SKILL_ENFORCER_DEBUG: log }, encoding: "utf8", timeout: 240_000 },
  )
  console.log("  выход:", r.status)
  if (existsSync(log)) {
    for (const l of readFileSync(log, "utf8").split("\n").filter((x) => /attached|doc-inject|coverage|broker/.test(x)))
      console.log("  " + l.replace(/^[\d-]+T[\d:.]+Z /, "").slice(0, 160))
  } else {
    console.log("  лог не создан — плагин не подхватился?")
  }
}

// ---------------------------------------------------------------- main

const mode = process.argv[2] ?? "all"

if (mode === "quality") {
  checkQuality()
} else if (mode === "live") {
  await checkLive()
} else {
  checkOptions()
  checkTokenizer()
  checkDocSplit()
  await checkBrokerIndexes()
  await checkSkillsFlow()
  await checkToolHook()
  await checkCache()
  await checkNoBrokerWhenLexicalEnough()
  await checkShortPrompt()
  await checkHistoryFallback()
  if (mode === "all") checkQuality()

  console.log(`\n${failures === 0 ? "все проверки прошли" : `ПРОВАЛЕНО ${failures} из ${checks}`}`)
  if (failures > 0) process.exit(1)
}
