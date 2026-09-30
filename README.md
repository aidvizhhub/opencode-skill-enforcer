# opencode-skill-enforcer

Плагин для [OpenCode](https://opencode.ai) V2: держит скиллы и файлы-справочники
в контексте агента и не даёт ему работать без них.

```
промпт → плагин цепляет скиллы и абзацы справочника → агент получает инструкцию
         «сначала загрузи эти скиллы» и инструментом skill() грузит их
```

> In English: an OpenCode plugin that attaches relevant skills and documentation
> chunks to every user prompt, then tells the agent to actually load them.

## Что он делает

- **Правило-напоминание** в system-сообщении на каждом шаге: какие скиллы сейчас
  загружены и сколько ещё нужно. Работает всегда, пока плагин включён.
- **Автоподбор скиллов** по смыслу промпта: триггеры весят 2, описание 1.
- **Семантический добор** — если словесный подбор недобрал, плагин один раз
  спрашивает модель, какие скиллы и абзацы действительно нужны.
- **Справочники** (`documents`): файл режется на абзацы, релевантные куски
  уезжают в контекст. Поддерживает `~`, абзац приводится к виду со списками.
- **Дедупликация**: то, что уже было в контексте, повторно не приклеивается —
  ни в рамках сессии, ни после сжатия контекста (смотрит историю сообщений).

## Установка

Ставится из git, публикации в npm пока нет:

```bash
git clone https://github.com/aidvizhhub/opencode-skill-enforcer
cd opencode-skill-enforcer && npm install
```

Дальше — в `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "~/Projects/GithubPublic/opencode-skill-enforcer",
      "options": {
        "minSkills": 3,
        "maxSkills": 5,
        "alwaysSkills": ["result-first", "dialog-humanity", "anti-ai-sludge"],
        "skillLlm": true,
        "documents": [
          { "path": "~/AGENTS.md", "title": "AGENTS", "maxBlocks": 3, "maxChars": 6000 }
        ],
        "docLlm": true
      }
    }
  ]
}
```

`alwaysSkills` — ваш базовый набор общения; имена скиллов у всех свои, поэтому
дефолт пустой. Указания брокеру про ваш набор — в опции `brokerHints`.

Плагин подхватывается без перезапуска. Если не подхватился — `opencode service restart`.

## Документация

| Файл | Про что |
|---|---|
| [docs/overview.md](docs/overview.md) | механизмы, режимы, что включено по умолчанию |
| [docs/options.md](docs/options.md) | установка, полная таблица опций, диагностика |
| [docs/internals.md](docs/internals.md) | нарезка документов, поиск, состояние |

## Разработка

```bash
npm install
npx tsc --noEmit
```

## Лицензия

MIT — см. [LICENSE](LICENSE).
