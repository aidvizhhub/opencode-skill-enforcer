/**
 * Стеммер под два языка. Русским нужен срез 5, английским 4: у русских форм
 * основы длинные (6+ букв), у английских короткие (test, parse, cache) и до
 * порога 6 не дотягивают, а срез 5 режет их не с той стороны.
 *
 *   bun run scripts/stem-check.ts
 */
const STOP_RU = new Set(["что", "как", "для", "это", "все", "есть", "если", "или", "уже", "чтобы"])
const STOP_EN = new Set([
  "the", "this", "that", "with", "from", "have", "make", "your", "what", "when",
  "they", "them", "then", "than", "there", "here", "some", "only", "also", "into",
])

function words(text: string): string[] {
  return text.toLowerCase().split(/[^0-9a-zа-яё]+/).filter(Boolean)
}

/** Сколько букв кириллицы в тексте — по этому решаем, какой порог резать. */
function cyrillicRatio(text: string): number {
  const all = words(text)
  if (all.length === 0) return 0
  return all.filter((w) => /[а-яё]/.test(w)).length / all.length
}

function makeStem(cut: number, stop: Set<string>, minLen: number) {
  return (w: string): string | undefined => {
    const latinShort = /^[a-z0-9]{3}$/.test(w)
    if ((w.length < minLen && !latinShort) || stop.has(w)) return undefined
    return w.length >= cut ? w.slice(0, cut) : w
  }
}

/** Стеммер с автоопределением языка: русский → cut 5, латиница → cut 4. */
function autoStem(text: string): Set<string> {
  const cut = cyrillicRatio(text) > 0.3 ? 5 : 4
  const stop = cut === 5 ? STOP_RU : STOP_EN
  const stem = makeStem(cut, stop, 4)
  const out = new Set<string>()
  for (const w of words(text)) {
    const s = stem(w)
    if (s) out.add(s)
  }
  return out
}

const RU: [string, string][] = [
  ["сабагент", "сабагентов"], ["ресёрч", "ресёрча"], ["подключение", "подключить"],
  ["исследование", "исследовать"], ["настройка", "настроить"], ["подготовка", "подготовить"],
  ["сохранение", "сохранить"], ["документ", "документация"], ["конфигурация", "конфигурации"],
  ["приложение", "приложения"], ["переменная", "переменные"], ["функция", "функции"],
  ["значение", "значения"], ["сравнение", "сравнить"], ["запрос", "запросы"],
  ["проверка", "проверить"], ["настройки", "настроек"], ["разбор", "разбора"],
  ["загрузка", "загрузить"],
]
const EN: [string, string][] = [
  ["cache", "caching"], ["cache", "cached"], ["plugin", "plugins"], ["plugin", "plugged"],
  ["document", "documents"], ["document", "documenting"], ["config", "configure"],
  ["config", "configuration"], ["index", "indexes"], ["index", "indexing"],
  ["skill", "skills"], ["test", "tests"], ["test", "testing"], ["prompt", "prompts"],
  ["prompt", "prompting"], ["parse", "parsing"], ["parse", "parser"], ["parse", "parsed"],
  ["build", "building"], ["build", "builder"], ["render", "rendering"], ["render", "renderer"],
  ["validate", "validation"], ["export", "exports"], ["session", "sessions"],
  ["attach", "attached"], ["extract", "extracted"], ["match", "matches"],
  ["chunk", "chunks"], ["hash", "hashing"], ["inject", "injection"], ["inject", "injected"],
]
const EN_DISTINCT: [string, string][] = [
  ["test", "testify"], ["cache", "cachet"], ["index", "indent"],
  ["prompt", "promotion"], ["validate", "validity"], ["extract", "extracts"],
]

let ruOk = 0, enOk = 0
const fp: string[] = []
for (const [a, b] of RU) {
  const sa = autoStem(a), sb = autoStem(b)
  if ([...sa][0] === [...sb][0]) ruOk++
}
for (const [a, b] of EN) {
  const sa = autoStem(a), sb = autoStem(b)
  if ([...sa][0] === [...sb][0]) enOk++
}
for (const [a, b] of EN_DISTINCT) {
  if ([...autoStem(a)][0] === [...autoStem(b)][0]) fp.push(`${a}/${b}`)
}

console.log(`пар: русский ${RU.length}, английский ${EN.length}\n`)
console.log(`автоопределение языка (кириллица > 30% → срез 5, иначе 4):`)
console.log(`  русский:  ${ruOk}/${RU.length} (${Math.round((ruOk / RU.length) * 100)}%)`)
console.log(`  английский: ${enOk}/${EN.length} (${Math.round((enOk / EN.length) * 100)}%)`)
console.log(`  ложных склеек: ${fp.length} ${fp.length ? "— " + fp.join(", ") : ""}`)

console.log("\n── как выбирается язык ──")
for (const t of [
  "проверь код на адекватность",
  "check the code for sanity",
  "проверь код — check the code",
  "session hook",
  "сессия и hook",
  "",
]) {
  console.log(`  «${t.padEnd(34)}» кириллица ${(cyrillicRatio(t) * 100).toFixed(0)}% → срез ${cyrillicRatio(t) > 0.3 ? 5 : 4}`)
}

console.log("\n── где автоопределение ломается ──")
console.log("  чисто латинский текст с русскими падежами (транслит) — срезается как английский")
console.log("  смешанный документ — порог берётся по большинству, меньшинство получает чужой порог")
console.log("  короткий запрос («ок», «ok») — слов мало, доля нестабильна, но и стемить нечего")
console.log("\n── что автоопределение чинит относительно текущего ──")
console.log("текущий плагин: единый срез 5 для обоих языков")
const cur = makeStem(5, STOP_EN, 4)
let curEn = 0
for (const [a, b] of EN) if ([...new Set([cur(a)])][0] === [...new Set([cur(b)])][0]) curEn++
console.log(`  английский на срезе 5: ${curEn}/${EN.length}, на срезе 4: ${Math.round((enOk / EN.length) * 100)}%`)
