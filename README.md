# Lexi AI Server

Маленький сервер-посредник между Telegram Mini App и OpenAI.
Он принимает текст, просит GPT-4o-mini разобрать его в карточки и
возвращает результат приложению. Секретный ключ хранится в настройках
хостинга, а НЕ в коде.

## Что внутри
- `server.js` — сам сервер (Express)
- `package.json` — список зависимостей
- этот README

## Как развернуть на Render.com (без терминала)
1. Залей эту папку в репозиторий на GitHub.
2. На render.com → New → Web Service → подключи репозиторий.
3. Настройки:
   - Build Command:  `npm install`
   - Start Command:  `npm start`
4. В разделе Environment добавь переменную:
   - Key:   `OPENAI_API_KEY`
   - Value: твой ключ с platform.openai.com (начинается с `sk-...`)
5. Деплой. Render выдаст адрес вида `https://lexi-server-xxxx.onrender.com`
6. Открой этот адрес в браузере — должно написать «Lexi AI server is running ✓».

## Проверка
POST на `/api/parse` с телом `{ "text": "любой текст" }`
вернёт `{ "cards": [ ... ] }`.

## Стоимость
Модель gpt-4o-mini очень дешёвая: один разбор текста ≈ доли цента.
$5 на балансе OpenAI хватает на тысячи обработок.

