import { createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import * as cheerio from "cheerio";
import { firestore } from "./firebase.js";

type Category = { id: string; name: string; icon: string | null; color: string | null };
type Expense = { id: string; amount: number; description: string | null; createdAt: string; category: Category | null };
type SavingsGoal = {
  id: string;
  name: string;
  targetAmount: number;
  savedAmount: number;
  icon: string | null;
  color: string | null;
  createdAt: string;
};
type Dashboard = { categories: Category[]; expenses: Expense[]; totalSpent: number; userCreatedAt: string; savingsGoals: SavingsGoal[] };

const configuredBotToken = process.env.BOT_TOKEN;
const developmentUserId = process.env.DEV_TELEGRAM_USER_ID;

if (!configuredBotToken) {
  throw new Error("BOT_TOKEN is not set");
}

const botToken = configuredBotToken;

type TelegramUser = { id: number };

function validateInitData(initData: string): TelegramUser {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  const userJson = params.get("user");

  if (!hash || !authDate || !userJson) {
    throw new Error("Telegram authorization data is incomplete");
  }

  if (Date.now() / 1000 - authDate > 86_400) {
    throw new Error("Telegram authorization data has expired");
  }

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const signature = createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");

  const receivedHash = Buffer.from(hash, "hex");
  const expectedHash = Buffer.from(signature, "hex");
  if (
    receivedHash.length !== expectedHash.length ||
    !timingSafeEqual(receivedHash, expectedHash)
  ) {
    throw new Error("Telegram authorization data has an invalid signature");
  }

  return JSON.parse(userJson) as TelegramUser;
}

async function getTelegramUser(request: FastifyRequest): Promise<TelegramUser> {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("tma ")) {
    return validateInitData(authorization.slice(4));
  }

  if (process.env.NODE_ENV !== "production" && developmentUserId) {
    return { id: Number(developmentUserId) };
  }

  throw new Error("Telegram authorization is required");
}

const DEFAULT_DASHBOARD: Dashboard = {
  categories: [
    { id: "1", name: "Еда", icon: "food", color: "#3390ec" },
    { id: "2", name: "Транспорт", icon: "transport", color: "#2cb074" },
    { id: "3", name: "Покупки", icon: "shopping", color: "#f7a200" },
  ],
  expenses: [],
  totalSpent: 0,
  userCreatedAt: new Date().toISOString(),
  savingsGoals: [],
};

async function getOrCreateDashboard(telegramId: string): Promise<{ id: string; telegramId: string } & Dashboard> {
  const userDocRef = firestore.collection("users").doc(telegramId);
  const docSnap = await userDocRef.get();

  if (!docSnap.exists) {
    await userDocRef.set(DEFAULT_DASHBOARD);
    return { id: telegramId, telegramId, ...DEFAULT_DASHBOARD };
  }

  const data = docSnap.data() as Dashboard;
  return { id: telegramId, telegramId, ...data };
}

const app = Fastify({ logger: true });

// CORS: разрешённые источники для мини-аппа (GitHub Pages, локальная разработка,
// ngrok-туннели — задаются через CORS_ORIGINS через запятую)
const allowedOrigins = [
  "https://n0rg3.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
];

await app.register(cors, {
  origin: (origin, callback) => {
    // Запросы без Origin (curl, мобильный клиент, сервер-сервер) — разрешаем
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    app.log.warn({ origin }, "Blocked by CORS");
    callback(new Error("Origin not allowed by CORS"), false);
  },
});

app.get("/api/health", async () => ({ ok: true }));

app.addHook("preHandler", async (request, reply) => {
  if (request.url === "/api/health") return;

  try {
    const telegramUser = await getTelegramUser(request);
    const dashboard = await getOrCreateDashboard(String(telegramUser.id));
    request.user = {
      id: dashboard.id,
      telegramId: dashboard.telegramId,
      createdAt: new Date(dashboard.userCreatedAt),
    };
    request.dashboard = dashboard;
  } catch (error) {
    return reply.code(401).send({
      error: error instanceof Error ? error.message : "Unauthorized",
    });
  }
});

