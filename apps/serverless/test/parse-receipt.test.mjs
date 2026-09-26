// Автотесты serverless-функции (встроенный node:test, без внешних зависимостей).
// Запуск: pnpm --filter @sp3ndly/serverless test
//
// Разбор чека целиком выполняет LLM, поэтому Gemini подменяется моком: global fetch
// перехватывает и страницу чека (suf.purs.gov.rs), и вызов generativelanguage.googleapis.com.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import handler, { extractReceiptText } from "../api/parse-receipt.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const receiptHtml = readFileSync(join(fixturesDir, "receipt.html"), "utf-8");

// Ответ «модели»: ровно тот JSON, который возвращает Gemini по responseSchema
const AI_RECEIPT = {
  dateTime: "2026-09-16T17:50:44",
  items: [
    { name: "BOMBONE HARIBO STAR MIX  KOM (Ђ)", qty: 1, price: 134.99, total: 134.99, category: "Продукты" },
    { name: "VODA MINERALNA 0,5L KNJA KOM (Ђ)", qty: 1, price: 57.99, total: 57.99, category: "Продукты" },
    { name: "KESA (Ђ)", qty: 1, price: 2, total: 2, category: "Дом" },
  ],
  total: 194.98,
};

const realFetch = globalThis.fetch;
// Состояние мока: последний запрос к Gemini, ответ модели и подмена HTML чека
let geminiUrl = null;
let geminiRequest = null;
let geminiReply = AI_RECEIPT;
let geminiStatus = 200;
let receiptHtmlOverride = null;

globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target.includes("purs.gov.rs")) {
    return { ok: true, status: 200, text: async () => receiptHtmlOverride ?? receiptHtml };
  }
  if (target.includes("generateContent")) {
    geminiUrl = target;
    geminiRequest = JSON.parse(options?.body ?? "{}");
    if (geminiStatus !== 200) {
      return {
        ok: false,
        status: geminiStatus,
        statusText: "Error",
        json: async () => ({ error: { message: "mock gemini error" } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(geminiReply) }] } }],
      }),
    };
  }
  return realFetch(url, options);
};

after(() => {
  globalThis.fetch = realFetch;
});

// Сброс мока и env перед сценарием. apiKey: null — «ключ не задан»
function resetAi({ apiKey = "test-key" } = {}) {
  if (apiKey === null) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = apiKey;
  delete process.env.GEMINI_BASE_URL;
  delete process.env.GEMINI_MODEL;
  geminiUrl = null;
  geminiRequest = null;
  geminiReply = AI_RECEIPT;
  geminiStatus = 200;
  receiptHtmlOverride = null;
}

// Вызов handler с моком node:http-ответа (как отдаёт @vercel/node)
async function invoke({ method = "POST", body, origin = "https://n0rg3.github.io" } = {}) {
  let raw = "";
  const res = {
    statusCode: null,
    headers: null,
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers) this.headers = headers;
    },
    write(chunk) {
      raw += chunk;
    },
    end(chunk) {
      if (chunk) raw += chunk;
    },
  };
  await handler({ method, body, headers: { origin } }, res);
  return { status: res.statusCode, headers: res.headers ?? {}, body: raw ? JSON.parse(raw) : null };
}

const QR_URL = "https://suf.purs.gov.rs/v/?vl=TESTQRURL";

test("распознаёт чек одним вызовом Gemini: позиции, категории, итог и дата", async () => {
  resetAi();
  const { status, body } = await invoke({
    body: { qrUrl: QR_URL, categories: ["Продукты", "Дом", "Транспорт"] },
  });

  assert.equal(status, 200);
  assert.equal(body.dateTime, "2026-09-16T17:50:44");
  assert.deepEqual(
    body.items.map((i) => i.name),
    ["BOMBONE HARIBO STAR MIX  KOM (Ђ)", "VODA MINERALNA 0,5L KNJA KOM (Ђ)", "KESA (Ђ)"],
  );
  assert.deepEqual(body.items.map((i) => i.category), ["Продукты", "Продукты", "Дом"]);
  assert.deepEqual(body.items.map((i) => i.total), [134.99, 57.99, 2]);
  // сумма с плавающей точкой: 134.99 + 57.99 + 2
  assert.ok(Math.abs(body.total - 194.98) < 1e-9, `total = ${body.total}`);
});

