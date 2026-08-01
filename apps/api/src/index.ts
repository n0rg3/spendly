import { createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
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

declare module "fastify" {
  interface FastifyRequest {
    user: { id: string; telegramId: string; createdAt: Date };
    dashboard: Dashboard;
  }
}

await app.listen({ port: 3001, host: "0.0.0.0" });