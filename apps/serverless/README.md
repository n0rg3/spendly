# @spendly/serverless — API чеков на Vercel

Автономная бессерверная функция: сама ходит на `suf.purs.gov.rs`, парсит позиции чека
и категоризует их через Gemini. Локальный компьютер и ngrok не нужны — GitHub Pages
обращается к публичному HTTPS-адресу Vercel.

## Эндпоинт

```
POST https://<project>.vercel.app/api/receipts/parse
POST https://<project>.vercel.app/api/parse-receipt   (тот же handler, алиас из vercel.json)
```

Запрос:

```json
{ "qrUrl": "https://suf.purs.gov.rs/v/?vl=...", "categories": ["Продукты", "Кафе"] }
```

`categories` опциональны. Если не передать — используется список из ТЗ:
`["Продукты", "Кафе", "Дом", "Транспорт", "Развлечения", "Другое"]`.

Ответ `200`:

```json
{
  "dateTime": "16.9.2026. 17:50:44",
  "items": [{ "name": "VODA MINERALNA 0,5L", "qty": 1, "price": 57.99, "total": 57.99, "category": "Продукты" }],
  "total": 377.96
}
```

Ошибки: `{ "error": "..." }`

| Статус | Когда |
| --- | --- |
| `400` | нет `qrUrl` / некорректный или чужой URL (не `*.purs.gov.rs`) |
| `405` | метод не `POST` |
| `422` | страница получена, но структура чека не распознана |
| `502` | сайт чека недоступен / вернул ошибку |
| `500` | внутренняя ошибка |

Если Gemini-ключ не задан или вернул ошибку, статус остаётся `200`, а позиции приходят
с `category: null` — парсинг чека не ломается.

## Деплой

```bash
cd apps/serverless
npx vercel login
npx vercel --prod          # выдаст https://<project>.vercel.app
npx vercel env add GEMINI_API_KEY production   # вставить ключ из https://aistudio.google.com/apikey
npx vercel --prod          # передеплой, чтобы переменная подхватилась
```

Затем в `apps/mini-app/.env`:

```
VITE_API_URL=https://<project>.vercel.app
```

и пересборка мини-аппа (`pnpm --filter @sp3ndly/mini-app build`), после чего `dist` публикуется
на GitHub Pages. Всё — без ngrok и без запущенного локального сервера.

## Переменные окружения

| Переменная | Обязательна | Описание |
| --- | --- | --- |
| `GEMINI_API_KEY` | нет | Ключ Gemini. Без него позиции вернутся с `category: null`. |
| `GEMINI_MODEL` | нет | По умолчанию `gemini-3.6-flash` (модель `gemini-2.0-flash` снята с поддержки). Если заданная модель вернёт 404, функция автоматически повторит запрос на дефолтную. |
| `ALLOWED_ORIGINS` | нет | Доп. CORS-источники через запятую. |
| `GEMINI_BASE_URL` | нет | Только для тестов — подмена базового URL Gemini (стаб/прокси). |

## CORS

По умолчанию разрешены `https://n0rg3.github.io`, `http://localhost:5173`, `http://127.0.0.1:5173`.
Запросы без `Origin` (curl, Telegram-клиент) проходят. Источники из белого списка получают
`Access-Control-Allow-Origin` со своим значением; чужим доменам заголовок не отдаётся — браузер
блокирует запрос.

## Локальная проверка функции

```bash
cd apps/serverless
pnpm test               # автотесты на node:test (парсинг, CORS, SSRF, статусы) — без внешних зависимостей
pnpm check              # синтаксис функции
npx vercel dev          # http://localhost:3000/api/receipts/parse
```

Проверка защиты от SSRF (должно вернуть 400):

```bash
curl -s -X POST http://localhost:3000/api/receipts/parse \
  -H 'Content-Type: application/json' \
  -d '{"qrUrl":"https://evil.com/steal"}'
```

Тесты используют фикстуру `test/fixtures/receipt.html`; запрос к сайту чека подменяется моком,
реальная сеть не нужна.

## Безопасность

- URL чека валидируется: только `https:` и только домены `*.purs.gov.rs` (защита от SSRF).
- Таймаут запроса к сайту чека — 15 секунд.
- Ключ Gemini живёт только в env Vercel — в клиентский бандл не попадает.

## Примечание про парсинг

Страница чека отдаётся без отрендеренной таблицы (её рисует Knockout.js на клиенте), поэтому
основной путь — разбор текстового дампа в `<pre>` панели `#collapse3`: название товара может
быть на отдельной строке от чисел `<цена> <кол-во> <итог>`. Таблица `table.invoice-table`
используется как первый, быстрый путь. Логика 1:1 повторяет `apps/api/src/index.ts`.
