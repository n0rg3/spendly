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

// ===== Парсинг сербских e-чеков (suf.purs.gov.rs) =====
type ReceiptItem = { name: string; qty: number; price: number; total: number };
type ParsedReceipt = { dateTime: string | null; items: ReceiptItem[]; total: number };

const RECEIPT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Числа в сербском формате: 1.234,56 (точка — тысячи, запятая — дробная часть)
function parseSerbianNumber(raw: string): number {
  const cleaned = raw.replace(/[^\d.,-]/g, "").trim();
  if (!cleaned) return NaN;
  const normalized = cleaned.includes(",")
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned.replace(/,/g, "");
  return Number.parseFloat(normalized);
}

function parseReceiptHtml(html: string): ParsedReceipt {
  const $ = cheerio.load(html);

  // Дата и время покупки: приоритетно #sdcDateTimeLabel, затем #sdcDateTime, затем поиск по тексту
  let dateTime: string | null = $("#sdcDateTimeLabel").text().trim() || $("#sdcDateTime").text().trim() || null;
  if (!dateTime) {
    const bodyText = $("body").text();
    const dateMatch = bodyText.match(/\d{1,2}\.\d{1,2}\.\d{4}\.?\s+\d{1,2}:\d{2}(?::\d{2})?/);
    dateTime = dateMatch ? dateMatch[0] : null;
  }

  // Числа в тексте чека заканчиваются сербским десятичным: "134,99" (или "1.234,56")
  const looksLikeNumber = (value: string): boolean => /^[\d.,]+$/.test(value) && /\d/.test(value);

  const items: ReceiptItem[] = [];

  // Способ 1: строки таблицы спецификации (если Knockout отрендерил их на сервере)
  $("table.invoice-table tr, table.invoice-table tbody tr").each((_, row) => {
    const cells = $(row)
      .find("td")
      .map((__, cell) => $(cell).text().trim())
      .get();

    if (cells.length < 4) return;
    const totalRaw = cells[3] ?? "";
    const qtyRaw = cells[1] ?? "";
    const priceRaw = cells[2] ?? "";
    const name = cells[0] ?? "";

    const total = parseSerbianNumber(totalRaw);
    if (!Number.isFinite(total)) return;

    const qty = parseSerbianNumber(qtyRaw);
    const price = parseSerbianNumber(priceRaw);

    items.push({
      name,
      qty: Number.isFinite(qty) ? qty : 1,
      price: Number.isFinite(price) ? price : total,
      total,
    });
  });

  // Способ 2 (основной на практике): текстовый дамп кассового чека в <pre> (панель #collapse3).
  // Статический HTML отдаёт таблицу товаров пустой (её рендерит Knockout.js на клиенте),
  // но дамп содержит строки вида "BOMBONE HARIBO STAR MIX  KOM (Ђ)\n 134,99 1 134,99"
  // (название, цена за ед., количество, итог) между заголовком "Назив Цена Кол. Укупно"
  // и строкой "Укупан износ".
  if (items.length === 0) {
    const receiptText = $("#collapse3 pre").text() || $("#PrintInvoice").text() || $("body").text();
    const lines = receiptText.split("\n").map((line) => line.trim()).filter(Boolean);

    let inItems = false;
    let pendingName = "";

    const pushItem = (name: string, priceRaw: string, qtyRaw: string, totalRaw: string) => {
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
        // Заголовок секции товаров: "Назив Цена Кол. Укупно" (или англ. "Name Price Qty Total")
        if (/Назив|Name/i.test(line) && /Цена|Price/i.test(line)) {
          inItems = true;
        }
        continue;
      }

      // Конец секции товаров
      if (/Укупан износ|Total amount|Порез|Tax/i.test(line)) break;
      if (/^-{3,}|={3,}/.test(line)) continue;

      // Строка из трёх чисел: "<цена> <кол-во> <итог>" (название может быть на предыдущей строке)
      const numbersMatch = line.match(/^([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)$/);
      if (numbersMatch && looksLikeNumber(numbersMatch[1] || "") && looksLikeNumber(numbersMatch[2] || "") && looksLikeNumber(numbersMatch[3] || "")) {
        const name = pendingName || line;
        pushItem(name, numbersMatch[1] || "", numbersMatch[2] || "", numbersMatch[3] || "");
        pendingName = "";
        continue;
      }

      // Строка в одну строку: "<название> <цена> <кол-во> <итог>"
      const itemMatch = line.match(/^(.+?)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)$/);
      if (itemMatch && looksLikeNumber(itemMatch[2] || "") && looksLikeNumber(itemMatch[3] || "") && looksLikeNumber(itemMatch[4] || "")) {
        pushItem(itemMatch[1] || "", itemMatch[2] || "", itemMatch[3] || "", itemMatch[4] || "");
        pendingName = "";
        continue;
      }

      // Иначе — продолжение/начало названия товара
      pendingName = pendingName ? `${pendingName} ${line}` : line;
    }
  }

  return { dateTime, items, total: items.reduce((sum, item) => sum + item.total, 0) };
}

// ===== Автокатегоризация позиций чека через Gemini =====
type CategorizedReceiptItem = ReceiptItem & { category: string | null };

