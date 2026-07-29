import { createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import { db } from "@sp3ndly/database";

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

const app = Fastify({ logger: true });

app.get("/api/health", async () => ({ ok: true }));

app.addHook("preHandler", async (request, reply) => {
  if (request.url === "/api/health") return;

  try {
    const telegramUser = await getTelegramUser(request);
    request.user = await db.user.upsert({
      where: { telegramId: String(telegramUser.id) },
      update: {},
      create: { telegramId: String(telegramUser.id) },
    });
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

  const dateFilter = month
    ? {
        gte: new Date(`${month}-01T00:00:00`),
        lt: new Date(new Date(`${month}-01T00:00:00`).setMonth(new Date(`${month}-01T00:00:00`).getMonth() + 1)),
      }
    : undefined;
  const expenseWhere = { userId: request.user.id, ...(dateFilter ? { createdAt: dateFilter } : {}) };
  const [categories, expenses, totals] = await Promise.all([
    db.category.findMany({
      where: { userId: request.user.id },
      orderBy: { name: "asc" },
    }),
    db.expense.findMany({
      where: expenseWhere,
      include: { category: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    db.expense.aggregate({ where: expenseWhere, _sum: { amount: true } }),
  ]);

  return {
    categories,
    expenses,
    totalSpent: totals._sum.amount ?? 0,
    userCreatedAt: request.user.createdAt.toISOString(),
  };
});

app.post<{ Body: { name?: string; color?: string } }>(
  "/api/categories",
  async (request, reply) => {
    const name = request.body.name?.trim();
    if (!name || name.length > 50) {
      return reply.code(400).send({ error: "Название категории: от 1 до 50 символов" });
    }

    return db.category.create({
      data: {
        name,
        color: request.body.color?.trim() || null,
        userId: request.user.id,
      },
    });
  },
);

app.patch<{ Params: { id: string }; Body: { name?: string; color?: string } }>(
  "/api/categories/:id",
  async (request, reply) => {
    const name = request.body.name?.trim();
    if (!name || name.length > 50) {
      return reply.code(400).send({ error: "Название категории: от 1 до 50 символов" });
    }

    const category = await db.category.findFirst({
      where: { id: request.params.id, userId: request.user.id },
    });
    if (!category) return reply.code(404).send({ error: "Категория не найдена" });

    return db.category.update({
      where: { id: category.id },
      data: { name, color: request.body.color?.trim() || null },
    });
  },
);

app.delete<{ Params: { id: string } }>(
  "/api/categories/:id",
  async (request, reply) => {
    const category = await db.category.findFirst({
      where: { id: request.params.id, userId: request.user.id },
    });
    if (!category) return reply.code(404).send({ error: "Категория не найдена" });

    await db.category.delete({ where: { id: category.id } });
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

    if (categoryId) {
      const category = await db.category.findFirst({
        where: { id: categoryId, userId: request.user.id },
      });
      if (!category) {
        return reply.code(400).send({ error: "Категория не найдена" });
      }
    }

    return db.expense.create({
      data: {
        amount,
        description: description || null,
        categoryId: categoryId || null,
        userId: request.user.id,
      },
      include: { category: true },
    });
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

  const expense = await db.expense.findFirst({
    where: { id: request.params.id, userId: request.user.id },
  });
  if (!expense) return reply.code(404).send({ error: "Трата не найдена" });

  if (categoryId) {
    const category = await db.category.findFirst({
      where: { id: categoryId, userId: request.user.id },
    });
    if (!category) return reply.code(400).send({ error: "Категория не найдена" });
  }

  return db.expense.update({
    where: { id: expense.id },
    data: {
      amount,
      description: description || null,
      categoryId: categoryId || null,
      ...(createdAt ? { createdAt } : {}),
    },
    include: { category: true },
  });
});

declare module "fastify" {
  interface FastifyRequest {
    user: { id: string; telegramId: string; createdAt: Date };
  }
}

await app.listen({ port: 3001, host: "0.0.0.0" });
