# opencode-skill-enforcer

Плагин для OpenCode V2: не даёт агенту игнорировать скиллы.

- **Каждый шаг модели** (`session.hook("context")`) в system добавляется короткое правило:
  сверься со скиллами, загрузи минимум N, а уже загруженные — соблюдай.
- **На входе сообщения** (`session.hook("prompt")`) подбирает скиллы по смыслу промпта
  и прикрепляет их к контексту, чтобы они реально попали в ход.
- **Считает** вызовы инструмента `skill` (`tool.hook("execute.before")`), поэтому правило
  знает, сколько уже загружено, и говорит «следуй загруженному».

## Установка

Добавить в глобальный `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": [
    { "package": "~/Projects/GithubPublic/opencode-skill-enforcer",
      "options": { "minSkills": 3, "maxSkills": 5, "autoAttach": true } }
  ]
}
```

Плагин подхватывается без перезапуска сервиса. Если по какой-то причине нет —
`opencode service restart`.

## Опции

| Опция | По умолчанию | Смысл |
| --- | --- | --- |
| `minSkills` | `3` | Минимум скиллов на один ход |
| `maxSkills` | `5` | Верхняя граница авто-подбора |
| `autoAttach` | `true` | Прикреплять подобранные скиллы к промпту |
| `padToMin` | `false` | Добивать подбор до `minSkills` даже без совпадений |
| `defaultSkills` | `[]` | ID для добивки, когда включён `padToMin` |
| `minPromptChars` | `12` | Не трогать короткие реплики |
| `minScore` | `3` | Порог совпадения: триггер весит 2, описание 1; ниже порога скилл не цепляется |
| `announce` | `false` | Писать события в stderr сервера |
| `logFile` | — | Писать события в файл (диагностика) |

`autoAttach` прикрепляет тела скиллов к контексту — это расход токенов. Хочешь только
напоминание без автоподбора — `"autoAttach": false`.

## Диагностика

События (`loaded`, `attached`, `injected rule`) пишутся либо в `options.logFile`,
либо в файл из переменной `SKILL_ENFORCER_DEBUG`:

```bash
SKILL_ENFORCER_DEBUG=/tmp/skill-enforcer.log opencode run -m <model> "тест"
tail -f /tmp/skill-enforcer.log
```

## Разработка

```bash
npm install
npx tsc --noEmit      # типы
bun build index.ts --target=bun --outfile=/tmp/se.js   # сборка
```
