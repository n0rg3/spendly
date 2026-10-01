// ===== Vercel Serverless: распознавание сербских чеков (suf.purs.gov.rs) целиком через Gemini =====
// Деплой: vercel из этой папки (apps/serverless). Эндпоинт: POST /api/receipts/parse
// (алиас на /api/parse-receipt через vercel.json rewrites).
//
// Весь разбор чека и автокатегоризация выполняются ОДНИМ вызовом LLM
// (Gemini 2.5 Flash, Structured Outputs / responseSchema). Функция лишь скачивает
// страницу чека и отдаёт модели её сырой текст: ни регулярных выражений для позиций,
// ни словарей-фолбэков, ни кэшей «товар -> категория» больше нет.
//
// Env: GEMINI_API_KEY (обязателен — без него распознавание недоступно),
//      GEMINI_MODEL (по умолчанию gemini-3.8-flash),
//      ALLOWED_ORIGINS (опционально, через запятую — дополнительные CORS-источники).
import * as cheerio from "cheerio";
import { GoogleGenerativeAI } from "@google/generative-ai";

const RECEIPT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// СТАРТОВЫЕ категории Mini App по языкам — ровно те же названия, что создаёт клиент
// в defaultDashboard (apps/mini-app/src/main.tsx). Это только fallback: обычно клиент
// присылает свои категории. Список обязан совпадать с клиентским, иначе названия из ответа
// модели не сматчатся с категориями пользователя и позиции приедут без категорий.
const DEFAULT_CATEGORIES_BY_LANG = {
  ru: ["Еда", "Транспорт", "Покупки"],
  en: ["Food", "Transport", "Shopping"],
  sr: ["Hrana", "Prevoz", "Kupovina"],
};
const DEFAULT_CATEGORIES = DEFAULT_CATEGORIES_BY_LANG.ru;
const defaultCategoriesForLang = (lang) =>
  DEFAULT_CATEGORIES_BY_LANG[String(lang ?? "").trim().toLowerCase()] ?? DEFAULT_CATEGORIES;

// Модель по умолчанию. Важно: Google снимает модели с продажи, и вызов старой отдаёт
// 404 "no longer available to new users" — распознавание падает целиком (502).
// gemini-3.8-flash — модель, которую сам API указывает как актуальную замену 2.5-flash;
// поддерживает Structured Outputs (responseSchema). Переопределяется GEMINI_MODEL.
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

// Страница чека может быть большой; модели достаточно текста покупки
const MAX_RECEIPT_TEXT_LENGTH = 20_000;

// Таймауты подобраны под maxDuration функции на Vercel (60 с). Бюджет в худшем случае:
// страница чека 10 с × 2 попытки ≈ 21 с + Gemini 10 с × 3 модели ≈ 30 с + паузы при 429
// (2 с + 4 с) ≈ 6 с = ~57 с.
// Три попытки Gemini — это три РАЗНЫЕ модели (см. FALLBACK_GEMINI_MODELS): повтор той же
// перегруженной модели бесполезен, а снятую с продажи модель повтор тоже не спасёт.
const RECEIPT_FETCH_TIMEOUT_MS = 10_000;
const GEMINI_TIMEOUT_MS = 10_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 2; // скачивание страницы чека
const GEMINI_MAX_ATTEMPTS = 3; // основная модель + две резервные
// Пауза между попытками; в тестах выключается через RECEIPT_RETRY_DELAY_MS=0
const retryDelayMs = () => {
  const value = Number(process.env.RECEIPT_RETRY_DELAY_MS);
  return Number.isFinite(value) && value >= 0 ? value : 500;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ===== Лимит запросов Gemini (Free Tier, 5 RPM) =====
// 429 — самый частый сбой, когда чек сканируют несколько раз подряд. Повторять его нужно
// на ТОЙ ЖЕ модели с растущей паузой (2 с, затем 4 с): квота считается на ключ, поэтому
// переключение на другую модель не помогает — оно только быстрее сожжёт остаток лимита.
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BASE_DELAY_MS = 2_000;
// Пауза перед повтором после 429 (в тестах выключается через RECEIPT_RETRY_DELAY_MS=0)
const rateLimitDelayMs = (baseMs) => {
  const value = Number(process.env.RECEIPT_RETRY_DELAY_MS);
  return Number.isFinite(value) && value >= 0 ? value : baseMs;
};

// Резервные модели. Нужны по двум причинам: Google выводит модели из продажи
// (404 «no longer available») и периодически отдаёт 503 «high demand». Второй вызов
// уходит на другую модель — это лечит обе причины, тогда как повтор той же перегруженной
// модели бесполезен. Две попытки по 15 с = 30 с: вместе со скачиванием чека (12 с + повтор)
// это влезает в maxDuration: 60.
const FALLBACK_GEMINI_MODELS = ["gemini-3.7-flash", "gemini-3.6-flash"];
const geminiModelForAttempt = (attempt) => {
  const primary = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const chain = [primary, ...FALLBACK_GEMINI_MODELS].filter(
    (name, index, all) => name && all.indexOf(name) === index,
  );
  return chain[Math.min(Math.max(attempt, 1) - 1, chain.length - 1)];
};

// Название категории в сравнимом виде: регистр, пробелы (в т.ч. неразрывные) и Unicode-форма
// не должны мешать сопоставлению «категория от модели -> категория пользователя»
function normalizeCategoryName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u00a0\u2007\u2009\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Повтор для транзиентных сбоев (сеть, таймаут, 429/5xx). run получает номер попытки
// (1, 2, 3) — так повтор Gemini уходит на следующую по цепочке модель.
async function withRetry(run, shouldRetry, { attempts = MAX_ATTEMPTS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) throw error;
      console.warn(`receipt: попытка ${attempt} не удалась (${error?.message ?? error}) — повтор`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs()));
    }
  }
  throw lastError;
}

