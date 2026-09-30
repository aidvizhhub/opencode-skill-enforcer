# opencode-skill-enforcer

Плагин для OpenCode V2: держит скиллы и файлы-справочники в контексте, заставляет агента
ими пользоваться и напоминает следовать тому, что уже загружено.

- правило-напоминание в system на каждом шаге модели;
- цепка базового набора общения и скиллов по смыслу;
- куски из файлов-справочников по запросу (с семантическим добором);
- счётчик реальных загрузок скиллов.

## Быстрый старт

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    {
      "package": "~/Projects/GithubPublic/opencode-skill-enforcer",
      "options": { "minSkills": 3, "maxSkills": 5, "attachAlways": true, "attachPicked": true, "skillLlm": true }
    }
  ]
}
```

Подхватывается без перезапуска. Если не подхватился — `opencode service restart`.

## Документация

- [docs/overview.md](docs/overview.md) — что это, механизмы, что включено по умолчанию, режимы.
- [docs/options.md](docs/options.md) — установка, полная таблица опций, диагностика.
- [docs/internals.md](docs/internals.md) — устройство: нарезка, поиск, состояние.

## Разработка

```bash
npm install
npx tsc --noEmit
```
