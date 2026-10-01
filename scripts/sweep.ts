/**
 * Свип по параметрам: показывает всю поверхность размена сразу, а не одну точку.
 * Отвечает не «правильно ли я попал», а «где начинается окупаемость».
 *
 *   bun run scripts/sweep.ts [путь-к-каталогу-скиллов]
 */
import { readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { referenceOf, pickSkills, stemWords, selectBlocks, splitDoc, type SkillRef } from "../core.ts"

const skillDir = process.argv[2] ?? join(homedir(), ".config/opencode/skills")
const catalog: SkillRef[] = []
for (const name of readdirSync(skillDir)) {
  let head = ""
  try {
    head = readFileSync(join(skillDir, name, "SKILL.md"), "utf8").slice(0, 4000)
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

let agents: ReturnType<typeof splitDoc> = []
try {
  agents = splitDoc(readFileSync(join(homedir(), "AGENTS.md"), "utf8"))
} catch {
  /* AGENTS.md нет — меряем только скиллы */
}

/** Промпты без разметки: нужно ли вообще что-то цеплять. */
const PROMPTS = [
  "расскажи про сабагентов",
  "подключи mcp",
  "объясни простыми словами",
  "запиши в память",
  "итог сессии",
  "перепиши без нейрослопа",
  "не согласен с этим",
  "живой разговор, как тебе",
  "сформулируй ответ кратко",
  "telegram бот на telethon",
  "проверь на адекватность ~/Projects/opencode-skill-enforcer",
  "заряди карту телефона",
  "ok",
  "а если по-другому?",
]

/** Базовая линия: сколько скиллов цепляется без всяких порогов. */
function baseline(prompt: string): string[] {
  const pw = stemWords(prompt)
  if (pw.size === 0) return []
  return catalog
    .filter((s) => {
      let n = 0
      for (const w of s.trigger) if (pw.has(w)) n++
      for (const w of s.body) if (pw.has(w)) n++
      return n >= 2
    })
    .map((s) => s.id)
}

const b = PROMPTS.map(baseline)
const bAvg = b.reduce((n, x) => n + x.length, 0) / b.length
const bEmpty = b.filter((x) => x.length === 0).length
console.log(`каталог: ${catalog.length} скиллов, документов: ${agents.length} блоков`)
console.log(`\nБАЗА (minWords=2, без IDF, без пола): ${bAvg.toFixed(1)} скиллов/ход, пустых ${bEmpty}/${PROMPTS.length}\n`)

const pad = (s: string | number, n: number) => String(s).padStart(n)
console.log("пол  доля  слов | среднее  пустых  документ(среднее блоков, символов)")
console.log("─".repeat(88))
for (const minScore of [0, 2, 4, 6, 8]) {
  for (const minRatio of [0, 0.5, 0.6, 0.7, 0.8]) {
    for (const minWords of [2, 3]) {
      const got = PROMPTS.map((p) => pickSkills(p, catalog, 8, minScore, minRatio, minWords))
      const avg = got.reduce((n, x) => n + x.length, 0) / got.length
      const empty = got.filter((x) => x.length === 0).length
      const docs = PROMPTS.map((p) => selectBlocks(p, agents, 3, 3, 1))
      void agents.length
      const dAvg = docs.reduce((n, x) => n + x.length, 0) / docs.length
      const dChars = docs.reduce((n, x) => n + x.reduce((m, y) => m + y.text.length, 0), 0) / docs.length
      const delta = avg - bAvg
      console.log(
        `${pad(minScore, 3)}  ${pad(minRatio, 4)}  ${pad(minWords, 4)} |  ${avg.toFixed(2).padStart(5)}  ${pad(empty, 6)}   ${dAvg.toFixed(2).padStart(5)}, ${Math.round(dChars).toString().padStart(5)}   ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} к базе`,
      )
    }
  }
}
console.log("\n«среднее» — сколько скиллов цепляется за ход")
console.log("«пустых» — ходов, где не цеплено ничего (значит нужен брокер)")
console.log("«к базе» — насколько мы отличаемся от тупого совпадения слов")