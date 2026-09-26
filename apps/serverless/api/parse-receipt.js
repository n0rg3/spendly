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

// Список категорий из ТЗ — используется, если клиент не передал свои
const DEFAULT_CATEGORIES = ["Продукты", "Тусичи", "Дом", "Транспорт", "Развлечения", "Остальное"];

// Модель по умолчанию: Structured Outputs (responseSchema) поддерживается Gemini 2.5 Flash
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

// Страница чека может быть большой; модели достаточно текста покупки
const MAX_RECEIPT_TEXT_LENGTH = 20_000;

// Системная инструкция: правила разбора чека и категоризации
const SYSTEM_INSTRUCTION = [
  "Ты разбираешь сербские фискальные чеки (suf.purs.gov.rs) и категоризуешь покупки.",
  "На вход приходит сырой текст чека — верни строго JSON по заданной схеме.",
  "Правила:",
  "1. items — все купленные позиции в исходном порядке. Служебные строки (итог, налог, сдача, заголовки, данные продавца и кассира) позициями не считаются.",
  '2. price — цена за единицу, qty — количество, total — сумма по позиции. Сербский формат чисел ("134,99", "1.234,56") переводи в обычные числа.',
  "3. category — ровно одно название из списка допустимых категорий; если ничего не подходит — null.",
  "4. dateTime — дата и время покупки из чека в формате ISO 8601 (YYYY-MM-DDTHH:mm:ss).",
  '5. total — итоговая сумма чека (строка "Укупан износ"), а если её нет — сумма total всех позиций.',
  "Не добавляй пояснений, markdown и лишних полей — только JSON по схеме.",
].join("\n");


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
            name: { type: "string", description: "Название товара как в чеке" },
            qty: { type: "number", description: "Количество" },
            price: { type: "number", description: "Цена за единицу" },
            total: { type: "number", description: "Сумма по позиции" },
            category: {
              type: "string",
              nullable: true,
              enum: categoriesList,
              description: "Категория из списка допустимых или null",
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

// Ответ модели -> формат API: числа числами, категория только из списка пользователя
function normalizeReceipt(payload, categoriesList) {
  const allowed = new Set(categoriesList);
  const rawItems = Array.isArray(payload.items) ? payload.items : [];

  const items = rawItems
    .map((item) => {
      const total = Number(item?.total);
      const price = Number(item?.price);
      const qty = Number(item?.qty);
      return {
        name: String(item?.name ?? "").trim(),
        qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
        price: Number.isFinite(price) ? price : Number.isFinite(total) ? total : 0,
        total: Number.isFinite(total) ? total : 0,
        category:
          typeof item?.category === "string" && allowed.has(item.category) ? item.category : null,
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
      systemInstruction: SYSTEM_INSTRUCTION,
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: buildResponseSchema(categoriesList),
      },
    },
    // GEMINI_BASE_URL — опциональный override (тесты/прокси); в production не нужен
    process.env.GEMINI_BASE_URL ? { baseUrl: process.env.GEMINI_BASE_URL } : undefined,
  );

  const prompt = [
    `Допустимые категории: ${JSON.stringify(categoriesList)}`,
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
      response = await fetch(url, {
        headers: { "User-Agent": RECEIPT_USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      console.error("Failed to fetch receipt page:", error);
      return send(502, { error: "Сайт чека недоступен, попробуйте позже" });
    }

    if (!response.ok) {
      return send(502, { error: `Сайт чека вернул ошибку: HTTP ${response.status}` });
    }

    // Сырой текст страницы чека -> единственный вызов Gemini (разбор + категоризация)
    const receiptText = extractReceiptText(await response.text());
    if (!receiptText) {
      return send(422, { error: "Не удалось распознать структуру чека" });
    }

    // Категории пользователя опциональны; по умолчанию — фиксированный список из ТЗ
    const categoriesList =
      Array.isArray(body.categories) && body.categories.length > 0
        ? body.categories.map(String)
        : DEFAULT_CATEGORIES;

    try {
      const receipt = await parseReceiptWithGemini(receiptText, categoriesList);
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

