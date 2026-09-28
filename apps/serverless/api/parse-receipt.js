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
//      GEMINI_MODEL (по умолчанию gemini-2.5-flash),
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

// Модель по умолчанию: Structured Outputs (responseSchema) поддерживается Gemini 2.5 Flash
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

// Страница чека может быть большой; модели достаточно текста покупки
const MAX_RECEIPT_TEXT_LENGTH = 20_000;

// Таймаут запроса страницы чека и один быстрый повтор на транзиентный сбой.
// Первый (холодный) запрос к сайту чека/Gemini иногда падает — именно поэтому раньше
// распознавание «срабатывало только со 2-3 раза». Повтор лечит это без участия пользователя.
// Бюджет времени подобран под maxDuration функции на Vercel (60 с):
// 12 с × 2 попытки на страницу чека + 15 с × 2 попытки на Gemini ≈ 55 с в худшем случае
const RECEIPT_FETCH_TIMEOUT_MS = 12_000;
const GEMINI_TIMEOUT_MS = 15_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 2;
// Пауза между попытками; в тестах выключается через RECEIPT_RETRY_DELAY_MS=0
const retryDelayMs = () => {
  const value = Number(process.env.RECEIPT_RETRY_DELAY_MS);
  return Number.isFinite(value) && value >= 0 ? value : 500;
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

// Один быстрый повтор для транзиентных сбоев (сеть, таймаут, 429/5xx)
async function withRetry(run, shouldRetry) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_ATTEMPTS || !shouldRetry(error)) throw error;
      console.warn(`receipt: попытка ${attempt} не удалась (${error?.message ?? error}) — повтор`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs()));
    }
  }
  throw lastError;
}

// Транзиентная ошибка: сеть/таймаут/5xx/429 — то, что имеет смысл повторить.
// Ошибки схемы/конфигурации (400/403/404) повторять бессмысленно.
const isTransient = (error) => {
  const status = error?.status ?? error?.response?.status ?? error?.response?.error?.code;
  if (typeof status === "number") return RETRYABLE_STATUS.has(status);
  // SDK не всегда отдаёт статус числом — ищем его в тексте ошибки
  const match = /\b(\d{3})\b/.exec(String(error?.message ?? ""));
  if (match) {
    const code = Number(match[1]);
    if (code >= 400 && code < 600) return RETRYABLE_STATUS.has(code);
  }
  // Статуса нет вообще (DNS, обрыв соединения, таймаут) — повторяем
  return true;
};

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
    "5. dateTime — дата и время покупки из чека в формате ISO 8601 (YYYY-MM-DDTHH:mm:ss).",
    '6. total — итоговая сумма чека (строка "Укупан износ"), а если её нет — сумма total всех позиций.',
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
        format: "date-time",
        nullable: true,
        description: "Дата и время покупки в формате ISO 8601",
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
                "Название товара без технологических пометок чека: без фискальных суффиксов «KOM (Ђ)», «KOM (E)», «KOM» и служебных кодов",
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
      // В ответе отдаём написание пользователя, а не модели
      const category = typeof item?.category === "string" ? allowed.get(normalizeCategoryName(item.category)) : undefined;
      return {
        name: String(item?.name ?? "").trim(),
        qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
        price: Number.isFinite(price) ? price : Number.isFinite(total) ? total : 0,
        total: Number.isFinite(total) ? total : 0,
        category: category ?? null,
      };
    })
    .filter((item) => item.name && item.total > 0);

  const total = Number(payload.total);
  return {
    dateTime: typeof payload.dateTime === "string" && payload.dateTime ? payload.dateTime : null,
    items,
    total: Number.isFinite(total) ? total : items.reduce((sum, item) => sum + item.total, 0),
  };
}

// Единственный вызов LLM: разбор позиций + категоризация + дата и итог чека
async function parseReceiptWithGemini(receiptText, categoriesList) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error("GEMINI_API_KEY не задан — распознавание чеков недоступно");
    error.status = 503;
    throw error;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel(
    {
      model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
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
    if (!qrUrl) {
      return send(400, { error: "Передайте URL чека из QR-кода (qrUrl)" });
    }

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
    const receiptText = extractReceiptText(await response.text());
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
      // Повтор на транзиентной ошибке Gemini: первый (холодный) вызов иногда падает
      const receipt = await withRetry(
        () => parseReceiptWithGemini(receiptText, categoriesList),
        (error) => error?.status !== 503 && isTransient(error),
      );
      if (receipt.items.length === 0) {
        return send(422, { error: "Не удалось распознать структуру чека" });
      }
      return send(200, receipt);
    } catch (error) {
      const status = error?.status === 503 ? 503 : 502;
      console.error("Gemini receipt parsing failed:", error instanceof Error ? error.message : error);
      return send(status, {
        error:
          status === 503
            ? "Распознавание чеков недоступно: не задан ключ Gemini (GEMINI_API_KEY)"
            : "Сервис распознавания чеков вернул ошибку, попробуйте позже",
      });
    }
  } catch (error) {
    console.error("parse-receipt unexpected error:", error);
    return send(500, { error: "Внутренняя ошибка сервера" });
  }
}

