#!/usr/bin/env bash
# Ключ OpenRouter для облачного эмбеддинга.
#
# Ключ не должен появляться в argv (он виден в ps), в истории команд, в конфиге
# плагина или в бэкапе этого конфига. Поэтому ввод скрытый, результат лежит в
# отдельном файле с правами 0600, а плагин читает его сам.
#
#   ./scripts/setup-key.sh          — спросит и запишет
#   ./scripts/setup-key.sh --check  — только проверить текущий
set -euo pipefail

DIR="${XDG_CONFIG_HOME:-$HOME/.config}/skill-enforcer"
KEY_FILE="$DIR/openrouter.key"
MODEL="${SKILL_ENFORCER_EMBED_MODEL:-baai/bge-m3}"

ping() {
  local key="$1"
  # curl ловит EPIPE, когда head закрывает пайп после первых 400 байт, — при
  # pipefail это выглядит как падение проверки. Поэтому EPIPE терпим, а всё
  # остальное нет: 401, 429, обрыв сети должны валить скрипт.
  curl -sS --max-time 20 https://openrouter.ai/api/v1/embeddings \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL\",\"input\":[\"ping\"]}" \
    2>&1 | head -c 400 || [[ $? -eq 23 ]]
}

if [[ "${1:-}" == "--check" ]]; then
  if [[ ! -r "$KEY_FILE" ]]; then
    echo "ключа нет: $KEY_FILE" >&2
    exit 1
  fi
  out="$(ping "$(cat "$KEY_FILE")")"
  if [[ "$out" == *'"embedding"'* ]]; then
    echo "ключ рабочий, модель $MODEL отвечает"
  else
    echo "ключ не прошёл проверку: $out" >&2
    exit 1
  fi
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "нужен curl" >&2
  exit 1
fi

echo "Ключ OpenRouter ($MODEL). Вставь значение и нажми Enter."
echo "Символы не показываются. Если ключ утекал в чат или лог — сначала ротируй на"
echo "https://openrouter.ai/settings/keys, потом сюда."
read -rs key
echo
[[ -n "$key" ]] || { echo "пусто, не пишу" >&2; exit 1; }

echo "Проверяю живым запросом..."
out="$(ping "$key")"
if [[ "$out" != *'"embedding"'* ]]; then
  echo "не прошёл: $out" >&2
  exit 1
fi

umask 077
mkdir -p "$DIR"
printf '%s' "$key" > "$KEY_FILE"
chmod 600 "$KEY_FILE"
echo "записал $KEY_FILE (600), модель $MODEL отвечает"
