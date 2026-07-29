import { InlineKeyboard } from "grammy";
import { bot } from "../bot.js";
import { db } from "@sp3ndly/database";
import { getOrCreateUser } from "../utils/getOrCreateUser.js";

// Хранилище временных данных: telegramId -> { categoryName, amount, description }
export const pendingExpenses = new Map<
  string, 
  { categoryName: string; amount: number; description?: string }
>();

bot.on("message:text", async (ctx) => {
  try {
    const fromId = ctx.from?.id;
    if (!fromId) return;

    const text = ctx.message.text.trim();
    const telegramId = String(fromId);

    // Пропускаем команды
    if (text.startsWith("/")) return;

    // Парсим: "категория описание сумма" или "категория сумма"
    const parts = text.split(/\s+/);
    if (parts.length < 2) return; // Пропускаем невалидный ввод

    // Последняя часть — сумма
    const amountStr = parts[parts.length - 1]!.replace(",", ".");
    const amount = Number(amountStr);
    if (isNaN(amount) || amount <= 0) return;

    // Первая часть — категория
    const categoryName = parts[0]!;

    // Всё между категорией и суммой — описание
    const description = parts.length > 2
      ? parts.slice(1, -1).join(" ")
      : undefined;

    const user = await getOrCreateUser(telegramId);

    // Поиск категории БЕЗ учета регистра (mode: "insensitive")
    const category = await db.category.findFirst({
      where: {
        name: { equals: categoryName, mode: "insensitive" },
        userId: user.id,
      },
    });

    if (!category) {
      // Сохраняем временные данные в Map, чтобы не превысить 64 байта в callback_data кнопки!
      pendingExpenses.set(telegramId, { categoryName, amount, description });

      const createKeyboard = new InlineKeyboard()
        .text(`✅ Создать "${categoryName}"`, "confirm_create_category")
        .text("❌ Отмена", "cancel_create_category");

      return await ctx.reply(
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

    const descStr = description ? ` (${description})` : "";
    return await ctx.reply(`✅ ${category.name}${descStr}: ${amount} 💸`);

  } catch (error) {
    console.error("Ошибка при обработке сообщения:", error);
    return await ctx.reply("⚠️ Ошибка при записи. Проверьте консоль.");
  }
}); 