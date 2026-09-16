// ===== Vercel Serverless: парсинг сербских чеков (suf.purs.gov.rs) + Gemini-категоризация =====
// Деплой: vercel из этой папки (apps/serverless). Эндпоинт: POST /api/receipts/parse
// (алиас на /api/parse-receipt через vercel.json rewrites).
// Env: GEMINI_API_KEY, GEMINI_MODEL (по умолчанию gemini-3.6-flash),
//      ALLOWED_ORIGINS (опционально, через запятую — дополнительные CORS-источники).
import * as cheerio from "cheerio";
import { GoogleGenerativeAI } from "@google/generative-ai";

const RECEIPT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DEFAULT_CATEGORIES = ["Продукты", "Кафе", "Дом", "Транспорт", "Развлечения", "Другое"];

// Актуальная модель Gemini (gemini-2.0-flash снята с поддержки — API отвечает 404)
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

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

// --- Числа в сербском формате: 1.234,56 ---
function parseSerbianNumber(raw) {
  const cleaned = String(raw || "").replace(/[^\d.,-]/g, "").trim();
  if (!cleaned) return NaN;
  const normalized = cleaned.includes(",")
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned.replace(/,/g, "");
  return Number.parseFloat(normalized);
}

function looksLikeNumber(value) {
  return /^[\d.,]+$/.test(value) && /\d/.test(value);
}

// --- Парсинг HTML чека ---
function parseReceiptHtml(html) {
  const $ = cheerio.load(html);

  // Дата/время: #sdcDateTimeLabel ("16.9.2026. 17:50:44"), fallback #sdcDateTime / регэксп
  let dateTime = $("#sdcDateTimeLabel").text().trim() || $("#sdcDateTime").text().trim() || null;
  if (!dateTime) {
    const match = $("body")
      .text()
      .match(/\d{1,2}\.\d{1,2}\.\d{4}\.?\s+\d{1,2}:\d{2}(?::\d{2})?/);
    dateTime = match ? match[0] : null;
  }

  const items = [];

  // Способ 1: таблица спецификации (если Knockout отрендерил её на сервере)
  $("table.invoice-table tr, table.invoice-table tbody tr").each((_, row) => {
    const cells = $(row)
      .find("td")
      .map((__, cell) => $(cell).text().trim())
      .get();
    if (cells.length < 4) return;
    const total = parseSerbianNumber(cells[3]);
    if (!Number.isFinite(total)) return;
    const qty = parseSerbianNumber(cells[1]);
    const price = parseSerbianNumber(cells[2]);
    items.push({
      name: cells[0] || "",
      qty: Number.isFinite(qty) ? qty : 1,
      price: Number.isFinite(price) ? price : total,
      total,
    });
  });

  // Способ 2 (основной): текстовый дамп чека в <pre> панели #collapse3.
  // Таблица в статическом HTML пуста — её рендерит Knockout.js на клиенте.
  // Название товара и числа могут быть на разных строках.
  if (items.length === 0) {
    const receiptText = $("#collapse3 pre").text() || $("#PrintInvoice").text() || $("body").text();
    const lines = receiptText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    let inItems = false;
    let pendingName = "";

    const pushItem = (name, priceRaw, qtyRaw, totalRaw) => {
      const total = parseSerbianNumber(totalRaw);
      const price = parseSerbianNumber(priceRaw);
      const qty = parseSerbianNumber(qtyRaw);
      if (!Number.isFinite(total) || total <= 0) return;
      items.push({
        name: name.trim(),
        qty: Number.isFinite(qty) ? qty : 1,
        price: Number.isFinite(price) ? price : total,
        total,
      });
    };

    for (const line of lines) {
      if (!inItems) {
        if (/Назив|Name/i.test(line) && /Цена|Price/i.test(line)) inItems = true;
        continue;
      }

      if (/Укупан износ|Total amount|Порез|Tax/i.test(line)) break;
      if (/^-{3,}|={3,}/.test(line)) continue;

      // Три числа на отдельной строке: "<цена> <кол-во> <итог>"
      const numbersMatch = line.match(/^([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)$/);
      if (
        numbersMatch &&
        looksLikeNumber(numbersMatch[1]) &&
        looksLikeNumber(numbersMatch[2]) &&
        looksLikeNumber(numbersMatch[3])
      ) {
        pushItem(pendingName || line, numbersMatch[1], numbersMatch[2], numbersMatch[3]);
        pendingName = "";
        continue;
      }

      // Всё в одной строке: "<название> <цена> <кол-во> <итог>"
      const itemMatch = line.match(/^(.+?)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)$/);
      if (
        itemMatch &&
        looksLikeNumber(itemMatch[2]) &&
        looksLikeNumber(itemMatch[3]) &&
        looksLikeNumber(itemMatch[4])
      ) {
        pushItem(itemMatch[1], itemMatch[2], itemMatch[3], itemMatch[4]);
        pendingName = "";
        continue;
      }

      pendingName = pendingName ? `${pendingName} ${line}` : line;
    }
  }

  return { dateTime, items, total: items.reduce((sum, item) => sum + item.total, 0) };
}

