import { InlineKeyboard } from "grammy";
import { bot } from "../bot.js";
import { db } from "@sp3ndly/database";
import { getOrCreateUser } from "../utils/getOrCreateUser.js";

// Хранилище временных данных: telegramId -> { amount, description }
const pendingExpenses = new Map<string, { amount: number; description: string | undefined }>();

bot.on("message:text", async (ctx) => {
  const fromId = ctx.from?.id;
  if (!fromId) return;

  const text = ctx.message.text.trim();
  const telegramId = String(fromId);

  // Проверяем, не ждёт ли пользователь выбора категории
  const pending = pendingExpenses.get(telegramId);
  if (pending) {
    // Пользователь выбрал категорию из инлайн-кнопок — обрабатывается в categories.ts
    return;
  }

  // Парсим: "категория описание сумма" или "категория сумма"
  const parts = text.split(" ");
  if (parts.length < 2) {
    return; // невалидный формат, игнорируем
  }

  // Последняя часть — сумма
  const amountStr = parts[parts.length - 1];
  const amount = Number(amountStr);
  if (isNaN(amount) || amount <= 0) {
    return; // невалидная сумма, игнорируем
  }

  // Первая часть — категория
  const categoryName = parts[0];

  // Всё между категорией и суммой — описание (если есть)
  const description = parts.length > 2
    ? parts.slice(1, -1).join(" ")
    : undefined;

  const user = await getOrCreateUser(telegramId);

  // Ищем категорию пользователя
  const category = await db.category.findFirst({
    where: { name: categoryName, userId: user.id },
  });

  if (!category) {
    // Категория не найдена — предлагаем создать
    const createKeyboard = new InlineKeyboard()
      .text(`✅ Создать "${categoryName}"`, `create_category:${categoryName}:${amount}:${description ?? ""}`)
      .text("❌ Отмена", "cancel");

    return ctx.reply(
      `Категория "${categoryName}" не найдена. Создать?`,
      { reply_markup: createKeyboard },
    );
  }

  // Сохраняем расход
  await db.expense.create({
    data: {
      amount,
      description,
      categoryId: category.id,
      userId: user.id,
    },
  });

  const descStr = description ? ` ${description}` : "";
  return ctx.reply(`✅ ${category.name}${descStr}: ${amount} 💸`);
});