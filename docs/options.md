# Опции и установка

## Установка

Глобально, в `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "~/Projects/GithubPublic/opencode-skill-enforcer",
      "options": {
        "minSkills": 3,
        "maxSkills": 5,
        "attachAlways": true,
        "attachPicked": true,
        "documents": [
          { "path": "~/AGENTS.md", "title": "AGENTS", "maxBlocks": 3, "maxChars": 6000 }
        ],
        "docLlm": true
      }
    }
  ]
}
```

Плагин подхватывается без перезапуска сервиса. Если не подхватился — `opencode service restart`.

## Таблица

| Опция | По умолчанию | Смысл |
| --- | --- | --- |
| `minSkills` | `3` | Минимум рабочих скиллов на ход |
| `maxSkills` | `5` | Верхняя граница добора |
| `autoAttach` | `true` | Мастер-выключатель цепки; `false` — остаётся только правило |
| `attachAlways` | `true` | Цеплять базовый набор общения (`alwaysSkills`) |
| `attachPicked` | `true` | Цеплять добор по смыслу запроса |
| `skillLlm` | `false` | Если словесный добор недобрал до `minSkills`, спросить модель по списку скиллов |
| `alwaysSkills` | `[]` | База общения: скиллы, которые держим в контексте весь ход |
| `maxAttach` | `6` | Потолок на всё, что цепляется к одному промпту; `0` — без потолка |
| `minPromptChars` | `12` | Не трогать короткие реплики |
| `minScore` | `3` | Порог для скиллов: триггер весит 2, описание 1 |
| `documents` | `[]` | Файлы-справочники: строка-путь или объект `{path,title,maxBlocks,maxChars}` |
| `minDocScore` | `2` | Сколько разных слов промпта должно совпасть с абзацем |
| `maxDocBlocks` | `2` | Сколько попаданий из одного файла максимум |
| `docWindow` | `1` | На сколько соседних абзацев раздувать попадание |
| `maxDocChars` | `8000` | Потолок символов из одного файла за ход |
| `docLlm` | `false` | Семантический добор: если словесный поиск пуст, спросить модель |
| `docLlmMax` | `300` | Сколько абзацев показывать модели на выбор |
| `skillLlmMax` | `12` | Сколько скиллов показывать модели на выбор (только с совпадением слов) |
| `brokerHints` | — | Указания брокеру под свой набор скиллов |
| `cacheFile` | `$TMPDIR/opencode-skill-enforcer/broker-cache.json` | Файл кэша выбора брокера; `""` — кэш выключен |
| `cacheHours` | `72` | Сколько дней запись в кэше живёт |
| `logFile` | — | Писать события в файл (диагностика) |

### Кэш брокера

Повторяющийся запрос не спрашивает модель заново, а берёт прошлый выбор из файла.
Ключ — текст запроса без регистра, пунктуации и хвоста; в значении лежат выбранные
скиллы и **хэши текста** кусков справочников. Хэш, а не номер абзаца: при правке
`AGENTS.md` абзац сдвинется, а хэш останется, и кусок найдётся заново.

```text
/tmp/opencode-skill-enforcer/broker-cache.json
{"ygea4": {"skills": ["human-first-writing"], "docs": ["1ouqi5z", "4uqqlx"], "at": 1790795357308}}
```

В `/tmp` кэш живёт до перезагрузки, а `cacheHours` дополнительно чистит старое.
Пустой ответ модели не затирает прошлую удачную запись. При попадании в кэш в лог
падает строка `broker: cache hit [...]`, а `broker:` с миллисекундами означает
реальный вызов.

`documents` принимает и строку, и объект:

```jsonc
"documents": [
  "~/docs/handbook.md",
  { "path": "~/notes/big.md", "title": "Заметки", "maxBlocks": 2, "maxChars": 8000 }
]
```

`~/` разворачивается на рантайме, абсолютные пути работают как есть. Пустой список
выключает фичу.

## Диагностика

События (`loaded`, `attached`, `injected rule`, `doc`, `doc-inject`, `doc llm`)
пишутся в `logFile` или в файл из `SKILL_ENFORCER_DEBUG`:

```bash
SKILL_ENFORCER_DEBUG=/tmp/skill-enforcer.log opencode run -m <model> "тест"
tail -f /tmp/skill-enforcer.log
```
