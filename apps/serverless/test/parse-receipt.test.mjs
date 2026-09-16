// Автотесты serverless-функции (встроенный node:test, без внешних зависимостей).
// Запуск: pnpm --filter @sp3ndly/serverless test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import handler from "../api/parse-receipt.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const receiptHtml = readFileSync(join(fixturesDir, "receipt.html"), "utf-8");

const realFetch = globalThis.fetch;
// Подменяем только запрос к сайту чека: https://suf.purs.gov.rs/... -> локальная фикстура
globalThis.fetch = async (url, options) => {
  if (String(url).includes("purs.gov.rs")) {
    return { ok: true, status: 200, text: async () => receiptHtml };
  }
  return realFetch(url, options);
};

after(() => {
  globalThis.fetch = realFetch;
});

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

test("парсит позиции чека (название в отдельной строке от чисел)", async () => {
  const { status, body } = await invoke({ body: { qrUrl: QR_URL } });

  assert.equal(status, 200);
  assert.equal(body.dateTime, "16.9.2026. 17:50:44");
  assert.equal(body.items.length, 3);
  assert.deepEqual(
    body.items.map((i) => i.name),
    ["BOMBONE HARIBO STAR MIX  KOM (Ђ)", "VODA MINERALNA 0,5L KNJA KOM (Ђ)", "KESA (Ђ)"],
  );
  assert.deepEqual(body.items.map((i) => i.total), [134.99, 57.99, 2]);
  // сумма с плавающей точкой: 134.99 + 57.99 + 2
  assert.ok(Math.abs(body.total - 194.98) < 1e-9, `total = ${body.total}`);
});

test("без GEMINI_API_KEY возвращает category: null (парсинг не ломается)", async () => {
  delete process.env.GEMINI_API_KEY;
  const { status, body } = await invoke({ body: { qrUrl: QR_URL } });

  assert.equal(status, 200);
  assert.ok(body.items.every((item) => item.category === null));
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