// --- Gemini: категоризация позиций ---
async function categorizeReceiptItems(items, categoriesList) {
  if (items.length === 0) return [];
  if (!process.env.GEMINI_API_KEY || categoriesList.length === 0) {
    return items.map((item) => ({ ...item, category: null }));
  }

  const prompt = [
    `Разбей список товаров из сербского чека по категориям: ${JSON.stringify(categoriesList)}.`,
    "Каждой позиции присвой ровно одну категорию из списка; если ничего не подходит — null.",
    "Верни СТРОГО JSON-массив объектов {name, qty, price, total, category} — без markdown, пояснений и любого другого текста.",
    `Товары: ${JSON.stringify(items)}`,
  ].join("\n");

  // Модель из env, иначе актуальный дефолт. Если модель снята с поддержки (404),
  // пробуем рекомендованную — автокатегоризация не отвалится при deprecation.
  const models = [...new Set([process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_MODEL])];
  const allowed = new Set(categoriesList);
  let lastError;

  for (const modelName of models) {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      // GEMINI_BASE_URL — опциональный override (используется в тестах/прокси); в production не нужен
      const model = genAI.getGenerativeModel(
        {
          model: modelName,
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        },
        process.env.GEMINI_BASE_URL ? { baseUrl: process.env.GEMINI_BASE_URL } : undefined,
      );

      const result = await model.generateContent(prompt);
      const parsed = JSON.parse(result.response.text() || "[]");

      return items.map((item, index) => {
        const aiCategory = typeof parsed[index]?.category === "string" ? parsed[index].category : null;
        return { ...item, category: aiCategory && allowed.has(aiCategory) ? aiCategory : null };
      });
    } catch (error) {
      lastError = error;
      console.error(`Gemini model "${modelName}" failed:`, error instanceof Error ? error.message : error);
    }
  }

  console.error("Gemini categorization failed for all models:", lastError instanceof Error ? lastError.message : lastError);
  return items.map((item) => ({ ...item, category: null }));
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

    const html = await response.text();
    const receipt = parseReceiptHtml(html);

    if (!receipt.dateTime && receipt.items.length === 0) {
      return send(422, { error: "Не удалось распознать структуру чека" });
    }

    // Категории пользователя опциональны; по умолчанию — фиксированный список из ТЗ
    const categoriesList =
      Array.isArray(body.categories) && body.categories.length > 0
        ? body.categories.map(String)
        : DEFAULT_CATEGORIES;

    const items = await categorizeReceiptItems(receipt.items, categoriesList);

    return send(200, { dateTime: receipt.dateTime, items, total: receipt.total });
  } catch (error) {
    console.error("parse-receipt unexpected error:", error);
    return send(500, { error: "Внутренняя ошибка сервера" });
  }
}