app.get<{ Querystring: { month?: string } }>("/api/dashboard", async (request, reply) => {
  const month = request.query.month;
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return reply.code(400).send({ error: "Некорректный месяц" });
  }

  const dashboard = request.dashboard;

  if (month) {
    const filteredExpenses = dashboard.expenses.filter((e) => {
      if (!e.createdAt) return false;
      return e.createdAt.startsWith(month);
    });

  return {
    categories: dashboard.categories,
    expenses: filteredExpenses,
    totalSpent: filteredExpenses.reduce((sum, e) => sum + e.amount, 0),
    userCreatedAt: dashboard.userCreatedAt,
    savingsGoals: dashboard.savingsGoals ?? [],
  };
  }

  return {
    categories: dashboard.categories,
    expenses: dashboard.expenses,
    totalSpent: dashboard.totalSpent,
    userCreatedAt: dashboard.userCreatedAt,
    savingsGoals: dashboard.savingsGoals ?? [],
  };
});

app.post<{ Body: { name?: string; color?: string } }>(
  "/api/categories",
  async (request, reply) => {
    const name = request.body.name?.trim();
    if (!name || name.length > 50) {
      return reply.code(400).send({ error: "Название категории: от 1 до 50 символов" });
    }

    const dashboard = request.dashboard;
    const userDocRef = firestore.collection("users").doc(request.user.telegramId);

    const newCategory: Category = {
      id: String(Date.now()),
      name,
      icon: null,
      color: request.body.color?.trim() || null,
    };

    const updated: Dashboard = {
      ...dashboard,
      categories: [...dashboard.categories, newCategory],
    };

    await userDocRef.set(updated);

    return reply.code(201).send(newCategory);
  },
);

app.patch<{ Params: { id: string }; Body: { name?: string; color?: string } }>(
  "/api/categories/:id",
  async (request, reply) => {
    const name = request.body.name?.trim();
    if (!name || name.length > 50) {
      return reply.code(400).send({ error: "Название категории: от 1 до 50 символов" });
    }

    const dashboard = request.dashboard;
    const category = dashboard.categories.find((c) => c.id === request.params.id);
    if (!category) return reply.code(404).send({ error: "Категория не найдена" });

    const userDocRef = firestore.collection("users").doc(request.user.telegramId);

    const updatedCategories = dashboard.categories.map((c) =>
      c.id === request.params.id
        ? { ...c, name, color: request.body.color?.trim() || null }
        : c
    );

    // Обновляем ссылку на категорию во всех привязанных тратах
    const updatedExpenses = dashboard.expenses.map((e) => {
      if (e.category?.id === request.params.id) {
        return { ...e, category: { ...e.category, name, color: request.body.color?.trim() || null } };
      }
      return e;
    });

    const updated: Dashboard = {
      ...dashboard,
      categories: updatedCategories,
      expenses: updatedExpenses,
    };

    await userDocRef.set(updated);

    return updatedCategories.find((c) => c.id === request.params.id);
  },
);

app.delete<{ Params: { id: string } }>(
  "/api/categories/:id",
  async (request, reply) => {
    const dashboard = request.dashboard;
    const category = dashboard.categories.find((c) => c.id === request.params.id);
    if (!category) return reply.code(404).send({ error: "Категория не найдена" });

    const userDocRef = firestore.collection("users").doc(request.user.telegramId);

    const updatedCategories = dashboard.categories.filter((c) => c.id !== request.params.id);
    // Убираем категорию из расходов
    const updatedExpenses = dashboard.expenses.map((e) =>
      e.category?.id === request.params.id ? { ...e, category: null } : e
    );

    const updated: Dashboard = {
      ...dashboard,
      categories: updatedCategories,
      expenses: updatedExpenses,
    };

    await userDocRef.set(updated);

    return reply.code(204).send();
  },
);

app.get("/api/goals", async (request, reply) => {
  return reply.send(request.dashboard.savingsGoals ?? []);
});

app.post<{ Body: { name?: string; targetAmount?: number; icon?: string; color?: string } }>(
  "/api/goals",
  async (request, reply) => {
    const name = request.body.name?.trim();
    const targetAmount = request.body.targetAmount;

    if (!name || name.length > 50) {
      return reply.code(400).send({ error: "Название цели: от 1 до 50 символов" });
    }
    if (!Number.isFinite(targetAmount) || !targetAmount || targetAmount <= 0) {
      return reply.code(400).send({ error: "Укажите целевую сумму больше нуля" });
    }

    const dashboard = request.dashboard;
    const userDocRef = firestore.collection("users").doc(request.user.telegramId);

    const newGoal: SavingsGoal = {
      id: String(Date.now()),
      name,
      targetAmount,
      savedAmount: 0,
      icon: request.body.icon?.trim() || null,
      color: request.body.color?.trim() || null,
      createdAt: new Date().toISOString(),
    };

    const updated: Dashboard = {
      ...dashboard,
      savingsGoals: [...(dashboard.savingsGoals ?? []), newGoal],
    };

    await userDocRef.set(updated);

    return reply.code(201).send(newGoal);
  },
);

