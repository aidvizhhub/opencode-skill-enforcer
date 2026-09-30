import { appendFileSync } from "node:fs"
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
 *   padToMin        — добивать авто-подбор до minSkills даже без совпадений (по умолчанию false)
 *   defaultSkills   — список ID для добивки, когда padToMin включён
 *   minPromptChars  — не трогать короткие реплики короче этого (по умолчанию 12)
 *   minScore        — порог совпадения для авто-подбора; триггер весит 2, описание 1 (по умолчанию 3)
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
  padToMin: boolean
  defaultSkills: string[]
  minPromptChars: number
  minScore: number
  /** Скиллы «человеческого общения», которые держим в контакте всегда (цепляем один раз за сессию). */
  alwaysSkills: string[]
  /** Потолок на всё, что плагин цепляет к одному промпту (база + добор). */
  maxAttach: number
  announce: boolean
  logFile?: string
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
  return {
    minSkills: Math.max(0, int(o.minSkills, 3)),
    maxSkills: Math.max(1, int(o.maxSkills, 5)),
    autoAttach: bool(o.autoAttach, true),
    attachAlways: bool(o.attachAlways, true),
    attachPicked: bool(o.attachPicked, true),
    padToMin: bool(o.padToMin, false),
    defaultSkills: list(o.defaultSkills, []),
    minPromptChars: Math.max(0, int(o.minPromptChars, 12)),
    minScore: Math.max(1, int(o.minScore, 3)),
    alwaysSkills: list(o.alwaysSkills, DEFAULT_ALWAYS),
    maxAttach: Math.max(0, int(o.maxAttach, 6)),
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

interface SkillRef {
  id: string
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

function renderRule(min: number, max: number, taskLoaded: number, taskInContact: string[], base: string[]): string {
  const baseLine = base.length > 0
    ? `Базовые скиллы общения держим в контакте всегда: ${base.join(", ")}. Не отвечай вопреки им.`
    : "Базовых скиллов общения не задано."
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

    ctx.session.hook("prompt", async (event) => {
      try {
        const sessionID = event.sessionID
        const current = event.prompt.skills ?? []
        const contact = inContact.get(sessionID) ?? new Set<string>()
        for (const s of current) contact.add(String(s.id))
        inContact.set(sessionID, contact)
        turnTask.set(sessionID, new Set())

        if (!options.autoAttach) return
        if (!options.attachAlways && !options.attachPicked) return
        const text = event.prompt.text ?? ""
        if (text.trim().length < options.minPromptChars) return

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
            if (!available.has(id) || contact.has(id) || attach.includes(id)) continue
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
            if (contact.has(id) || attach.includes(id)) continue
            attach.push(id)
            taskAttached.push(id)
          }
        }

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
        const rule = renderRule(options.minSkills, options.maxSkills, loaded, task, base)
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
