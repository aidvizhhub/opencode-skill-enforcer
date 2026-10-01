/**
 * diag — разбор живого лога плагина: сколько контекста ушло на ход, сколько
 * стоил брокер, сколько раз впустую. Здесь смотрят на цифры из `logFile`,
 * а не на синтетику: вопрос «плагин окупается или жрёт токены» решается
 * только настоящими прогонами.
 *
 *   bun run scripts/diag.ts /tmp/opencode/q6.log
 *   bun run scripts/diag.ts /tmp/opencode/q6.log --prompts   # топ промптов
 */
import { readFileSync } from "node:fs"

const logPath = process.argv[2]
if (!logPath) {
  console.error("usage: bun run scripts/diag.ts <путь к логу> [--prompts]")
  process.exit(1)
}
const withPrompts = process.argv.includes("--prompts")

const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean)
const log = (tag: string) => lines.filter((l) => l.includes(tag))

const broker = log("[skill-enforcer] broker:")
const cacheHit = log("[skill-enforcer] broker: cache hit")
const realCalls = broker.filter((l) => !l.includes("cache hit"))
const brokerFailed = log("[skill-enforcer] broker failed")
const docInject = log("[skill-enforcer] doc-inject")
const attached = log("[skill-enforcer] attached")
const rules = log("[skill-enforcer] injected rule")
const skipped = log("[skill-enforcer] skipped unknown skill")

const ms = (l: string) => Number(l.match(/(\d+)ms/)?.[1] ?? 0)
const num = (l: string, re: RegExp) => Number(l.match(re)?.[1] ?? 0)

const brokerMs = realCalls.map(ms).filter((n) => n > 0).sort((a, b) => a - b)
const docChars = docInject.map((l) => num(l, /(\d+) chars/)).filter((n) => n > 0)

const pct = (arr: number[], p: number) =>
  arr.length === 0 ? 0 : arr[Math.min(arr.length - 1, Math.floor((arr.length - 1) * p))]

console.log(`\n=== ${logPath} ===`)
console.log(`строк в логе: ${lines.length}`)

console.log(`\n--- ходы ---`)
console.log(`  правил в system:        ${rules.length}`)
console.log(`  ходов с цепкой:         ${attached.length}`)
console.log(`  ходов с документом:     ${docInject.length}`)
const attachedIds = (l: string) =>
  (l.split("attached: ")[1] ?? "").split(" (session")[0].split(",").map((x) => x.trim()).filter(Boolean)
console.log(`  средняя цепка:          ${attached.length ? (attached.reduce((n, l) => n + attachedIds(l).length, 0) / attached.length).toFixed(1) : 0} скиллов`)

console.log(`\n--- цена контекста ---`)
if (docChars.length) {
  console.log(`  документы: всего ${docChars.reduce((a, b) => a + b, 0)} символов за ${docChars.length} ходов`)
  console.log(`  за ход: медиана ${pct(docChars, 0.5)}, максимум ${Math.max(...docChars)}`)
} else {
  console.log(`  документы: не вставлялись`)
}
const avgAttached = attached.length
  ? attached.reduce((n, l) => n + attachedIds(l).length, 0) / attached.length
  : 0
console.log(`  скиллы: в среднем ${avgAttached.toFixed(1)} на ход`)
console.log(`  правило: ${rules.length ? Math.round(rules.length * 0) : 0} (длина самого правила считается в renderRule)`)

console.log(`\n--- брокер ---`)
console.log(`  вызовов модели: ${realCalls.length}`)
console.log(`  попаданий в кэш: ${cacheHit.length}`)
console.log(`  провалов: ${brokerFailed.length}`)
if (brokerMs.length) {
  console.log(`  задержка: медиана ${pct(brokerMs, 0.5)} мс, максимум ${Math.max(...brokerMs)} мс`)
  const total = brokerMs.reduce((a, b) => a + b, 0)
  console.log(`  всего на брокера: ${(total / 1000).toFixed(1)} с`)
}
const emptySkills = realCalls.filter((l) => l.includes("skills [—]")).length
const emptyAll = realCalls.filter((l) => l.includes("skills [—]") && l.includes("docs [—]")).length
if (realCalls.length) {
  console.log(`  вызовов без единого выбора (чистый расход): ${emptyAll} из ${realCalls.length}`)
  console.log(`  вызовов без скиллов: ${emptySkills}`)
  if (cacheHit.length && realCalls.length) {
    console.log(`  экономия кэша: ${(cacheHit.length / (cacheHit.length + realCalls.length) * 100).toFixed(0)}% ходов без модели`)
  }
}

console.log(`\n--- здоровье ---`)
console.log(`  отброшено незнакомых скиллов: ${skipped.length}`)
const bad = log("failed")
console.log(`  любых ошибок: ${bad.length}`)
if (bad.length) for (const l of bad.slice(0, 5)) console.log(`    ${l.replace(/^[\d-]+T[\d:.]+Z /, "").slice(0, 120)}`)

if (withPrompts) {
  console.log(`\n--- что цеплялось (топ) ---`)
  const counts = new Map<string, number>()
  for (const l of attached) {
    for (const id of attachedIds(l)) {
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  for (const [id, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}× ${id}`)
  }
  console.log(`\n--- документы ---`)
  for (const l of docInject.slice(0, 10)) {
    console.log(`  ${l.replace(/^[\d-]+T[\d:.]+Z /, "").slice(0, 150)}`)
  }
}
console.log("")
