/**
 * Проверка отбора на английском каталоге скиллов — на живых промптах.
 *
 *   bun run scripts/en-check.ts [каталог]
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { referenceOf, pickSkills, readOptions, stemWords, type SkillRef } from "../core.ts"

const dir = process.argv[2] ?? "/tmp/opencode/en-skills"
const catalog: SkillRef[] = []
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
  if (desc) catalog.push(referenceOf({ id: name, description: desc }))
}

const o = readOptions({})

/** Промпт → скиллы, которые обязаны попасть. */
const GOLD: [string, string[]][] = [
  ["configuring an mcp server", ["mcp-setup"]],
  ["setting up mcp", ["mcp-setup"]],
  ["mcp is not working", ["mcp-setup"]],
  ["loading skills into context", ["skill-loader"]],
  ["skill is not found", ["skill-loader"]],
  ["searching the documentation", ["doc-search"]],
  ["extracting chunks from a manual", ["doc-search"]],
  ["caching repeated requests", ["cache-layer"]],
  ["speeding up the broker", ["cache-layer"]],
  ["writing prompts", ["prompt-engine"]],
  ["prompt engineering for a model", ["prompt-engine"]],
  ["telegram channel posts", ["telegram-bot"]],
  ["refactoring code", ["refactor-tools"]],
  ["renaming symbols across files", ["refactor-tools"]],
  ["writing tests and fixtures", ["test-helper"]],
  ["debugging a failing test", ["test-helper"]],
]
const NEGATIVE = [
  "fix the typo in the README",
  "thanks, that works",
  "what is the capital of France",
  "check /home/someone/Projects/opencode-skill-enforcer",
]

let want = 0, hit = 0, clean = 0
const missed: string[] = []
const noise: string[] = []

console.log(`каталог: ${catalog.length} скиллов, дефолт: доля ${o.minRatio}, слов ≥ ${o.minWords}\n`)
for (const [prompt, expect] of GOLD) {
  const got = pickSkills(prompt, catalog, 5, o.minScore, o.minRatio, o.minWords)
  for (const e of expect) {
    want++
    if (got.includes(e)) hit++
    else missed.push(`${e} ← «${prompt}»`)
  }
  for (const g of got) if (!expect.includes(g)) noise.push(`${g} ← «${prompt}»`)
  if (got.length > 0 && got.every((g) => expect.includes(g))) clean++
  const mark = got.every((g) => expect.includes(g)) && got.length > 0 ? "✓" : got.some((g) => expect.includes(g)) ? "~" : "✗"
  console.log(`  ${mark} «${prompt.padEnd(34)}» ${got.join(", ") || "—"}`)
}

console.log(`\nrecall: ${Math.round((hit / want) * 100)}% (${hit}/${want})`)
console.log(`чистых промптов: ${clean}/${GOLD.length}`)
console.log(`лишних: ${noise.length}${noise.length ? " — " + noise.join(", ") : ""}`)
if (missed.length) console.log(`промахи: ${missed.join(", ")}`)

console.log("\nложные срабатывания:")
for (const p of NEGATIVE) {
  const got = pickSkills(p, catalog, 5, o.minScore, o.minRatio, o.minWords)
  console.log(`  ${got.length === 0 ? "✓" : "✗"} «${p.slice(0, 46).padEnd(46)}» ${got.join(", ") || "—"}`)
}

console.log("\nстемы:")
for (const p of ["configuring an mcp server", "настройка mcp сервера"]) {
  console.log(`  «${p}» → [${[...stemWords(p)].join(", ")}]`)
}