app.patch<{ Params: { id: string }; Body: { name?: string; targetAmount?: number; icon?: string; color?: string } }>(
  "/api/goals/:id",
  async (request, reply) => {
    const dashboard = request.dashboard;
    const goal = (dashboard.savingsGoals ?? []).find((g) => g.id === request.params.id);
    if (!goal) return reply.code(404).send({ error: "Цель не найдена" });

    const name = request.body.name?.trim();
    const targetAmount = request.body.targetAmount;

    if (name !== undefined && (!name || name.length > 50)) {
      return reply.code(400).send({ error: "Название цели: от 1 до 50 символов" });
    }
    if (targetAmount !== undefined && (!Number.isFinite(targetAmount) || targetAmount <= 0)) {
      return reply.code(400).send({ error: "Укажите целевую сумму больше нуля" });
    }

    const userDocRef = firestore.collection("users").doc(request.user.telegramId);

    const updatedGoals = (dashboard.savingsGoals ?? []).map((g) =>
      g.id === request.params.id
        ? {
            ...g,
            ...(name !== undefined ? { name } : {}),
            ...(targetAmount !== undefined ? { targetAmount } : {}),
            ...(request.body.icon !== undefined ? { icon: request.body.icon.trim() || null } : {}),
            ...(request.body.color !== undefined ? { color: request.body.color.trim() || null } : {}),
          }
        : g
    );

    const updated: Dashboard = {
      ...dashboard,
      savingsGoals: updatedGoals,
    };

    await userDocRef.set(updated);

    return updatedGoals.find((g) => g.id === request.params.id);
  },
);

app.post<{ Params: { id: string }; Body: { amount?: number; mode?: "topup" | "withdraw" } }>(
  "/api/goals/:id/transactions",
  async (request, reply) => {
    const dashboard = request.dashboard;
    const goal = (dashboard.savingsGoals ?? []).find((g) => g.id === request.params.id);
    if (!goal) return reply.code(404).send({ error: "Цель не найдена" });

    const amount = request.body.amount;
    const mode = request.body.mode ?? "topup";

    if (!Number.isFinite(amount) || !amount || amount <= 0) {
      return reply.code(400).send({ error: "Укажите сумму больше нуля" });
    }
    if (mode !== "topup" && mode !== "withdraw") {
      return reply.code(400).send({ error: "Некорректный режим операции" });
    }

    const userDocRef = firestore.collection("users").doc(request.user.telegramId);

    const updatedGoals = (dashboard.savingsGoals ?? []).map((g) =>
      g.id === request.params.id
        ? { ...g, savedAmount: mode === "topup" ? g.savedAmount + amount : Math.max(0, g.savedAmount - amount) }
        : g
    );

    const updated: Dashboard = {
      ...dashboard,
      savingsGoals: updatedGoals,
    };

    await userDocRef.set(updated);

    return updatedGoals.find((g) => g.id === request.params.id);
  },
);

app.delete<{ Params: { id: string } }>(
  "/api/goals/:id",
  async (request, reply) => {
    const dashboard = request.dashboard;
    const goal = (dashboard.savingsGoals ?? []).find((g) => g.id === request.params.id);
    if (!goal) return reply.code(404).send({ error: "Цель не найдена" });

    const userDocRef = firestore.collection("users").doc(request.user.telegramId);

    const updatedGoals = (dashboard.savingsGoals ?? []).filter((g) => g.id !== request.params.id);

    const updated: Dashboard = {
      ...dashboard,
      savingsGoals: updatedGoals,
    };

    await userDocRef.set(updated);

    return reply.code(204).send();
  },
);

