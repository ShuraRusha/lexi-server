# lexi-server

Express-сервер-посредник между Telegram Mini App и OpenAI. Принимает текст, возвращает массив флэш-карточек через GPT-4o-mini.

## Стек
- Node.js ≥18, ES Modules (`"type": "module"`)
- Express 4, cors
- Деплой: Render.com (автодеплой при пуше в `main`)

## Запуск локально
```bash
npm install
OPENAI_API_KEY=sk-... npm start   # порт 3000
```

## API
| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/` | health-check |
| POST | `/api/parse` | разобрать текст в карточки |

POST `/api/parse` принимает `{ "text": "...", "targetLang": "ru" }`, возвращает `{ "cards": [...] }`.

Карточка: `{ w, lang, t, tr, pos, lvl, ex }`.

## Переменные окружения
| Имя | Описание |
|-----|----------|
| `OPENAI_API_KEY` | ключ OpenAI (задаётся в Render → Environment) |
| `PORT` | порт (Render выставляет автоматически) |

## GitHub Actions

| Workflow | Триггер | Что делает |
|----------|---------|------------|
| `ci.yml` | PR в `main` | `npm install`, syntax-check |
| `deploy.yml` | push в `main` | тригерит Render Deploy Hook |
| `release.yml` | тег `v*.*.*` | создаёт GitHub Release с changelog |

### Секреты GitHub (Settings → Secrets → Actions)
- `RENDER_DEPLOY_HOOK_URL` — Deploy Hook URL из Render Dashboard (Settings → Deploy Hook)

## Workflow для Claude Code
- Разработка: создать ветку → написать код → открыть PR
- Ревью PR: запустить `/review` в Claude Code
- Деплой: смёрджить PR в `main` → автодеплой на Render
- Релиз: `git tag v1.x.x && git push --tags` → GitHub Release создаётся автоматически
