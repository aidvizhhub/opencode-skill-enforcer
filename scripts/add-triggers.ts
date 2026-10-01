/**
 * Дописывает список триггеров в секцию «Загружай, когда» скилла.
 *
 * Отличие от backfill-triggers.ts: тот раскладывает описание по секциям с нуля,
 * этот вставляет дополнительные слова в уже существующую секцию. Нужен, когда
 * скилл ловится на части запросов, а на части — нет, и слова на эти запросы
 * не выбраны.
 *
 * Три грабли, закрытые проверками до записи:
 * - вставлять надо ВНУТРЬ секции «Загружай, когда», а не в конец описания:
 *   referenceOf режет описание по «Не грузи, когда», всё дописанное после него
 *   молча выбрасывается, скрипт отработает, а эффекта ноль;
 * - значение YAML обязано быть в кавычках: внутри секций есть «Загружай, когда:»,
 *   а двоеточие с пробелом в голом значении ломает парсер и скилл молча
 *   выпадает из каталога;
 * - повторный запуск не должен наслаивать дубли, поэтому проверяем дубликаты.
 *
 *   bun run scripts/add-triggers.ts            # dry-run: покажет план
 *   bun run scripts/add-triggers.ts --write    # применить
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const SKILLS = join(homedir(), ".config/opencode/skills")
const write = process.argv.includes("--write")
const MARK = "Загружай, когда:"
const NEG = /Не грузи,?\s*когда:?/i

/** Скилл → слова, которые в него добавляем. */
const ADD: Record<string, string> = {
  "port-and-delivery":
    "сделай комит и деплой, задеплой, запуши на github, как репу удалить, отдай изменения, доставь правки, собери патч",
  "live-path-execution":
    "что с брокером, покажи фактами, докажи что работает, у меня падает тест что проверить первым, проверь вживую",
  "truth-first-pruning":
    "удали скилл, убери скилл, давай удалим, снеси нахуй, что не надо трогать, почисти что осиротело, выкинь лишнее",
  "product-hygiene":
    "проверь код на адекватность, убери мусор, что лишнее в проекте, оцени проект целиком, найди дубль",
  "dialog-humanity":
    "как ты общаешься с человеком, не пересказывай события как отчёт, это разговор а не задача, просто поболтаем",
  "human-reasoning":
    "что это говорит нам, и что с этого следует, гипотеза или факт, рассуждение из данных, отделить знание от догадки",
  nodumb: "а что по рискам, какие риски, что проверить первым, гипотеза не проверена, проверить гипотезу",
  "code-comments":
    "покажи diff, что именно исчезло, покажи изменения, где лежит в коде, файл и строка, объясни правку",
}

/** То же, что делает плагин при разборе frontmatter. */
function readDescription(fm: string): { value: string; full: string } | null {
  const m = fm.match(/description:\s*>?-?\s*\n?([\s\S]*?)(?:\n[a-z_]+:|$)/)
  if (!m) return null
  return { value: m[1], full: m[0] }
}

/** Вставляет add внутрь секции «Загружай, когда», не трогая «Не грузи». */
function insert(description: string, add: string): string {
  const negAt = description.search(NEG)
  const at = description.lastIndexOf(MARK, negAt < 0 ? description.length : negAt)
  if (at < 0) return `${description} ${MARK} ${add}`
  const cut = at + MARK.length
  return `${description.slice(0, cut)} ${add}; ${description.slice(cut)}`
}

/** Уже дописанные триггеры не трогаем — иначе повторный запуск наслоит дубли. */
function alreadyThere(description: string, add: string): boolean {
  const known = add
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 3)
  const hits = known.filter((s) => description.toLowerCase().includes(s)).length
  return hits >= Math.ceil(known.length / 2)
}

let changed = 0
for (const [id, add] of Object.entries(ADD)) {
  const file = join(SKILLS, id, "SKILL.md")
  if (!existsSync(file)) {
    console.log(`  ${id}: файла нет, пропускаю`)
    continue
  }
  const raw = readFileSync(file, "utf8")
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) {
    console.log(`  ${id}: нет frontmatter`)
    process.exitCode = 1
    continue
  }
  const desc = readDescription(fm[1])
  if (!desc) {
    console.log(`  ОШИБКА ${id}: не читается description`)
    process.exitCode = 1
    continue
  }
  const flat = desc.value.replace(/\s+/g, " ").trim()
  if (alreadyThere(flat, add)) {
    console.log(`  ${id}: триггеры уже есть`)
    continue
  }

  const nextValue = insert(flat, add)
  const nextFm = fm[1].replace(desc.full, `description: "${nextValue.replace(/"/g, "'")}"`)
  const next = `---\n${nextFm}\n---` + raw.slice(fm[0].length)

  // проверки ДО записи
  const back = next.match(/^---\n([\s\S]*?)\n---/)
  const rd = readDescription(back?.[1] ?? "")
  const line = next.match(/^description:.*$/m)?.[0] ?? ""
  if (!line.startsWith('description: "') || (line.match(/"/g) ?? []).length % 2 !== 0) {
    console.log(`  ОШИБКА ${id}: сломаны кавычки в YAML`)
    process.exitCode = 1
    continue
  }
  if (!rd || rd.value.length < 20) {
    console.log(`  ОШИБКА ${id}: после вставки описание не читается`)
    process.exitCode = 1
    continue
  }
  if (!rd.value.includes(add.split(",")[0].trim())) {
    console.log(`  ОШИБКА ${id}: вставка не попала в результат`)
    process.exitCode = 1
    continue
  }
  // режекс по «Не грузи» не должен отрезать вставку
  const negAt = rd.value.search(NEG)
  if (negAt >= 0 && negAt < rd.value.indexOf(add.split(",")[0].trim())) {
    console.log(`  ОШИБКА ${id}: вставка ушла за «Не грузи, когда» и будет отрезана`)
    process.exitCode = 1
    continue
  }

  changed++
  console.log(`  ${id}: +${nextValue.length - flat.length} симв. в секцию «Загружай, когда»`)
  if (write) writeFileSync(file, next)
}

console.log(
  write
    ? `\nприменено к ${changed} из ${Object.keys(ADD).length}`
    : `\n dry-run: ${changed} из ${Object.keys(ADD).length} изменятся. Добавь --write чтобы применить`,
)
if (!write && changed > 0) console.log("ничего не записано")
