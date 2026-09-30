# opencode-skill-enforcer

Плагин для OpenCode V2: не даёт агенту игнорировать скиллы.

- **Каждый шаг модели** правило висит в system: сверься со скиллами, загрузи минимум N,
  уже загруженные — соблюдай.
- **На входе сообщения** подбирает скиллы по смыслу промпта и прикрепляет их к контексту.
- **Считает** реальные вызовы инструмента `skill`, чтобы правило знало, сколько уже загружено.

## Установка

Глобально (действует во всех проектах) — папкой в каталоге плагинов OpenCode:

```bash
ln -s ~/Projects/opencode-skill-enforcer ~/.config/opencode/plugins/skill-enforcer
```

Или явно в `opencode.json(c)`:

```jsonc
{
  "plugins": [
    { "package": "~/Projects/GithubPublic/opencode-skill-enforcer", "options": { "minSkills": 3 } }
  ]
}
```

## Опции

| Опция | По умолчанию | Смысл |
| --- | --- | --- |
| `minSkills` | `3` | Минимум скиллов на один ход |
| `maxSkills` | `5` | Верхняя граница авто-подбора |
| `autoAttach` | `true` | Прикреплять подобранные скиллы к промпту |
| `padToMin` | `false` | Добивать подбор до `minSkills` даже без совпадений |
| `defaultSkills` | `[]` | ID для добивки, когда включён `padToMin` |
| `minPromptChars` | `12` | Не трогать короткие реплики |
| `announce` | `false` | Писать в лог, что правило вставлено |

## Проверка

Плагин пишет метки `[skill-enforcer]` в лог сервера:

```bash
grep skill-enforcer ~/.local/share/opencode/log/opencode.log | tail
```

Метки появляются только при `announce: true`.