app.post<{ Body: { amount?: number; description?: string; categoryId?: string } }>(
  "/api/expenses",
  async (request, reply) => {
    const { amount, categoryId } = request.body;
    const description = request.body.description?.trim();

    if (!Number.isFinite(amount) || !amount || amount <= 0) {
      return reply.code(400).send({ error: "Укажите сумму больше нуля" });
    }

    if (description && description.length > 300) {
      return reply.code(400).send({ error: "Описание не должно быть длиннее 300 символов" });
    }

    const dashboard = request.dashboard;

    let category: Category | null = null;
    if (categoryId) {
      category = dashboard.categories.find((c) => c.id === categoryId) || null;
      if (!category) {
        return reply.code(400).send({ error: "Категория не найдена" });
      }
    }

    const userDocRef = firestore.collection("users").doc(request.user.telegramId);

    const newExpense: Expense = {
      id: String(Date.now()),
      amount,
      description: description || null,
      createdAt: new Date().toISOString(),
      category: category ? { id: category.id, name: category.name, icon: category.icon, color: category.color } : null,
    };

    const newExpenses = [newExpense, ...dashboard.expenses];
    const updated: Dashboard = {
      ...dashboard,
      expenses: newExpenses,
      totalSpent: newExpenses.reduce((sum, e) => sum + e.amount, 0),
    };

    await userDocRef.set(updated);

    return reply.code(201).send(newExpense);
  },
);

app.patch<{
  Params: { id: string };
  Body: { amount?: number; description?: string; categoryId?: string; createdAt?: string };
}>("/api/expenses/:id", async (request, reply) => {
  const { amount, categoryId } = request.body;
  const description = request.body.description?.trim();
  const createdAt = request.body.createdAt ? new Date(request.body.createdAt) : undefined;

  if (!Number.isFinite(amount) || !amount || amount <= 0) {
    return reply.code(400).send({ error: "Укажите сумму больше нуля" });
  }
  if (description && description.length > 300) {
    return reply.code(400).send({ error: "Описание не должно быть длиннее 300 символов" });
  }
  if (createdAt && Number.isNaN(createdAt.getTime())) {
    return reply.code(400).send({ error: "Укажите корректные дату и время" });
  }

  const dashboard = request.dashboard;
  const expense = dashboard.expenses.find((e) => e.id === request.params.id);
  if (!expense) return reply.code(404).send({ error: "Трата не найдена" });

  let category: Category | null = expense.category;
  if (categoryId !== undefined) {
    if (categoryId) {
      category = dashboard.categories.find((c) => c.id === categoryId) || null;
      if (!category) return reply.code(400).send({ error: "Категория не найдена" });
    } else {
      category = null;
    }
  }

  const userDocRef = firestore.collection("users").doc(request.user.telegramId);

  const updatedExpenses = dashboard.expenses.map((e) =>
    e.id === request.params.id
      ? {
          ...e,
          amount,
          description: description || null,
          category: category ? { id: category.id, name: category.name, icon: category.icon, color: category.color } : null,
          createdAt: createdAt ? createdAt.toISOString() : e.createdAt,
        }
      : e
  );

  const updated: Dashboard = {
    ...dashboard,
    expenses: updatedExpenses,
    totalSpent: updatedExpenses.reduce((sum, e) => sum + e.amount, 0),
  };

  await userDocRef.set(updated);

  return updatedExpenses.find((e) => e.id === request.params.id);
});

// ===== Распознавание сербских e-чеков (suf.purs.gov.rs) целиком через Gemini =====
// Разбор позиций и автокатегоризация выполняются ОДНИМ вызовом LLM
// (Gemini 2.5 Flash, Structured Outputs / responseSchema): API только скачивает
// страницу чека и передаёт модели её сырой текст. Регэкспов для позиций, словарей
// и кэша «товар -> категория» больше нет.
type ReceiptItem = { name: string; qty: number; price: number; total: number };
type CategorizedReceiptItem = ReceiptItem & { category: string | null };
type ParsedReceipt = { dateTime: string | null; items: CategorizedReceiptItem[]; total: number };

const RECEIPT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Список категорий из ТЗ — используется, если клиент не передал свои
const DEFAULT_RECEIPT_CATEGORIES = ["Продукты", "Тусичи", "Дом", "Транспорт", "Развлечения", "Остальное"];

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Модель по умолчанию: Structured Outputs поддерживает Gemini 2.5 Flash
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Страница чека может быть большой; модели достаточно текста покупки
const MAX_RECEIPT_TEXT_LENGTH = 20_000;

// Системная инструкция: правила разбора чека и категоризации
const RECEIPT_SYSTEM_INSTRUCTION = [
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

// Схема ответа модели: фиксирует JSON, который всегда возвращает Gemini
function buildReceiptResponseSchema(categoriesList: string[]) {
  return {
    type: "object",
    properties: {
      dateTime: { type: "string", format: "date-time", nullable: true, description: "Дата и время покупки в формате ISO 8601" },
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
            category: { type: "string", nullable: true, enum: categoriesList, description: "Категория из списка допустимых или null" },
          },
          required: ["name", "qty", "price", "total", "category"],
        },
      },
    },
    required: ["dateTime", "total", "items"],
  };
}

