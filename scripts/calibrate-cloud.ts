/**
 * Калибровка порога облачного эмбеддинга на реальных промптах.
 *
 * GOLD берётся из probe.ts, чтобы набор не расходился с тем, на котором мы
 * измеряем лексику. Замер печатает recall/чистых/лишних по каждому порогу —
 * порог ставится по этим числам, а не на глаз.
 *
 *   bun run scripts/calibrate-cloud.ts
 */
import { readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { cloudPick, cloudAvailable, CLOUD_THRESHOLD } from "../core-embed-cloud.ts"
import { pickSkills, readOptions, referenceOf } from "../core.ts"

function realCatalog() {
  const dir = join(homedir(), ".config/opencode/skills")
  const out: { id: string; description: string }[] = []
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, "SKILL.md")
    let raw = ""
    try {
      raw = readFileSync(file, "utf8")
    } catch {
      continue
    }
    const fm = /^---\n([\s\S]*?)\n---/.exec(raw)
    const desc = fm?.[1].match(/description:\s*>?-?\s*\n?([\s\S]*?)(?:\n[a-z_]+:|$)/)
    if (!desc) continue
    out.push({ id: name, description: desc[1].replace(/\s+/g, " ").trim() })
  }
  // pickSkills ждёт SkillRef с полем trigger — сырые описания не подойдут
  return out.map((s) => referenceOf(s))
}

/** GOLD и негативы вытаскиваем из исходника probe.ts: дублировать набор нельзя. */
function goldFromProbe(): { gold: [string, string[]][]; negative: string[] } {
  const src = readFileSync(new URL("./probe.ts", import.meta.url), "utf8")
  const goldBlock = /const GOLD: \[string, string\[\]\]\[\] = \[([\s\S]*?)\n\]/.exec(src)?.[1] ?? ""
  const gold: [string, string[]][] = []
  for (const line of goldBlock.split("\n")) {
    const m = /^\s*\[\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\[[^\]]*\])\s*\]/.exec(line)
    if (!m) continue
    gold.push([JSON.parse(`"${m[1]}"`) as string, JSON.parse(m[2]) as string[]])
  }
  const negBlock = /const GOLD_NEGATIVE: string\[\] = \[([\s\S]*?)\n\]/.exec(src)?.[1] ?? ""
  const negative = negBlock
    .split("\n")
    .map((l) => /^\s*"((?:[^"\\]|\\.)*)"/.exec(l)?.[1])
    .filter((x): x is string => Boolean(x))
    .map((x) => JSON.parse(`"${x}"`) as string)
  return { gold, negative }
}

if (!cloudAvailable()) {
  console.log("ключа нет: положи ~/.config/skill-enforcer/openrouter.key (scripts/setup-key.sh)")
  process.exit(1)
}

const catalog = realCatalog()
const rawCatalog = catalog.map((s) => ({ id: s.id, text: s.description }))
if (catalog.length === 0) {
  console.log("каталог скиллов не найден")
  process.exit(1)
}
const { gold, negative } = goldFromProbe()
console.log(`каталог: ${catalog.length} скиллов | GOLD: ${gold.length} | негативов: ${negative.length}`)
console.log(`порог в коде: ${CLOUD_THRESHOLD}\n`)

const THRESHOLDS = [0.40, 0.45, 0.48, 0.49, 0.50, 0.52, 0.55, 0.60, 0.65]
console.log("=== только облако (без лексики) ===")
for (const threshold of THRESHOLDS) {
  let want = 0
  let hit = 0
  let extra = 0
  let clean = 0
  let empty = 0
  for (const [prompt, expect] of gold) {
    const got = (await cloudPick(prompt, rawCatalog, 5, { threshold })) ?? []
    if (got.length === 0) empty++
    for (const e of expect) {
      want++
      if (got.includes(e)) hit++
    }
    extra += got.filter((g) => !expect.includes(g)).length
    if (got.length > 0 && got.every((g) => expect.includes(g))) clean++
  }
  let negHits = 0
  for (const p of negative) {
    const got = (await cloudPick(p, rawCatalog, 5, { threshold })) ?? []
    if (got.length > 0) negHits++
  }
  console.log(
    `  порог ${threshold.toFixed(2)}: recall ${((hit / want) * 100).toFixed(0)}% (${hit}/${want}), ` +
      `чистых ${clean}/${gold.length}, лишних ${extra}, пустых ${empty}, ложных на мусоре ${negHits}/${negative.length}`,
  )
}

const opts = readOptions({})
console.log(`\n=== гибрид: лексика (доля=${opts.minRatio} слов≥${opts.minWords}), облако добирает ===`)
for (const threshold of THRESHOLDS) {
  let want = 0
  let hit = 0
  let extra = 0
  let clean = 0
  let cloudUsed = 0
  for (const [prompt, expect] of gold) {
    const lex = pickSkills(prompt, catalog, 5, opts.minScore, opts.minRatio, opts.minWords)
    let got = [...lex]
    if (got.length === 0) {
      const byMeaning = (await cloudPick(prompt, rawCatalog, 5, { threshold })) ?? []
      if (byMeaning.length > 0) cloudUsed++
      got = byMeaning
    }
    for (const e of expect) {
      want++
      if (got.includes(e)) hit++
    }
    extra += got.filter((g) => !expect.includes(g)).length
    if (got.length > 0 && got.every((g) => expect.includes(g))) clean++
  }
  let negHits = 0
  for (const p of negative) {
    const lex = pickSkills(p, catalog, 5, opts.minScore, opts.minRatio, opts.minWords)
    const got = lex.length > 0 ? lex : ((await cloudPick(p, rawCatalog, 5, { threshold })) ?? [])
    if (got.length > 0) negHits++
  }
  console.log(
    `  порог ${threshold.toFixed(2)}: recall ${((hit / want) * 100).toFixed(0)}% (${hit}/${want}), ` +
      `чистых ${clean}/${gold.length}, лишних ${extra}, облако сработало ${cloudUsed}, ложных на мусоре ${negHits}/${negative.length}`,
  )
}
