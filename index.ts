import { appendFileSync, readFileSync, statSync } from "node:fs"
import { Plugin } from "@opencode/plugin"
import {
  expandHome,
  llmBroker,
  makeCache,
  pickSkills,
  readOptions,
  renderRule,
  selectBlocks,
  splitDoc,
  stemWords,
  unitPreview,
  type BrokerDocCandidate,
  type DocPick,
  type DocUnit,
  type Options,
  type SkillRef,
  clipBlock,
  contentHash,
  hasOverlap,
  numMatches,
  picksFromHits,
  TAG,
} from "./core.ts"
import { embedPick } from "./core-embed.ts"
import { cloudPick } from "./core-embed-cloud.ts"
import { referenceOf } from "./core.ts"

/**
 * Обвязка плагина: хуки, состояние сессии, файлы-справочники. Вся проверяемая
 * логика — в `core.ts`, её дёргает `scripts/probe.ts`.
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
 *   minScore        — абсолютный пол счёта для авто-подбора (по умолчанию 4)
 *   minRatio        — доля от лучшего счёта в ходе; ниже — не берём (по умолчанию 0.6)
 *   minWords        — сколько разных слов промпта должно совпасть с описанием (по умолчанию 2)
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
 *   cacheHours      — сколько часов запись в кэше живёт (по умолчанию 72, то есть трое суток)
 *   logFile         — путь к файлу-маркеру; если задан, туда пишутся все события
 */