// Кэш сопоставлений «товар -> категория» (экономия токенов Gemini).
// Firestore: коллекция item_category_cache, документ = telegramId,
// поле items = { [нормализованное имя товара]: название категории }.
type ItemCategoryCache = Record<string, string>;

// Нормализация имени товара: lowercase, trim, схлопывание пробелов
function normalizeItemName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

const appLog = app.log;

async function categorizeReceiptItems(
  items: ReceiptItem[],
  categoriesList: string[],
  cache: ItemCategoryCache = {},
): Promise<CategorizedReceiptItem[]> {
  // Без товаров категоризировать нечего
  if (items.length === 0) return [];

  // Сначала подставляем категории из кэша — такие позиции в Gemini не уходят
  const resolved = items.map((item) => {
    const cachedCategory = cache[normalizeItemName(item.name)] ?? null;
    return {
      item,
      cachedCategory: cachedCategory && categoriesList.includes(cachedCategory) ? cachedCategory : null,
    };
  });

  const uncached = resolved.filter((entry) => entry.cachedCategory === null);

  // Всё уже в кэше — Gemini не нужен вовсе
  if (uncached.length === 0) {
    return resolved.map(({ item, cachedCategory }) => ({ ...item, category: cachedCategory }));
  }

  // Нет ключа или списка категорий — возвращаем позиции (кэш уже применён выше)
  if (!GEMINI_API_KEY || categoriesList.length === 0) {
    return resolved.map(({ item, cachedCategory }) => ({ ...item, category: cachedCategory }));
  }

  const prompt = [
    "You are a receipt item categorizer. Assign each item to exactly one category from the provided list.",
    "If no category fits, use null.",
    "Respond with STRICT JSON only — no markdown, no explanations, no extra text.",
    "The response must be a JSON array in this exact format:",
    '[{ "name": "MLEKO 2.8%", "qty": 1, "price": 150, "total": 150, "category": "Продукты" }]',
    `Available categories: ${JSON.stringify(categoriesList)}`,
    // Важно: отправляем ТОЛЬКО позиции, которых нет в кэше
    `Items: ${JSON.stringify(uncached.map((entry) => entry.item))}`,
  ].join("\n");

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!response.ok) {
      appLog.warn({ status: response.status }, "Gemini categorization HTTP error");
      return items.map((item) => ({ ...item, category: null }));
    }

    const payload = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw = payload.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    const parsed = JSON.parse(raw) as { category?: string }[];
    const allowed = new Set(categoriesList);

    // Мержим категории от LLM: ответы приходят только для некэшированных позиций
    // (тот же порядок, что и в списке uncached), закэшированные уже проставлены
    let aiIndex = 0;
    return resolved.map(({ item, cachedCategory }) => {
      if (cachedCategory !== null) {
        return { ...item, category: cachedCategory };
      }
      const aiItem = parsed[aiIndex++];
      const aiCategory = typeof aiItem?.category === "string" ? aiItem.category : null;
      return {
        ...item,
        category: aiCategory && allowed.has(aiCategory) ? aiCategory : null,
      };
    });
  } catch (error) {
    appLog.error(error, "Gemini categorization failed");
    return items.map((item) => ({ ...item, category: null }));
  }
}

app.post<{ Body: { qrUrl?: string } }>("/api/receipts/parse", async (request, reply) => {
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

  const html = await response.text();
  const receipt = parseReceiptHtml(html);

  if (!receipt.dateTime && receipt.items.length === 0) {
    return reply.code(422).send({ error: "Не удалось распознать структуру чека" });
  }

  // Автокатегоризация позиций по категориям пользователя
  // 1) Читаем кэш сопоставлений «товар -> категория» из Firestore
  const cacheDocRef = firestore.collection("item_category_cache").doc(request.user.telegramId);
  const cacheDoc = await cacheDocRef.get();
  const cache = (cacheDoc.data()?.items as ItemCategoryCache | undefined) ?? {};

  // 2) В Gemini уходят только позиции, которых нет в кэше
  const categorizedItems = await categorizeReceiptItems(
    receipt.items,
    request.dashboard.categories.map((c) => c.name),
    cache,
  );

  // 3) Новые сопоставления записываем обратно в кэш
  const newEntries: ItemCategoryCache = {};
  for (const item of categorizedItems) {
    if (!item.category) continue;
    const key = normalizeItemName(item.name);
    if (!key || cache[key] === item.category) continue;
    newEntries[key] = item.category;
  }
  if (Object.keys(newEntries).length > 0) {
    // set с merge — не затирает чужие записи в документе
    await cacheDocRef.set({ items: newEntries }, { merge: true }).catch((err) => {
      appLog.error(err, "Failed to write item category cache");
    });
  }

  return reply.send({
    dateTime: receipt.dateTime,
    items: categorizedItems,
    total: receipt.total,
  });
});

declare module "fastify" {
  interface FastifyRequest {
    user: { id: string; telegramId: string; createdAt: Date };
    dashboard: Dashboard;
  }
}

await app.listen({ port: 3001, host: "0.0.0.0" });