/**
 * Эмбеддинги как второй слой отбора.
 *
 * Зачем: лексика на реальных репликах молчит на 59% — там нет общих слов со
 * скиллом. «Стоит ли удалять legacy-модуль» не пересекается с описанием
 * `truth-first-pruning` ни одним словом, но по смыслу это ровно он.
 *
 * Как устроено: multilingual-e5-small в кванте int8 через onnxruntime.
 * Модель занимает 130 МБ, кэшируется в ~/.cache/skill-enforcer/ и кодируется
 * один раз. Вектора скиллов лежат рядом в index.json и инвалидируются по
 * отпечатку описаний — пока описания не менялись, модель грузится только ради
 * вектора запроса.
 *
 * Чего модуль НЕ делает: не заменяет лексику. В замере на 44 промптах
 * эмбеддинг как основной ранкер дал 6 чистых ответов из 44 — мусор. Гибрид
 * дал 21 против 19 у одной лексики, recall 77% против 62%.
 *
 * Модуль обязан молчать при любой ошибке: нет сети, нет места, нет модели —
 * возвращает null, и вызов продолжает работать на лексике как раньше.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

const CACHE = join(homedir(), ".cache", "skill-enforcer")
const MODEL_ID = "Xenova/multilingual-e5-small"

/** Минимальный косинус, при котором скилл считается релевантным. */
const THRESHOLD = 0.83

/**
 * Внешняя библиотека отдаёт loose-типы; обёртка их сужает один раз здесь,
 * а не в каждом месте вызова.
 */
interface Encoder {
  encode: (texts: string[]) => Promise<Float32Array[]>
}

let encoder: Encoder | null = null
let loading: Promise<Encoder | null> | null = null

/** mean pooling по маске + нормализация: e5 сравнивают косинусом. */
function pool(hidden: { data: Float32Array | Int8Array; dims: number[] }, mask: Float32Array | Int8Array, count: number): Float32Array[] {
  const seq = hidden.dims[1] as number
  const dim = hidden.dims[2] as number
  const data = hidden.data as unknown as number[]
  const m = mask as unknown as number[]
  const out: Float32Array[] = []
  for (let i = 0; i < count; i++) {
    const acc = new Float32Array(dim)
    for (let s = 0; s < seq; s++) {
      if (m[i * seq + s] === 0) continue
      for (let d = 0; d < dim; d++) acc[d] += data[i * seq * dim + s * dim + d]
    }
    let norm = 0
    for (let d = 0; d < dim; d++) norm += acc[d] ** 2
    norm = Math.sqrt(norm) || 1
    for (let d = 0; d < dim; d++) acc[d] /= norm
    out.push(acc)
  }
  return out
}

async function getEncoder(): Promise<Encoder | null> {
  if (encoder) return encoder
  if (loading) return loading
  loading = (async () => {
    try {
      const tf = (await import("@huggingface/transformers")) as unknown as Record<string, unknown>
      const lib = (tf as any).default ?? tf
      lib.env.cacheDir = join(CACHE, "model")
      lib.env.allowLocalModels = false
      const tok = await lib.AutoTokenizer.from_pretrained(MODEL_ID, { quantized: true })
      const model = await lib.AutoModel.from_pretrained(MODEL_ID, { dtype: "q8" })
      encoder = {
        encode: async (texts) => {
          const enc = await tok(texts)
          const out = await model({
            input_ids: enc.input_ids,
            attention_mask: enc.attention_mask,
          })
          const hidden = out.last_hidden_state ?? Object.values(out)[0]
          const count = texts.length
          return pool(hidden, enc.attention_mask.data, count)
        },
      }
      return encoder
    } catch {
      return null
    } finally {
      loading = null
    }
  })()
  return loading
}

/** Отпечаток каталога: меняется, когда изменилось любое описание. */
function fingerprint(skills: { id: string; text: string }[]): string {
  return createHash("sha256")
    .update(skills.map((s) => `${s.id}:${s.text}`).join("\n"))
    .digest("hex")
    .slice(0, 16)
}

interface Index {
  hash: string
  ids: string[]
  vectors: number[][]
}

function readIndex(): Index | null {
  try {
    const parsed = JSON.parse(readFileSync(join(CACHE, "index.json"), "utf8")) as Index
    if (!parsed.hash || !Array.isArray(parsed.vectors)) return null
    return parsed
  } catch {
    return null
  }
}

function writeIndex(idx: Index): void {
  try {
    mkdirSync(CACHE, { recursive: true })
    writeFileSync(join(CACHE, "index.json"), JSON.stringify(idx))
  } catch {
    /* кэш не записался — пересчитаем в следующий раз */
  }
}

/** Вектора каталога: из кэша либо одним проходом по всем описаниям. */
async function catalogVectors(
  skills: { id: string; text: string }[],
): Promise<{ ids: string[]; vectors: Float32Array[] } | null> {
  const hash = fingerprint(skills)
  const cached = readIndex()
  if (cached && cached.hash === hash && cached.ids.length === skills.length) {
    return { ids: cached.ids, vectors: cached.vectors.map((v) => Float32Array.from(v)) }
  }
  const enc = await getEncoder()
  if (!enc) return null
  try {
    // по одному: батчи требуют аккуратной сборки масок, а каталог считается один раз
    const vectors: Float32Array[] = []
    for (const s of skills) {
      const [v] = await enc.encode([`${s.id}. ${s.text}`])
      vectors.push(v)
    }
    writeIndex({ hash, ids: skills.map((s) => s.id), vectors: vectors.map((v) => Array.from(v)) })
    return { ids: skills.map((s) => s.id), vectors }
  } catch {
    return null
  }
}

/**
 * Второй слой отбора: какие скиллы похожи на промпт по смыслу.
 * null означает «эмбеддинг недоступен» — вызов остаётся на лексике.
 */
export async function embedPick(
  prompt: string,
  skills: { id: string; text: string }[],
  limit = 5,
): Promise<string[] | null> {
  if (skills.length === 0) return null
  try {
    mkdirSync(CACHE, { recursive: true })
  } catch {
    return null
  }
  const catalog = await catalogVectors(skills)
  if (!catalog) return null
  const enc = await getEncoder()
  if (!enc) return null
  let query: Float32Array
  try {
    ;[query] = await enc.encode([`query: ${prompt}`])
  } catch {
    return null
  }
  const scored = catalog.vectors.map((v, i) => {
    let dot = 0
    const len = Math.min(v.length, query.length)
    for (let d = 0; d < len; d++) dot += v[d] * query[d]
    return { id: catalog.ids[i], dot }
  })
  scored.sort((a, b) => b.dot - a.dot)
  return scored.filter((s) => s.dot >= THRESHOLD).slice(0, limit).map((s) => s.id)
}

/** Порог косинуса — для диагностики и стендов. */
export function embedThreshold(): number {
  return THRESHOLD
}

/** Есть ли уже скачанная модель: плагин не должен ронять старт из-за сети. */
export function embedCached(): boolean {
  return existsSync(join(CACHE, "model"))
}