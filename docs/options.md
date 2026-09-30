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
| `alwaysSkills` | `["result-first","dialog-humanity","anti-ai-sludge"]` | База общения |
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
| `logFile` | — | Писать события в файл (диагностика) |

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