export default Plugin.define({
  id: "skill-enforcer",
  setup(ctx) {
    const options: Options = readOptions(ctx.options)
    /** sessionID -> всё, что уже в контексте (база + рабочие, прицепленные или загруженные инструментом). */
    const inContact = new Map<string, Set<string>>()
    /** sessionID -> рабочие скиллы, попавшие в контекст в текущем ходе (для счётчика «минимум N»). */
    const turnTask = new Map<string, Set<string>>()
    /** путь -> разобранный файл-справочник (кэш по mtime). */
    const docCache = new Map<string, { mtimeMs: number; units: DocUnit[] }>()
    /** sessionID -> какие куски справочников уже подставлены (фолбэк, когда история недоступна). */
    const injectedDocs = new Map<string, Set<string>>()
    /** sessionID -> когда последний раз видели сессию; по этому подрезаем карты. */
    const seenAt = new Map<string, number>()

    /**
     * Сессии в картах живут до перезапуска сервиса, а сервис не перезапускают
     * неделями. Срезаем всё, к чему не возвращались дольше суток.
     */
    const SESSION_TTL = 24 * 3600_000
    const touch = (sessionID: string) => {
      seenAt.set(sessionID, Date.now())
      if (seenAt.size <= 64) return
      const cutoff = Date.now() - SESSION_TTL
      for (const [id, at] of seenAt) {
        if (at > cutoff) continue
        seenAt.delete(id)
        inContact.delete(id)
        turnTask.delete(id)
        injectedDocs.delete(id)
      }
    }

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

    /** id всех известных скиллов: tool-hook не должен верить модели на слово. */
    let knownSkills = new Set<string>()

    const skillsAtHand = async (): Promise<SkillRef[]> => {
      try {
        const all = (await ctx.skill.list()).data
        const usable = all.filter(
          (s) => s.autoinvoke !== false && typeof s.description === "string" && s.description.length > 0,
        )
        knownSkills = new Set(all.map((s) => s.id))
        return usable.map(referenceOf)
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
    const docUnitsFor = (spec: { path: string; title?: string }): { path: string; label: string; units: DocUnit[] } | null => {
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
        touch(sessionID)
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
          const matched = pickSkills(
            text,
            all,
            options.maxSkills,
            options.minScore,
            options.minRatio,
            options.minWords,
          )
          // Эмбеддинг включается только там, где лексика не нашла ничего.
          // На 44 размеченных промптах гибрид дал 21 чистый ответ против 19
          // у одной лексики и recall 77% против 62%; эмбеддинг как основной
          // ранкер дал 6 чистых — мусор. Поэтому он именно запасной путь.
          // Облачный вариант меряем отдельно и он на скиллах не выигрывает,
          // но оставлен флагом как управляемый выход из лексики.
          const embedLabel = options.embedCloud ? "embed cloud" : "embed"
          if (matched.length === 0 && (options.embed || options.embedCloud)) {
            try {
              const items = all.map((s) => ({ id: s.id, text: s.description }))
              const byMeaning = options.embedCloud
                ? await cloudPick(text, items, options.maxSkills, {
                    model: options.embedCloudModel,
                    ns: "skills",
                  })
                : await embedPick(text, items, options.maxSkills)
              if (byMeaning) {
                const fresh = byMeaning.filter(
                  (id) => available.has(id) && !skillInContext(id) && !attach.includes(id),
                )
                note(`${embedLabel}: ${fresh.join(", ") || "—"} ${byMeaning.length - fresh.length} отброшено`)
                for (const id of fresh) {
                  if (atCap()) break
                  attach.push(id)
                  taskAttached.push(id)
                }
              } else {
                note(`${embedLabel}: недоступен, остаёмся на лексике`)
              }
            } catch (error) {
              note(`${embedLabel} failed: ${String(error).slice(0, 120)}`)
            }
          }
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
        // кандидаты брокеру — те, у кого хоть слово совпало (порог 1), плюс ещё
        // не в контакте: из полного каталога модель выбирает заметно хуже
        // Кандидаты для модели — те, кто ещё не в контакте и хоть как-то
        // пересекается со словами запроса. Порог цепки (minWords) тут не
        // применяем: на «объясни простыми словами» лексика берёт explain-simply,
        // а смотреть модели есть на шесть скиллов, иначе выбор сводится к нулю.
        const skillCandidates = options.skillLlm
          ? all
              .filter((s) => !skillInContext(s.id) && !attach.includes(s.id) && hasOverlap(text, s))
              .sort((a, b) => numMatches(text, b) - numMatches(text, a))
              .slice(0, options.skillLlmMax)
          : []
        // Модель нужна только там, где дешёвая эвристика не дала ответа.
        // Кандидатов нужно взять, пока они идут вровень по числу совпадений:
        // при needSkills=2 и трёх одинаково подходящих скиллах выбор между
        // ними ничего не решает, а вызов стоит 10–20 секунд.
        if (needSkills > 0 && skillCandidates.length > 0) {
          const scores = skillCandidates.map((s) => numMatches(text, s))
          const good = scores.filter((n) => n >= Math.max(...scores)).length
          if (good <= needSkills) {
            for (const s of skillCandidates) {
              if (atCap()) break
              attach.push(s.id)
              taskAttached.push(s.id)
            }
            needSkills = 0
            note(`lexical enough: ${skillCandidates.map((s) => s.id).join(", ")}`)
          }
        }
        const docNeeding = options.docLlm ? plans.filter((p) => p.picks.length === 0) : []
        const docCandidates: BrokerDocCandidate[] = []
        /** "док.блок" → сколько слов запроса попало. По этому режем заведомый мусор. */
        const docHitCount = new Map<string, number>()
        if (docNeeding.length > 0) {
          // слова блоков тоже stemWords — сравнивать надо в одном пространстве
          const promptWords = stemWords(text)
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
              const n = rank(u)
              docHitCount.set(`${di}.${i}`, n)
              docCandidates.push({ doc: di, unit: i, preview: unitPreview(u) })
              free--
            }
          }
        }
        // needDocs — только по документам, где словесный поиск не нашёл ничего.
        let needDocs = docNeeding.reduce((n, p) => n + p.limit, 0)
        // Показывать модели 33 блока, ни один из которых не пересекается со
        // словами запроса, бессмысленно: она отвечает NONE, а вызов стоит
        // 10–20 секунд. Кандидаты оставляем только те, где есть хотя бы одно
        // совпадение; если таких нет — не зовём модель вовсе.
        const docWithHits = docCandidates.filter((c) => docHitCount.get(`${c.doc}.${c.unit}`) ?? 0 > 0)
        // Облачный слой для блоков: срабатывает там же, где лексика молчит, и не
        // зависит от docLlm — его задача не в брокере, а в заполнении дыры без
        // вызова LLM. Платим сетью и текстом наружу, поэтому по умолчанию off.
        if (options.embedCloud) {
          const empty = plans
            .map((plan, di) => ({ plan, di }))
            .filter(({ plan }) => plan.picks.length === 0)
          const blocks = empty.flatMap(({ plan, di }) =>
            plan.units.map((u, ui) => ({ id: `${di}.${ui}`, text: u.text })),
          )
          if (blocks.length > 0) {
            try {
              const byMeaning = await cloudPick(text, blocks, options.maxDocBlocks, {
                model: options.embedCloudModel,
                ns: "docs",
              })
              if (byMeaning && byMeaning.length > 0) {
                for (const id of byMeaning) {
                  const [di, ui] = id.split(".").map(Number)
                  const plan = plans[di]
                  if (!plan || Number.isNaN(ui)) continue
                  plan.picks.push(...picksFromHits(plan.units, [{ index: ui, score: 1 }], plan.limit, options.docWindow))
                }
                note(`doc embed cloud: ${byMeaning.length} блок(ов) — ${byMeaning.join(", ")}`)
              } else {
                note("doc embed cloud: пусто или недоступно")
              }
            } catch (error) {
              note(`doc embed cloud failed: ${String(error).slice(0, 120)}`)
            }
          }
        }
        if (needDocs > 0 && docCandidates.length > 0 && docWithHits.length === 0) {
          needDocs = 0
          note(`doc no overlap: в файле нет ни одного слова из запроса, брокер пропущен`)
        }
        // Если блоков мало — выбирать не из чего, берём первые по частотности.
        if (needDocs > 0 && docWithHits.length > 0 && docWithHits.length <= needDocs) {
          for (const c of docWithHits) {
            const plan = plans[c.doc]
            if (!plan) continue
            plan.picks.push(...picksFromHits(plan.units, [{ index: c.unit, score: 1 }], plan.limit, options.docWindow))
          }
          note(`doc lexical enough: ${docWithHits.length} блок(ов) из ${docWithHits.map((c) => `D${c.doc}.${c.unit}`).join(", ")}`)
          needDocs = 0
        }
        // Скиллы лексика уже закрыла, а блоков документа больше, чем нужно.
        // Раньше в этом случае модель звали ради выбора между блоками: на живых
        // прогонах это стоило 15.9 секунды на два вызова, оба вернули пусто по
        // скиллам. Если нужные скиллы уже есть, платить за выбор блока нечем —
        // брокер больше не за что звать.
        if (needDocs > 0 && needSkills === 0 && docWithHits.length > needDocs) {
          for (const c of docWithHits) {
            const plan = plans[c.doc]
            if (!plan) continue
            plan.picks.push(...picksFromHits(plan.units, [{ index: c.unit, score: 1 }], plan.limit, options.docWindow))
          }
          note(`doc lexical enough (скиллы уже есть): ${docWithHits.length} блок(ов) из ${docWithHits.map((c) => `D${c.doc}.${c.unit}`).join(", ")}`)
          needDocs = 0
        }
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
        touch(event.sessionID)
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
        // каталог ещё не сходили (правый ход без prompt-hook) — тогда не фильтруем
        if (knownSkills.size > 0 && !knownSkills.has(id)) {
          note(`skipped unknown skill: ${id} (session ${event.sessionID})`)
          return
        }
        touch(event.sessionID)
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
