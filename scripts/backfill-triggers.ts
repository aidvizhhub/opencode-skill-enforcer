/**
 * Проставляет скиллам явные секции «Загружай, когда» и «Не грузи, когда».
 *
 * Зачем: плагин-энфорсер читает триггеры с весом 2, а остальное описание с
 * весом 1. Если маркеров нет, весь текст падает в «остальное» и скилл с трудом
 * набирает проходной счёт — восемь наших скиллов выбирались только случайно,
 * а десять без антитриггеров тянут в контекст лишнее.
 *
 * Ничего не выдумывает: берёт существующие предложения из description и
 * раскладывает их по секциям. Тело SKILL.md не трогает.
 *
 *   bun run scripts/backfill-triggers.ts            # dry-run: покажет план
 *   bun run scripts/backfill-triggers.ts --write     # применить
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const SKILLS = join(homedir(), ".config/opencode/skills")
const write = process.argv.includes("--write")

/** Что скилл делает — первая часть description до маркера триггеров. */
type Plan = {
  skill: string
  what: string
  when: string
  notWhen: string
}

const PLANS: Plan[] = [
  {
    skill: "fable-loop",
    what: "End-to-end orchestrated workflow that runs a task the way Fable ran sessions - parallel evidence subagents, one committed plan, surgical execution with an intent gate, adversarial verification agents, honest outcome-first report.",
    when: '"non-trivial multi-step tasks", "/fable-loop", "run the fable loop", "do this the way Fable would"',
    notWhen: "only the rules without orchestration (use fable-method); very large multi-phase projects (prefer the GSD workflow, use this inside phases)",
  },
  {
    skill: "fable-judge",
    what: "Adversarial verification of finished work. Treats any \"done\" as a set of claims, then re-runs the claimed verifications, diffs what actually changed, detects weakened tests and false completion claims, and delivers an evidence-based verdict (VERIFIED / VERIFIED WITH CAVEATS / REFUTED).",
    when: 'after any agent or model claims work is complete - "/fable-judge", "judge this work", "verify what it did", "did that actually work?"',
    notWhen: "nothing — this is the last step of any completion; run the fable-method trap suite only via the explicit subcommand",
  },
  {
    skill: "nodumb",
    what: "Проверяет гипотезу, причину, масштаб и применимые факты до реализации; результат — один рекомендуемый ход, его граница и проверяемый признак успеха.",
    when: 'перед любой массовой правкой, миграцией, унификацией или редизайном; перед повторной попыткой исправить тот же симптом; когда решение опирается на непроверенную причину, внешний факт или метрику',
    notWhen: "выбор продуктовой задачи, поиск edge cases, мелкая согласованная правка",
  },
  {
    skill: "changelog-discipline",
    what: "Write and maintain a CHANGELOG that records every completed code change without becoming a commit dump. Keep mechanical entries brief; preserve reasons and rejected alternatives for non-obvious decisions.",
    when: "after any code change in a project that has a changelog; setting one up; preparing a release; when the user asks why something was built this way",
    notWhen: "commit messages, PR descriptions, user-facing release notes",
  },
  {
    skill: "system-feedback",
    what: "Спроектировать и проверить видимую обратную связь для уже выбранного перехода состояния: принято ли действие, продолжается ли операция, окончателен ли результат и что сохранилось при сбое.",
    when: "невидимые, отложенные, оптимистичные и фоновые действия; async-данные и интерфейсы, где человек может разумно сомневаться в состоянии системы",
    notWhen: "мгновенный самоочевидный результат, выбор самого поведения, поиск всех корнеров, визуальная полировка",
  },
  {
    skill: "ask-nodumb",
    what: "Помогает разобрать продуктовую или UX-задачу до проектирования решения: увидеть скрытое предположение, отделить образ продукта от модели и технологии, найти наиболее ценный вопрос или следующий шаг.",
    when: "нужно придумать или обсудить фичу, экран, флоу, редизайн, концепт, принцип интерфейса или продуктовую стратегию; внешний факт, исследование или метрика становятся основанием продуктовой модели; запрос сразу предлагает решение; варианты кажутся одинаково возможными; нужен требовательный дизайн-консультант",
    notWhen: "исполнение уже согласованного решения, точечная визуальная правка, техническая реализация без продуктовой развилки",
  },
  {
    skill: "edge-hunt",
    what: "Находит неочевидные корнеры задачи через пересечение состояний, данных, порядка действий, сбоев и параллельных изменений; превращает их в ожидаемое поведение и проверяемые сценарии.",
    when: "перед реализацией или ревью нетривиальной продуктовой, UX- или технической задачи; при изменении stateful/async-поведения, сохранения, синхронизации, прав, интеграций и многошаговых флоу; когда просят продумать edge cases, corner cases, крайние случаи или проверить полноту постановки",
    notWhen: "мелкие механические правки; до выбора самой задачи или масштаба решения — сначала nodumb",
  },
  {
    skill: "nodumb-loop",
    what: "Маршрутизирует нетривиальную работу между ask-nodumb, nodumb, edge-hunt, system-feedback и changelog-discipline, выбирая только проверку, способную изменить следующий шаг.",
    when: "в начале продуктовой или технической задачи, когда применимы несколько скиллов; при смене слоя проблемы; после неудачной проверки",
    notWhen: "мелкая очевидная правка; когда нужный специализированный скилл уже однозначно выбран",
  },
  {
    skill: "fable-method",
    what: "A step-by-step problem-solving loop (classify the ask, define done, gather evidence, decide, act surgically, verify by observation, report outcome-first).",
    when: '"/fable-method", "use the fable method", "approach this like Fable", or proactively when starting any multi-step task that no task-specific skill covers',
    notWhen: "when a task-specific skill already covers the work",
  },
  {
    skill: "fable-domain",
    what: "Discuss a domain with the user, research it from real sources, then generate a trusted skill bundle for it - a step-by-step workflow with a flowchart, a domain adapter, a trap fixture, and a smoke eval.",
    when: '"/fable-domain <sector>", "make a skill for <domain>", "add a domain to the fable method", "give a lesser model Fable\'s workflow for <domain>"',
    notWhen: "a workflow without its flowchart, sources, and trap is not done",
  },
]

