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
// Состояние мока: последний запрос к Gemini, ответ модели и подмена HTML чека.
// receiptFails/geminiFails — сколько первых попыток должно упасть (для проверки ретраев).
let geminiUrl = null;
let geminiUrls = []; // все вызовы по порядку: нужно видеть, на какой модели был повтор
let geminiRequest = null;
let geminiReply = AI_RECEIPT;
let geminiStatus = 200;
let receiptHtmlOverride = null;
let receiptFails = 0;
let geminiFails = 0;
let geminiFailStatus = 500; // статус для падающих попыток (503 — перегрузка, 404 — снятая модель)
let geminiCalls = 0;
let receiptCalls = 0;

globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target.includes("purs.gov.rs")) {
    receiptCalls += 1;
    if (receiptFails > 0) {
      receiptFails -= 1;
      // Как ведёт себя сеть при холодном/подвисшем сайте чека
      throw new TypeError("fetch failed");
    }
    return { ok: true, status: 200, text: async () => receiptHtmlOverride ?? receiptHtml };
  }
  if (target.includes("generateContent")) {
    geminiUrl = target;
    geminiUrls.push(target);
    geminiRequest = JSON.parse(options?.body ?? "{}");
    geminiCalls += 1;
    if (geminiFails > 0) {
      geminiFails -= 1;
      return {
        ok: false,
        status: geminiFailStatus,
        statusText: "Error",
        json: async () => ({ error: { message: "mock gemini error" } }),
      };
    }
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
  // Ретраи не должны тормозить тесты
  process.env.RECEIPT_RETRY_DELAY_MS = "0";
  geminiUrl = null;
  geminiUrls = [];
  geminiRequest = null;
  geminiReply = AI_RECEIPT;
  geminiStatus = 200;
  receiptHtmlOverride = null;
  receiptFails = 0;
  geminiFails = 0;
  geminiFailStatus = 500;
  geminiCalls = 0;
  receiptCalls = 0;
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

// Модели, на которых реально уходили вызовы в Gemini, — по порядку вызовов
function calledModels() {
  return geminiUrls.map((url) => /models\/([a-z0-9.-]+):/.exec(url)[1]);
}

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
  assert.match(geminiUrl, /models\/gemini-3\.8-flash:generateContent/);

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

test("без categories используется СТАРТОВЫЙ список языка клиента — и он же уходит в схему", async () => {
  resetAi();
  await invoke({ body: { qrUrl: QR_URL } });

  // Fallback обязан совпадать с категориями нового пользователя в Mini App (defaultDashboard),
  // иначе названия из ответа модели не сматчатся с категориями пользователя
  assert.deepEqual(
    geminiRequest.generationConfig.responseSchema.properties.items.items.properties.category.enum,
    ["Еда", "Транспорт", "Покупки"],
  );
});

test("lang=en задаёт англоязычный fallback категорий, список пользователя всегда важнее", async () => {
  resetAi();
  await invoke({ body: { qrUrl: QR_URL, lang: "en" } });

  assert.deepEqual(
    geminiRequest.generationConfig.responseSchema.properties.items.items.properties.category.enum,
    ["Food", "Transport", "Shopping"],
  );

  resetAi();
  await invoke({ body: { qrUrl: QR_URL, lang: "en", categories: ["Еда"] } });
  assert.deepEqual(
    geminiRequest.generationConfig.responseSchema.properties.items.items.properties.category.enum,
    ["Еда"],
  );
});

test("категория модели сопоставляется с категорией пользователя без учёта регистра и пробелов", async () => {
  resetAi();
  geminiReply = {
    ...AI_RECEIPT,
    items: [
      { name: "VODA", qty: 1, price: 57.99, total: 57.99, category: "  продукты " },
      { name: "KESA", qty: 1, price: 2, total: 2, category: "ДОМ" },
      { name: "X", qty: 1, price: 1, total: 1, category: "Чужое" },
    ],
  };
  const { status, body } = await invoke({ body: { qrUrl: QR_URL, categories: ["Продукты", "Дом"] } });

  assert.equal(status, 200);
  // Написание в ответе — пользователя, чужая категория по-прежнему null
  assert.deepEqual(body.items.map((i) => i.category), ["Продукты", "Дом", null]);
});

test("первый (холодный) сбой сайта чека лечится повтором без участия пользователя", async () => {
  resetAi();
  receiptFails = 1;
  const { status, body } = await invoke({ body: { qrUrl: QR_URL, categories: ["Продукты"] } });

  assert.equal(status, 200);
  assert.equal(receiptCalls, 2, "страница чека должна быть запрошена повторно");
  assert.equal(body.items.length, 3);
});

test("транзиентная ошибка Gemini повторяется один раз и затем отдаёт результат", async () => {
  resetAi();
  geminiFails = 1;
  const { status, body } = await invoke({ body: { qrUrl: QR_URL, categories: ["Продукты", "Дом"] } });

  assert.equal(status, 200);
  assert.equal(geminiCalls, 2, "Gemini должен быть вызван повторно после сбоя");
  assert.deepEqual(body.items.map((i) => i.category), ["Продукты", "Продукты", "Дом"]);
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

test("системная инструкция жёстко фиксирует список категорий и правило очистки названий", async () => {
  resetAi();
  await invoke({ body: { qrUrl: QR_URL, categories: ["Еда", "Транспорт"] } });

  const instruction = (geminiRequest.systemInstruction?.parts ?? []).map((part) => part.text).join("\n");

  // Переданный список категорий зафиксирован в системной инструкции
  assert.match(instruction, /"Еда"/);
  assert.match(instruction, /"Транспорт"/);
  assert.match(instruction, /строго из списка/);
  assert.match(instruction, /Не придумывай новые категории/);

  // Правило очистки названий от фискальных пометок сербских чеков
  assert.match(instruction, /KOM \(Ђ\)/);
  assert.match(instruction, /SOK COCA COLA ZERO 1,5L KOM \(Ђ\)/);
  assert.match(instruction, /Sok Coca Cola Zero 1\.5L/);

  // Описание поля name в схеме тоже требует чистого названия
  assert.match(
    geminiRequest.generationConfig.responseSchema.properties.items.items.properties.name.description,
    /KOM/,
  );

  // И список категорий продублирован в промпте
  assert.match(geminiRequest.contents[0].parts[0].text, /"Еда"/);
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

test("время чека остаётся местным: суффикс Z и смещение отбрасываются, а не читаются как UTC", async () => {
  resetAi();
  // Модель часто дописывает Z/смещение — 17:50 на чеке должно остаться 17:50
  geminiReply = { ...AI_RECEIPT, dateTime: "2026-09-16T17:50:44Z" };
  const withZ = await invoke({ body: { qrUrl: QR_URL, categories: ["Еда"] } });
  assert.equal(withZ.status, 200);
  assert.equal(withZ.body.dateTime, "2026-09-16T17:50:44", "Z не должен попасть в ответ");

  resetAi();
  geminiReply = { ...AI_RECEIPT, dateTime: "2026-09-16T17:50:44+02:00" };
  const withOffset = await invoke({ body: { qrUrl: QR_URL, categories: ["Еда"] } });
  assert.equal(withOffset.body.dateTime, "2026-09-16T17:50:44", "смещение не должно попасть в ответ");

  resetAi();
  geminiReply = { ...AI_RECEIPT, dateTime: "2026-09-16 17:50" };
  const spaceSeparated = await invoke({ body: { qrUrl: QR_URL, categories: ["Еда"] } });
  assert.equal(spaceSeparated.body.dateTime, "2026-09-16T17:50:00", "без секунд -> :00");
});

test("неразобранная дата чека -> null, а не сдвинутая дата", async () => {
  for (const bogus of ["", "не дата", "2026-13-40T99:99:99Z", "2026-02-31T10:00:00"]) {
    resetAi();
    geminiReply = { ...AI_RECEIPT, dateTime: bogus };
    const { status, body } = await invoke({ body: { qrUrl: QR_URL, categories: ["Еда"] } });
    assert.equal(status, 200, `dateTime=${bogus}`);
    assert.equal(body.dateTime, null, `dateTime=${bogus} должен превратиться в null`);
  }
});

test("схема и инструкция запрещают Z: формат date-time убран, правило про локальное время есть", async () => {
  resetAi();
  await invoke({ body: { qrUrl: QR_URL, categories: ["Еда"] } });

  const dateTimeSchema = geminiRequest.generationConfig.responseSchema.properties.dateTime;
  assert.equal(dateTimeSchema.format, undefined, "format: date-time тянет модель дописывать Z");
  assert.match(dateTimeSchema.description, /без Z/);
  assert.match(geminiRequest.systemInstruction.parts[0].text, /НЕ добавляй суффикс Z/);
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

test("принимает сырой текст чека (text) без скачивания страницы и категоризует по списку", async () => {
  resetAi();
  const receiptText = ["VODA MINERALNA 0,5L KNJA KOM (Ђ)", "1,00 57,99 57,99", "Укупан износ 57,99"].join("\n");
  const { status, body } = await invoke({
    body: { text: receiptText, categories: ["Продукты", "Дом"] },
  });

  assert.equal(status, 200);
  // Страница чека не запрашивалась: текст пришёл от клиента
  assert.equal(receiptCalls, 0, "при наличии text страница чека не скачивается");
  // Текст ушёл в модель как есть (без HTML-разбора)
  assert.match(geminiRequest.contents[0].parts[0].text, /VODA MINERALNA 0,5L KNJA KOM \(Ђ\)/);
  assert.deepEqual(body.items.map((i) => i.category), ["Продукты", "Продукты", "Дом"]);
});

test("ни qrUrl, ни text — понятная ошибка 400", async () => {
  resetAi();
  const { status, body } = await invoke({ body: { categories: ["Еда"] } });

  assert.equal(status, 400);
  assert.match(body.error, /qrUrl/);
  assert.match(body.error, /text/);
});

test("перегрузка моделей (503 от всех) — 3 попытки на 3 разных модели, затем «перегружен»", async () => {
  resetAi();
  geminiStatus = 503; // Google отдаёт 503 «high demand» — статус совпадает с «нет ключа», но смысл другой
  const { status, body } = await invoke({ body: { qrUrl: QR_URL, categories: ["Еда"] } });

  assert.equal(status, 503);
  assert.match(body.error, /перегружен/);
  assert.doesNotMatch(body.error, /GEMINI_API_KEY/, "это ёмкость Gemini, а не отсутствие ключа");
  assert.equal(geminiCalls, 3, "пробуем три разные модели, прежде чем сдаться");
});

test("429 (лимит 5 RPM) повторяет ту же модель с backoff, а не переключает модель", async () => {
  resetAi();
  geminiFails = 1; // первая попытка — 429
  geminiFailStatus = 429;
  const { status, body } = await invoke({ body: { qrUrl: QR_URL, categories: ["Продукты", "Дом"] } });

  assert.equal(status, 200, "после одного 429 повтор должен выстрелить");
  assert.equal(geminiCalls, 2);
  assert.deepEqual(calledModels(), ["gemini-3.8-flash", "gemini-3.8-flash"], "повтор обязан быть на той же модели");
  assert.deepEqual(body.items.map((i) => i.category), ["Продукты", "Продукты", "Дом"]);
});

test("429 во всех попытках — 429 с понятным сообщением и без перебора моделей", async () => {
  resetAi();
  geminiStatus = 429; // лимит исчерпан: и основная, и резервные модели его увидят
  const { status, body } = await invoke({ body: { qrUrl: QR_URL, categories: ["Еда"] } });

  assert.equal(status, 429);
  assert.equal(body.code, "RATE_LIMITED");
  assert.match(body.error, /Превышен лимит запросов/);
  assert.match(body.error, /30–60/);
  // 1 попытка + 2 повтора с backoff, и всё на ОДНОЙ модели: квота считается на ключ
  assert.equal(geminiCalls, 3);
  assert.equal(new Set(calledModels()).size, 1, "переключать модель при 429 бессмысленно — квота на ключ");
});

test("503 и 429 не смешиваются: 503 переключает модель, а не ждёт backoff", async () => {
  resetAi();
  geminiStatus = 503; // «high demand» — ротация моделей
  const { status } = await invoke({ body: { qrUrl: QR_URL, categories: ["Еда"] } });

  assert.equal(status, 503, "исчерпание моделей по 503 -> сообщение о перегрузе");
  assert.deepEqual(calledModels(), ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"]);
});

test("снятая с продажи модель (404) — уходим на резервную модель и всё равно разбираем чек", async () => {
  resetAi();
  geminiFails = 1; // первая (основная) модель отвечает 404
  geminiFailStatus = 404;
  const { status, body } = await invoke({ body: { qrUrl: QR_URL, categories: ["Продукты", "Дом"] } });

  assert.equal(status, 200, "снятая модель не должна ломать распознавание — есть резервная");
  assert.equal(geminiCalls, 2, "вторая попытка идёт на другой модели");
  assert.match(geminiUrl, /models\/gemini-3\.7-flash/, "повтор делаем на резервной модели");
  assert.deepEqual(body.items.map((i) => i.category), ["Продукты", "Продукты", "Дом"]);
});

test("снятая с продажи модель у ВСЕХ моделей — 503 с подсказкой про настройки", async () => {
  resetAi();
  geminiStatus = 404; // 404 и на основной, и на резервных — чинить нечем
  const { status, body } = await invoke({ body: { qrUrl: QR_URL, categories: ["Еда"] } });

  assert.equal(status, 503);
  assert.match(body.error, /GEMINI_MODEL/);
  assert.equal(geminiCalls, 3, "пробуем всю цепочку моделей, дальше — подсказка пользователю");
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