// Статус ошибки. SDK Gemini не всегда отдаёт его числом, но он есть в тексте вида
// "[404 Not Found]" — без этого разбора снятая модель выглядит как «повтор вообще не поможет».
const errorStatus = (error) => {
  const status = error?.status ?? error?.response?.status ?? error?.response?.error?.code;
  if (typeof status === "number") return status;
  const match = /\b(\d{3})\b/.exec(String(error?.message ?? ""));
  if (!match) return null;
  const code = Number(match[1]);
  return code >= 400 && code < 600 ? code : null;
};

// Транзиентная ошибка: сеть/таймаут/5xx/429 — то, что имеет смысл повторить.
// Ошибки схемы/конфигурации (400/403/404) повторять бессмысленно.
const isTransient = (error) => {
  const code = errorStatus(error);
  return code === null || RETRYABLE_STATUS.has(code);
};

// 400/401/403/404 от Gemini — не «сбой, попробуй позже», а сломанные настройки:
// снятую с продажи модель Google отдаёт 404 («no longer available to new users»),
// невалидный ключ — 401/403. Если и резервные модели недоступны, повтор не поможет,
// поэтому статус отдельный (503) и в сообщение попадает подсказка, что проверять.
const CONFIG_ERROR_STATUS = new Set([400, 401, 403, 404]);
const isConfigError = (error) => {
  const code = errorStatus(error);
  return code !== null && CONFIG_ERROR_STATUS.has(code);
};

// 400/401/403 — неисправимо сразу (схема/ключ): ни повтор, ни смена модели не помогут.
// 404 сюда НЕ входит: это снятая с продажи модель, и резервная модель как раз спасёт.
const HARD_CONFIG_STATUS = new Set([400, 401, 403]);
const isHardConfigError = (error) => {
  const code = errorStatus(error);
  return code !== null && HARD_CONFIG_STATUS.has(code);
};

// Имеет смысл уйти на резервную модель: 404 (модель вывели из продажи) и транзиентные
// сбои — 503 «high demand», 5xx, таймаут. 429 сюда НЕ входит: квота на ключ, а не на модель
const worthAnotherModel = (error) => errorStatus(error) === 404 || isTransient(error);

// 429 — исчерпан лимит запросов к Gemini. Это НЕ «попробуй другую модель»: квота
// считается на ключ, поэтому повтор делаем на той же модели, но позже (см. backoff ниже).
const isRateLimited = (error) => errorStatus(error) === 429;

// 429/503 «high demand» — все модели заняты. Пользователю честнее сказать «перегружено,
// попробуйте через минуту», чем «сервис вернул ошибку»: повтор сканом не поможет.
const isCapacityError = (error) => errorStatus(error) === 429 || errorStatus(error) === 503;