function buildDescription(p: Plan): string {
  // Значение YAML обязано быть в кавычках: внутри секций есть «Загружай, когда:»,
  // а двоеточие с пробелом в голом значении ломает парсер — скилл молча выпадает
  // из каталога. Внутренние двойные кавычки заменяем на одинарные, чтобы не
  // возиться с экранированием.
  const clean = (s: string) => s.replace(/"/g, "'").replace(/\s+/g, " ").trim()
  return `description: "${clean(p.what)} Загружай, когда: ${clean(p.when)} Не грузи, когда: ${clean(p.notWhen)}"`
}

let changed = 0
for (const plan of PLANS) {
  const file = join(SKILLS, plan.skill, "SKILL.md")
  if (!existsSync(file)) {
    console.log(`  пропущен: ${plan.skill} — файла нет`)
    continue
  }
  const raw = readFileSync(file, "utf8")
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) {
    console.log(`  пропущен: ${plan.skill} — нет frontmatter`)
    continue
  }
  // fable-method держит отдельное поле trigger: — оставляем
  const keepTrigger = /^trigger:/m.test(fm[1]) ? "trigger: /fable-method\n" : ""
  // Уже обработанный скилл пропускаем: иначе повторный запуск наслаивает
  // второй «description:» и ломает YAML.
  if (/Загружай,?\s*когда:?/i.test(fm[1])) {
    console.log(`  ${plan.skill}: уже с маркерами, пропускаю`)
    continue
  }
  const nextFm = [
    "---",
    `name: ${plan.skill}`,
    buildDescription(plan),
    keepTrigger,
    "---",
    "",
  ].join("\n")
  const next = nextFm + raw.slice(fm[0].length).replace(/^\n+/, "")

  // Проверка ДО записи: сломанный YAML молча выкидывает скилл из каталога,
  // и заметить это можно только через список доступных скиллов.
  const nextDesc = next.match(/^description:\s*(.*)$/m)?.[1] ?? ""
  const unbalanced = (nextDesc.match(/"/g) ?? []).length % 2 !== 0
  if (unbalanced) {
    console.log(`  ОШИБКА ${plan.skill}: нечётное число кавычек, не пишу`)
    process.exitCode = 1
    continue
  }
  // значение в двойных кавычках не должно содержать голую «Ключ: значение» вне них
  if (!nextDesc.startsWith('"')) {
    console.log(`  ОШИБКА ${plan.skill}: значение не в кавычках, YAML сломается`)
    process.exitCode = 1
    continue
  }

  if (next === raw) continue
  changed++
  console.log(`  ${plan.skill}: ${keepTrigger ? "сохранил trigger: " : ""}описание перестроено`)
  if (write) writeFileSync(file, next)
}

console.log(
  write
    ? `\nприменено к ${changed} скиллам из ${PLANS.length}`
    : `\n dry-run: ${changed} из ${PLANS.length} изменятся. Добавь --write чтобы применить`,
)
if (!write && changed > 0) console.log("ничего не записано")