test("в Gemini уходит сырой текст чека и JSON-схема (Structured Outputs)", async () => {
  resetAi();
  await invoke({ body: { qrUrl: QR_URL, categories: ["Еда", "Транспорт"] } });

  // Модель по умолчанию — Gemini 2.5 Flash
  assert.match(geminiUrl, /models\/gemini-2\.5-flash:generateContent/);

  const { generationConfig } = geminiRequest;
  assert.equal(generationConfig.responseMimeType, "application/json");
  assert.deepEqual(generationConfig.responseSchema.required, ["dateTime", "total", "items"]);
  assert.deepEqual(
    generationConfig.responseSchema.properties.items.items.properties.category.enum,
    ["Еда", "Транспорт"],
  );

  // В промпт попадает распознанный текст чека, а не HTML
  const prompt = geminiRequest.contents[0].parts[0].text;
  assert.match(prompt, /VODA MINERALNA 0,5L/);
  assert.ok(!prompt.includes("<pre>") && !prompt.includes("<html"), "в модель должен уходить текст, а не HTML");
});

test("GEMINI_MODEL переопределяет модель по умолчанию", async () => {
  resetAi();
  process.env.GEMINI_MODEL = "gemini-2.5-flash-lite";
  await invoke({ body: { qrUrl: QR_URL } });

  assert.match(geminiUrl, /models\/gemini-2\.5-flash-lite:generateContent/);
});

test("категория не из списка пользователя сбрасывается в null", async () => {
  resetAi();
  const { status, body } = await invoke({ body: { qrUrl: QR_URL, categories: ["Еда"] } });

  assert.equal(status, 200);
  assert.deepEqual(body.items.map((i) => i.category), [null, null, null]);
});

test("без GEMINI_API_KEY распознавание недоступно (503)", async () => {
  resetAi({ apiKey: null });
  const { status, body } = await invoke({ body: { qrUrl: QR_URL } });

  assert.equal(status, 503);
  assert.match(body.error, /GEMINI_API_KEY/);
});

test("ошибка Gemini отдаётся как 502, без выдуманных позиций", async () => {
  resetAi();
  geminiStatus = 500;
  const { status, body } = await invoke({ body: { qrUrl: QR_URL } });

  assert.equal(status, 502);
  assert.ok(body.error);
  assert.equal(body.items, undefined);
});

test("пустой текст чека — 422, модель не вызывается", async () => {
  resetAi();
  receiptHtmlOverride = "<html><body><script>var a = 1;</script><style>.x{}</style></body></html>";
  const { status } = await invoke({ body: { qrUrl: QR_URL } });

  assert.equal(status, 422);
  assert.equal(geminiRequest, null);
});

test("extractReceiptText отдаёт текст чека без скриптов, стилей и тегов", () => {
  const text = extractReceiptText(receiptHtml);

  assert.match(text, /VODA MINERALNA 0,5L KNJA KOM/);
  assert.match(text, /Укупан износ/);
  assert.ok(!text.includes("<pre>") && !text.includes("<div"));
});


test("CORS: github.io получает свой origin, чужой домен — без заголовка", async () => {
  const allowed = await invoke({ method: "OPTIONS" });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers["Access-Control-Allow-Origin"], "https://n0rg3.github.io");

  const blocked = await invoke({ method: "OPTIONS", origin: "https://evil.com" });
  assert.equal(blocked.status, 204);
  assert.equal(blocked.headers["Access-Control-Allow-Origin"], undefined);

  const noOrigin = await invoke({ method: "OPTIONS", origin: undefined });
  assert.equal(noOrigin.status, 204);
});

test("SSRF: разрешены только https-URL на *.purs.gov.rs", async () => {
  const evil = await invoke({ body: { qrUrl: "https://evil.com/steal" } });
  assert.equal(evil.status, 400);

  const httpUrl = await invoke({ body: { qrUrl: "http://suf.purs.gov.rs/v/?vl=x" } });
  assert.equal(httpUrl.status, 400);

  const broken = await invoke({ body: { qrUrl: "not-a-url" } });
  assert.equal(broken.status, 400);

  const missing = await invoke({ body: {} });
  assert.equal(missing.status, 400);
});

test("GET не поддерживается (405)", async () => {
  const { status, body } = await invoke({ method: "GET" });
  assert.equal(status, 405);
  assert.match(body.error, /POST/);
});