// Сырой текст чека: убираем скрипты и стили, оставляем видимый текст страницы.
// Позиции на сервере не разбираем — это делает модель.
function extractReceiptText(html: string): string {
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

// Ответ модели (сырой JSON по схеме)
type GeminiReceiptPayload = {
  dateTime?: unknown;
  total?: unknown;
  items?: { name?: unknown; qty?: unknown; price?: unknown; total?: unknown; category?: unknown }[];
};

// Ответ модели -> формат API: числа числами, категория только из списка пользователя
function normalizeReceipt(payload: GeminiReceiptPayload, categoriesList: string[]): ParsedReceipt {
  const allowed = new Set(categoriesList);
  const rawItems = Array.isArray(payload.items) ? payload.items : [];

  const items: CategorizedReceiptItem[] = rawItems
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
    .filter((item) => item.name.length > 0 && item.total > 0);

  const total = Number(payload.total);
  return {
    dateTime: typeof payload.dateTime === "string" && payload.dateTime ? payload.dateTime : null,
    items,
    total: Number.isFinite(total) ? total : items.reduce((sum, item) => sum + item.total, 0),
  };
}

// Единственный вызов LLM: разбор позиций + категоризация + дата и итог чека
async function parseReceiptWithGemini(
  receiptText: string,
  categoriesList: string[],
): Promise<ParsedReceipt> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY не задан — распознавание чеков недоступно");
  }

  const prompt = [
    `Допустимые категории: ${JSON.stringify(categoriesList)}`,
    "Сырой текст чека:",
    receiptText,
  ].join("\n");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: RECEIPT_SYSTEM_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: buildReceiptResponseSchema(categoriesList),
        },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini вернул ошибку: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const raw = payload.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  return normalizeReceipt(JSON.parse(raw) as GeminiReceiptPayload, categoriesList);
}

app.post<{ Body: { qrUrl?: string; categories?: string[] } }>("/api/receipts/parse", async (request, reply) => {
  const qrUrl = request.body?.qrUrl?.trim();
  if (!qrUrl) {
    return reply.code(400).send({ error: "Передайте URL чека из QR-кода (qrUrl)" });
  }

  // Валидация URL: только https и только домен налоговой Сербии
  let url: URL;
  try {
    url = new URL(qrUrl);
  } catch {
    return reply.code(400).send({ error: "Некорректный URL чека" });
  }
  if (url.protocol !== "https:" || !/^(?:[a-z0-9-]+\.)*purs\.gov\.rs$/.test(url.hostname)) {
    return reply.code(400).send({ error: "URL должен вести на suf.purs.gov.rs (сербский e-чек)" });
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": RECEIPT_USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    request.log.error(error, "Failed to fetch receipt page");
    return reply.code(502).send({ error: "Сайт чека недоступен, попробуйте позже" });
  }

  if (!response.ok) {
    return reply.code(502).send({ error: `Сайт чека вернул ошибку: HTTP ${response.status}` });
  }

  // Сырой текст страницы чека -> единственный вызов Gemini (разбор + категоризация)
  const receiptText = extractReceiptText(await response.text());
  if (!receiptText) {
    return reply.code(422).send({ error: "Не удалось распознать структуру чека" });
  }

  // Категории пользователя опциональны; по умолчанию — фиксированный список из ТЗ
  const categoriesList =
    Array.isArray(request.body?.categories) && request.body.categories.length > 0
      ? request.body.categories.map(String)
      : DEFAULT_RECEIPT_CATEGORIES;

  try {
    const receipt = await parseReceiptWithGemini(receiptText, categoriesList);
    if (receipt.items.length === 0) {
      return reply.code(422).send({ error: "Не удалось распознать структуру чека" });
    }
    return reply.send(receipt);
  } catch (error) {
    request.log.error(error, "Gemini receipt parsing failed");
    return reply.code(503).send({ error: "Сервис распознавания чеков временно недоступен" });
  }
});

declare module "fastify" {
  interface FastifyRequest {
    user: { id: string; telegramId: string; createdAt: Date };
    dashboard: Dashboard;
  }
}

await app.listen({ port: 3001, host: "0.0.0.0" });