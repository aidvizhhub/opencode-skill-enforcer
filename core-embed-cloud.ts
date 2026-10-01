/**
 * Эмбеддинги через OpenRouter — запасной слой отбора для скиллов и для блоков
 * справочников.
 *
 * Зачем: локальный multilingual-e5-small на длинных русских эссе не различает
 * смысл — контрольный замер на блоках AGENTS.md дал мусор 0.831 против 0.803 у
 * настоящего запроса. bge-m3 на том же наборе даёт зазор: мусор до 0.464,
 * реальные запросы от 0.496.
 *
 * Чем платим: сетью. Один короткий запрос — около 1.1 с и $0.0000002. Каталог
 * (42 скилла или 42 блока) кодируется один раз и лежит в кэше.
 *
 * Ключ берётся из OPENROUTER_API_KEY, а если его нет — из
 * ~/.config/skill-enforcer/openrouter.key (0600, кладёт scripts/setup-key.sh).
 * В конфиге плагина ключа быть не должно: он попадёт в бэкап конфига.
 *
 * Модуль обязан молчать при любой ошибке: нет сети, нет ключа, 429, таймаут —
 * возвращает null, и вызов продолжает работать на лексике.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

const CACHE = join(homedir(), ".cache", "skill-enforcer")
const KEY_FILE = join(homedir(), ".config", "skill-enforcer", "openrouter.key")
const ENDPOINT = "https://openrouter.ai/api/v1/embeddings"

/** Размер запроса в одном HTTP-вызове: всё равно платим за сеть, не мельчим. */
const BATCH = 16
/** Потолок ожидания: лучше молча откатиться на лексику, чем висеть на ходе. */
const TIMEOUT_MS = 15_000

/** Минимальный косинус, при котором блок или скилл считается релевантным. */
export const CLOUD_THRESHOLD = 0.49

export interface CloudOptions {
  /** Модель эмбеддинга; у всех провайдеров префиксы свои. */
  model?: string
  /** Имя набора в кэше: «skills» и «docs» считаются независимо. */
  ns?: string
  /** Порог косинуса; по умолчанию CLOUD_THRESHOLD. */
  threshold?: number
}

interface CloudIndex {
  hash: string
  ids: string[]
  vectors: number[][]
}

/** Версия правила кодирования входит в отпечаток: смена модели или префикса
 *  иначе молча оставила бы в кэше вектора, посчитанные по старым правилам. */
const ENCODE_VERSION = "openrouter-passage1"

function readKey(): string | null {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    if (existsSync(KEY_FILE)) {
      const key = readFileSync(KEY_FILE, "utf8").trim()
      if (key) return key
    }
  } catch {
    /* файл не прочитали — ключа нет */
  }
  return null
}

function indexPath(ns: string): string {
  return join(CACHE, `cloud-${ns}.json`)
}

function fingerprint(items: { id: string; text: string }[], model: string): string {
  return createHash("sha256")
    .update(`${ENCODE_VERSION}:${model}`)
    .update("\n")
    .update(items.map((s) => `${s.id}:${s.text}`).join("\n"))
    .digest("hex")
    .slice(0, 16)
}

function readIndex(ns: string): CloudIndex | null {
  try {
    return JSON.parse(readFileSync(indexPath(ns), "utf8")) as CloudIndex
  } catch {
    return null
  }
}

function writeIndex(ns: string, idx: CloudIndex): void {
  try {
    mkdirSync(CACHE, { recursive: true })
    writeFileSync(indexPath(ns), JSON.stringify(idx))
  } catch {
    /* кэш не записался — перекодируем в следующий раз */
  }
}

async function embedBatch(key: string, model: string, inputs: string[]): Promise<number[][] | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: inputs }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: { embedding: number[] }[] }
    const data = body.data
    if (!Array.isArray(data) || data.length !== inputs.length) return null
    return data.map((d) => d.embedding)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < len; i++) dot += a[i] * b[i]
  return dot
}

/** Вектора каталога: из кэша либо батчами по одному сетевому вызову на BATCH. */
async function catalogVectors(
  key: string,
  model: string,
  ns: string,
  items: { id: string; text: string }[],
): Promise<number[][] | null> {
  const hash = fingerprint(items, model)
  const cached = readIndex(ns)
  if (cached && cached.hash === hash && cached.ids.length === items.length) return cached.vectors

  const vectors: number[][] = []
  for (let at = 0; at < items.length; at += BATCH) {
    const slice = items.slice(at, at + BATCH)
    const got = await embedBatch(
      key,
      model,
      slice.map((s) => `passage: ${s.id}. ${s.text}`),
    )
    if (!got) return null
    vectors.push(...got)
  }
  writeIndex(ns, { hash, ids: items.map((s) => s.id), vectors })
  return vectors
}

/**
 * Что в наборе похоже на промпт по смыслу.
 * null — ключа нет, сеть недоступна или ответ не разобрался: вызов остаётся
 * на лексике, и это штатный режим, а не поломка.
 */
export async function cloudPick(
  prompt: string,
  items: { id: string; text: string }[],
  limit: number,
  options: CloudOptions = {},
): Promise<string[] | null> {
  if (items.length === 0) return null
  const key = readKey()
  if (!key) return null
  const model = options.model ?? "baai/bge-m3"
  const ns = options.ns ?? "skills"
  const threshold = options.threshold ?? CLOUD_THRESHOLD
  const catalog = await catalogVectors(key, model, ns, items)
  if (!catalog) return null
  const query = await embedBatch(key, model, [`query: ${prompt}`])
  if (!query) return null
  const scored = catalog.map((v, i) => ({ id: items[i].id, dot: cosine(v, query[0]) }))
  scored.sort((a, b) => b.dot - a.dot)
  return scored.filter((s) => s.dot >= threshold).slice(0, limit).map((s) => s.id)
}

/** Есть ли чем платить: без ключа и файла облачный слой молчит. */
export function cloudAvailable(): boolean {
  return readKey() !== null
}
