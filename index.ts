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
 *   autoAttach      — прикреплять подобранные скиллы к промпту (по умолчанию true)
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
  autoAttach: boolean
  padToMin: boolean
  defaultSkills: string[]
  minPromptChars: number
  minScore: number
  announce: boolean
  logFile?: string
}

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
    padToMin: bool(o.padToMin, false),
    defaultSkills: list(o.defaultSkills, []),
    minPromptChars: Math.max(0, int(o.minPromptChars, 12)),
    minScore: Math.max(1, int(o.minScore, 3)),
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

function renderRule(min: number, max: number, loaded: string[]): string {
  const loadedLine =
    loaded.length === 0
      ? "Пока ничего не загружено в этом ходе — загрузи первым делом, прежде чем отвечать по существу."
      : `Уже в контакте: ${loaded.join(", ")}. Следуй им и не перезагружай без нужды; сменилась задача — добери по теме.`
  return [
    "ПРАВИЛО СКИЛЛОВ (проверка на каждом шаге):",
    `1. Перед содержательным ответом сверься с доступными скиллами и загрузи через инструмент skill минимум ${min} подходящих (цель ${min}–${max}).`,
    "2. Не отвечай по существу, не загрузив ни одного скилла, если задача вообще подпадает под наши скиллы.",
    `3. ${loadedLine}`,
  ].join("\n")
}

export default Plugin.define({
  id: "skill-enforcer",
  setup(ctx) {
    const options = readOptions(ctx.options)
    // sessionID -> ID скиллов, загруженных с начала текущего хода
    const loadedThisTurn = new Map<string, Set<string>>()

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
        // в «контакте» с начала хода считаем и пред-выбранные скиллы, и то, что доцеп им сами
        const inContact = new Set(current.map((s) => String(s.id)))
        loadedThisTurn.set(sessionID, inContact)

        if (!options.autoAttach) return
        const text = event.prompt.text ?? ""
        if (text.trim().length < options.minPromptChars) return

        const refs = await skillsAtHand()
        if (refs.length === 0) return

        const picked = pickSkills(text, refs, options.maxSkills, options.minScore)
        if (options.padToMin && picked.length < options.minSkills) {
          for (const id of options.defaultSkills) {
            if (picked.length >= options.minSkills) break
            if (!picked.includes(id)) picked.push(id)
          }
        }
        if (picked.length === 0) return

        const added = picked.filter((id) => !inContact.has(id))
        if (added.length === 0) return

        event.prompt.skills = [...current, ...added.map((id) => ({ id }) as never)]
        for (const id of added) inContact.add(id)
        note(`attached: ${added.join(", ")} (session ${sessionID})`)
      } catch (error) {
        note(`prompt hook failed: ${String(error)}`)
      }
    })

    ctx.session.hook("context", (event) => {
      try {
        const loaded = [...(loadedThisTurn.get(event.sessionID) ?? [])]
        const rule = renderRule(options.minSkills, options.maxSkills, loaded)
        event.system.push({ type: "text", text: rule } as never)
        note(`injected rule: session=${event.sessionID} loaded=${loaded.length}`)
      } catch (error) {
        note(`context hook failed: ${String(error)}`)
      }
    })

    note(`loaded: min=${options.minSkills} max=${options.maxSkills} autoAttach=${options.autoAttach}`)

    ctx.tool.hook("execute.before", (event) => {
      try {
        if (event.tool !== "skill" && !event.tool.endsWith("_skill")) return
        const input = event.input as { id?: unknown } | undefined
        const id = typeof input?.id === "string" ? input.id : undefined
        if (!id) return
        const set = loadedThisTurn.get(event.sessionID) ?? new Set<string>()
        set.add(id)
        loadedThisTurn.set(event.sessionID, set)
        note(`loaded: ${id} (session ${event.sessionID}, turn total ${set.size})`)
      } catch (error) {
        note(`tool hook failed: ${String(error)}`)
      }
    })
  },
})