// Скачивание страницы чека с повтором на транзиентных ошибках
async function fetchReceiptPage(url) {
  return withRetry(
    async () => {
      const response = await fetch(url, {
        headers: { "User-Agent": RECEIPT_USER_AGENT },
        signal: AbortSignal.timeout(RECEIPT_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        const error = new Error(`Сайт чека вернул ошибку: HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return response;
    },
    isTransient,
  );
}

// Дата/время чека — это «стена часов» с принта: 17:50 на чеке должно остаться 17:50.
// Модель часто дописывает «Z» или «+02:00», и тогда получатель считает 17:50 временем UTC
// и прибавляет свой локальный пояс (UTC+2) — выходит 19:50. Поэтому любой часовой пояс
// отбрасывается, а проверяются сами цифры даты (в т.ч. что такая дата есть в календаре).
// Возвращает YYYY-MM-DDTHH:mm:ss без часового пояса либо null, если значение не разобрать.
export function normalizeReceiptDateTime(value) {
  if (typeof value !== "string") return null;
  const match = /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4] ?? 0);
  const minutes = Number(match[5] ?? 0);
  const seconds = Number(match[6] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59 || seconds > 59) {
    return null;
  }
  // Отсекаем несуществующие даты календаря (31.02 и т.п.)
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;

  const pad = (part, size = 2) => String(part).padStart(size, "0");
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

// Системная инструкция: правила разбора чека и категоризации.
// Список категорий подставляется ДИНАМИЧЕСКИ (из запроса клиента): правило «строго из списка»
// должно стоять в системной инструкции, а не только в промпте — иначе модель придумывает
// свои категории («Продукты» вместо «Еда»), и позиции сваливаются в «Остальное».
function buildSystemInstruction(categoriesList) {
  return [
    "Ты разбираешь сербские фискальные чеки (suf.purs.gov.rs) и категоризуешь покупки.",
    "На вход приходит сырой текст чека — верни строго JSON по заданной схеме.",
    "Правила:",
    "1. items — все купленные позиции в исходном порядке. Служебные строки (итог, налог, сдача, заголовки, данные продавца и кассира) позициями не считаются.",
    `2. Каждая позиция ДОЛЖНА быть отнесена к одной из следующих категорий строго из списка: ${JSON.stringify(categoriesList)}. Не придумывай новые категории. Если ни одна категория из списка не подходит — null.`,
    '3. price — цена за единицу, qty — количество, total — сумма по позиции. Сербский формат чисел ("134,99", "1.234,56") переводи в обычные числа.',
    "4. Очищай название товара (name) от технологических пометок чека: убирай фискальные суффиксы «KOM (Ђ)», «KOM (E)», «KOM», служебные коды и прочий мусор. Размер упаковки оставляй в компактном латинском виде.",
    '   Пример: "SOK COCA COLA ZERO 1,5L KOM (Ђ)" -> "Sok Coca Cola Zero 1.5L".',
    "5. Форматируй итоговое название (name) по количеству — на фронтенде дополнительной склейки нет:",
    "   — если qty > 1, добавь к очищенному названию суффикс количества строго в формате «{Название} x{qty}». Пример: товар «Voda» в количестве 3 -> name = \"Voda x3\".",
    "   — если qty == 1, оставь только оригинальное название без суффикса. Пример: name = \"Hleb\".",
    "6. dateTime — дата и время покупки ТОЧНО так, как они напечатаны на чеке: формат YYYY-MM-DDTHH:mm:ss, локальное время чека. НЕ добавляй суффикс Z и НЕ указывай часовой пояс/смещение: 17:50 на чеке должно остаться 17:50, иначе приложение посчитает это UTC и прибавит локальный пояс.",
    '7. total — итоговая сумма чека (строка "Укупан износ"), а если её нет — сумма total всех позиций.',
    "Не добавляй пояснений, markdown и лишних полей — только JSON по схеме.",
  ].join("\n");
}


// Схема ответа модели: задаёт фиксированный JSON, который всегда вернёт Gemini
function buildResponseSchema(categoriesList) {
  return {
    type: "object",
    properties: {
      dateTime: {
        type: "string",
        nullable: true,
        // Формат date-time здесь НЕ указываем: он требует RFC 3339 и модель дописывает
        // «Z», а это превращает локальное время чека в UTC и сдвигает его на +2 часа
        description:
          "Дата и время покупки ровно как на чеке (локальное время), YYYY-MM-DDTHH:mm:ss, без Z и без смещения",
      },
      total: { type: "number", description: "Итоговая сумма чека" },
      items: {
        type: "array",
        description: "Позиции чека",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Готовое к показу название товара (склейка на клиенте не нужна): без фискальных суффиксов «KOM (Ђ)», «KOM (E)», «KOM» и служебных кодов; если qty > 1 — с суффиксом количества в формате «{Название} x{qty}» (например, «Voda x3»), если qty == 1 — только название (например, «Hleb»)",
            },
            qty: { type: "number", description: "Количество" },
            price: { type: "number", description: "Цена за единицу" },
            total: { type: "number", description: "Сумма по позиции" },
            category: {
              type: "string",
              nullable: true,
              enum: categoriesList,
              description:
                "Категория строго из списка допустимых категорий (enum) или null, если ничего не подходит",
            },
          },
          required: ["name", "qty", "price", "total", "category"],
        },
      },
    },
    required: ["dateTime", "total", "items"],
  };
}

// Сырой текст чека: убираем скрипты/стили и отдаём видимый текст страницы.
// Никакого разбора позиций на сервере — это делает модель.
export function extractReceiptText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const raw =
    $("#collapse3 pre").text() ||
    $("#PrintInvoice").text() ||
    $("#collapse3").text() ||
    $("body").text();

  return String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_RECEIPT_TEXT_LENGTH);
}

// Количество дописывается к названию ЗДЕСЬ, детерминированно (не полагаемся на модель):
//   qty > 1  -> «{Название} x{qty}»     (например, «Voda x3»)
//   qty == 1 -> только название          (например, «Hleb»)
// Функция идемпотентна: уже добавленный суффикс («... x3» или старый «... 3 kom») сначала
// снимается, затем добавляется один раз — поэтому дубля вида «Voda x3 x3» не будет, даже если
// модель тоже вернула название с количеством.
function formatItemName(rawName, qty) {
  const base = String(rawName ?? "")
    .replace(/\s+(?:x\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*kom)\s*$/i, "")
    .trim();
  if (!base) return "";
  return qty > 1 ? `${base} x${qty}` : base;
}

// Ответ модели -> формат API: числа числами, категория только из списка пользователя.
// Сравнение названий — нормализованное: модель может вернуть «Продукты», «продукты »
// или с неразрывным пробелом, и это не должно терять категорию.
function normalizeReceipt(payload, categoriesList) {
  const allowed = new Map(categoriesList.map((name) => [normalizeCategoryName(name), name]));
  const rawItems = Array.isArray(payload.items) ? payload.items : [];

  const items = rawItems
    .map((item) => {
      const total = Number(item?.total);
      const price = Number(item?.price);
      const qty = Number(item?.qty);
      const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
      // В ответе отдаём написание пользователя, а не модели
      const category = typeof item?.category === "string" ? allowed.get(normalizeCategoryName(item.category)) : undefined;
      return {
        name: formatItemName(item?.name, safeQty),
        qty: safeQty,
        price: Number.isFinite(price) ? price : Number.isFinite(total) ? total : 0,
        total: Number.isFinite(total) ? total : 0,
        category: category ?? null,
      };
    })
    .filter((item) => item.name && item.total > 0);

  const total = Number(payload.total);
  return {
    dateTime: normalizeReceiptDateTime(payload.dateTime),
    items,
    total: Number.isFinite(total) ? total : items.reduce((sum, item) => sum + item.total, 0),
  };
}

// Единственный вызов LLM: разбор позиций + категоризация + дата и итог чека
async function parseReceiptWithGemini(receiptText, categoriesList, modelId) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error("GEMINI_API_KEY не задан — распознавание чеков недоступно");
    error.status = 503;
    // Свой код, а не status: SDK Gemini тоже отдаёт status=503 (перегрузка модели),
    // и по статусу эти случаи не различить
    error.code = "NO_GEMINI_API_KEY";
    throw error;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel(
    {
      model: modelId || geminiModelForAttempt(1),
      // Инструкция собирается под конкретный список категорий пользователя
      systemInstruction: buildSystemInstruction(categoriesList),
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: buildResponseSchema(categoriesList),
      },
    },
    {
      // Таймаут одного запроса к Gemini: без него зависший вызов съедал лимит функции,
      // клиент не дожидался ответа и скан выглядел «сломанным»
      timeout: GEMINI_TIMEOUT_MS,
      // GEMINI_BASE_URL — опциональный override (тесты/прокси); в production не нужен
      ...(process.env.GEMINI_BASE_URL ? { baseUrl: process.env.GEMINI_BASE_URL } : {}),
    },
  );

  // Категории повторяем и в промпте: системная инструкция + промпт = меньше шансов,
  // что модель придумает своё название и позиция уедет в «Остальное»
  const prompt = [
    `Допустимые категории (строго из этого списка, новые не придумывать): ${JSON.stringify(categoriesList)}`,
    "Сырой текст чека:",
    receiptText,
  ].join("\n");

  const result = await model.generateContent(prompt);
  const payload = JSON.parse(result.response.text() || "{}");
  return normalizeReceipt(payload, categoriesList);
}

// Вызов Gemini с двумя РАЗНЫМИ правилами повтора — это и есть защита от лимита 5 RPM:
//  - 429 (лимит запросов): повторяем ту же модель с растущей паузой 2 с -> 4 с. Переключать
//    модель бессмысленно: квота считается на ключ, а не на модель;
//  - 503 «high demand» / таймаут / 5xx: ждать нечего, поэтому идём на СЛЕДУЮЩУЮ модель
//    цепочки (FALLBACK_GEMINI_MODELS);
//  - 400/401/403/404: не чинится ничем — сразу наружу.
async function parseReceiptWithGeminiLimits(receiptText, categoriesList) {
  let lastError;
  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt += 1) {
    const model = geminiModelForAttempt(attempt);
    for (let rateLimitTry = 0; ; rateLimitTry += 1) {
      try {
        return await parseReceiptWithGemini(receiptText, categoriesList, model);
      } catch (error) {
        lastError = error;
        if (error?.code === "NO_GEMINI_API_KEY" || isHardConfigError(error)) throw error;

        if (isRateLimited(error)) {
          if (rateLimitTry >= RATE_LIMIT_RETRIES) throw error;
          const waitMs = RATE_LIMIT_BASE_DELAY_MS * 2 ** rateLimitTry;
          console.warn(
            `receipt: Gemini 429 (${model}) — повтор через ${waitMs} мс, попытка ${rateLimitTry + 2} из ${RATE_LIMIT_RETRIES + 1}`,
          );
          await sleep(rateLimitDelayMs(waitMs));
          continue;
        }

        if (attempt < GEMINI_MAX_ATTEMPTS && worthAnotherModel(error)) {
          console.warn(`receipt: ${model} недоступна (${error?.message ?? error}) — резервная модель`);
          await sleep(retryDelayMs());
          break;
        }
        throw error;
      }
    }
  }
  throw lastError;
}

// --- CORS: GitHub Pages + localhost + доп. источники из env ---
function corsHeaders(origin) {
  const allowed = [
    "https://n0rg3.github.io",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    ...(process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  ];
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, ngrok-skip-browser-warning",
    Vary: "Origin",
  };
  // Чужой origin — заголовок не отдаём вовсе (браузер заблокирует запрос)
  if (origin && allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

// --- Vercel handler ---
export default async function handler(req, res) {
  const headers = corsHeaders(req.headers.origin);
  const send = (status, payload) => {
    res.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    return res.end();
  }
  if (req.method !== "POST") {
    return send(405, { error: "Метод не поддерживается, используй POST" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const qrUrl = String(body.qrUrl || "").trim();
    // Контракт API принимает ЛИБО qrUrl (Mini App передаёт сырой QR и страницу чека
    // скачивает сама функция), ЛИБО text — уже готовый сырой текст чека (например, вставленный
    // вручную). Если пришёл text, страницу чека не запрашиваем вовсе.
    const rawText = typeof body.text === "string" ? body.text.trim() : "";
    if (!qrUrl && !rawText) {
      return send(400, { error: "Передайте URL чека из QR-кода (qrUrl) или сырой текст чека (text)" });
    }

    let receiptText;
    if (rawText) {
      // Текст от клиента: только ограничиваем длину, как и текст со страницы чека
      receiptText = rawText.slice(0, MAX_RECEIPT_TEXT_LENGTH);
    } else {
      // Валидация: только https и домен налоговой Сербии (защита от SSRF)
      let url;
      try {
        url = new URL(qrUrl);
      } catch {
        return send(400, { error: "Некорректный URL чека" });
      }
      if (url.protocol !== "https:" || !/^(?:[a-z0-9-]+\.)*purs\.gov\.rs$/.test(url.hostname)) {
        return send(400, { error: "URL должен вести на suf.purs.gov.rs (сербский e-чек)" });
      }

      let response;
      try {
        // Повтор внутри fetchReceiptPage: холодный/подвисший сайт чека не должен
        // требовать от пользователя повторного сканирования
        response = await fetchReceiptPage(url);
      } catch (error) {
        console.error("Failed to fetch receipt page:", error);
        const siteStatus = error?.status;
        return send(502, {
          error:
            siteStatus && siteStatus < 500
              ? `Сайт чека вернул ошибку: HTTP ${siteStatus}`
              : "Сайт чека недоступен, попробуйте позже",
        });
      }

      // Сырой текст страницы чека -> единственный вызов Gemini (разбор + категоризация)
      receiptText = extractReceiptText(await response.text());
    }

    if (!receiptText) {
      return send(422, { error: "Не удалось распознать структуру чека" });
    }

    // Категории пользователя опциональны; по умолчанию — стартовые категории того же языка,
    // что и в Mini App. Пустой список — тревожный признак: категории из ответа модели
    // не сматчатся с категориями пользователя, поэтому такой случай пишем в лог
    const categoriesFromClient = Array.isArray(body.categories)
      ? body.categories.map(String).map((name) => name.trim()).filter(Boolean)
      : [];
    const lang = typeof body.lang === "string" ? body.lang.trim().toLowerCase() : "";
    const fallbackCategories = defaultCategoriesForLang(lang);
    if (categoriesFromClient.length === 0) {
      console.warn(
        `parse-receipt: клиент не передал categories — беру стартовые категории языка «${lang || "ru"}»:`,
        fallbackCategories,
      );
    }
    const categoriesList = categoriesFromClient.length > 0 ? categoriesFromClient : fallbackCategories;

    try {
      // Повторы внутри: 429 -> та же модель с backoff, 503/таймаут -> резервная модель
      const receipt = await parseReceiptWithGeminiLimits(receiptText, categoriesList);
      if (receipt.items.length === 0) {
        return send(422, { error: "Не удалось распознать структуру чека" });
      }
      return send(200, receipt);
    } catch (error) {
      console.error("Gemini receipt parsing failed:", error instanceof Error ? error.message : error);
      // Нет ключа — настройка окружения, а не сбой сервиса
      if (error?.code === "NO_GEMINI_API_KEY") {
        return send(503, { error: "Распознавание чеков недоступно: не задан ключ Gemini (GEMINI_API_KEY)" });
      }
      // Исчерпан лимит запросов (5 RPM): повторы уже не помогли, нужен отказ от сканирования
      // на 30–60 с. code даёт клиенту возможность показать сообщение на языке интерфейса
      if (isRateLimited(error)) {
        return send(429, {
          error: "Превышен лимит запросов. Пожалуйста, подождите 30–60 секунд перед следующей попыткой.",
          code: "RATE_LIMITED",
        });
      }
      // Снятая с продажи модель (404) / невалидный ключ (401/403) — резервные модели не помогут
      if (isConfigError(error)) {
        return send(503, {
          error: "Распознавание чеков настроено неверно: проверь GEMINI_API_KEY и GEMINI_MODEL",
        });
      }
      // Модели заняты (503 «high demand») — это не ошибка чека, а емкость Gemini
      if (isCapacityError(error)) {
        return send(503, { error: "Сервис распознавания перегружен, попробуйте через минуту" });
      }
      return send(502, { error: "Сервис распознавания чеков вернул ошибку, попробуйте позже" });
    }
  } catch (error) {
    console.error("parse-receipt unexpected error:", error);
    return send(500, { error: "Внутренняя ошибка сервера" });
  }
}

