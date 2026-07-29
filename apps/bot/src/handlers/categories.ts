import { bot } from "../bot.js";
import { db } from "@sp3ndly/database";
import { getOrCreateUser } from "../utils/getOrCreateUser.js";
import { pendingExpenses } from "./text.js"; // Импортируем наше хранилище

// 1. Команда /addcat Название
bot.command("addcat", async (ctx) => {
  try {
    const rawName = ctx.match.trim();

    if (!rawName) {
      return await ctx.reply("Используй: /addcat Еда");
    }

    const fromId = ctx.from?.id;
    if (!fromId) return;

    const user = await getOrCreateUser(String(fromId));

    // Приводим к красивому виду: Первая буква заглавная, остальные строчные ("еда" -> "Еда")
    const categoryName = rawName.charAt(0).toUpperCase() + rawName.slice(1);

    // Проверяем, нет ли уже такой категории
    const existing = await db.category.findFirst({
      where: {
        name: { equals: categoryName, mode: "insensitive" },
        userId: user.id,
      },
    });

    if (existing) {
      return await ctx.reply(`Категория "${existing.name}" уже существует!`);
    }

    // Сохраняем категорию
    await db.category.create({
      data: {
        name: categoryName,
        userId: user.id,
      },
    });

    return await ctx.reply(`✅ Категория "${categoryName}" добавлена`);
  } catch (error) {
    console.error("Ошибка в /addcat:", error);
    return await ctx.reply("⚠️ Не удалось добавить категорию.");
  }
});

// 2. Обработчик создания категории из инлайн-кнопки
bot.callbackQuery("confirm_create_category", async (ctx) => {
  try {
    const fromId = ctx.from?.id;
    if (!fromId) return;

    const telegramId = String(fromId);
    const pending = pendingExpenses.get(telegramId);

    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Сессия истекла" });
      return await ctx.editMessageText("⏱ Время ожидания истекло. Напишите расход заново.");
    }

    const user = await getOrCreateUser(telegramId);

    // Делаем красивое имя с Заглавной буквы
    const formattedCategoryName = 
      pending.categoryName.charAt(0).toUpperCase() + pending.categoryName.slice(1);

    // Создаём категорию
    const category = await db.category.create({
      data: {
        name: formattedCategoryName,
        userId: user.id,
      },
    });

    // Сохраняем расход
    await db.expense.create({
      data: {
        amount: pending.amount,
        description: pending.description,
        categoryId: category.id,
        userId: user.id,
      },
    });

    // Очищаем временную запись
    pendingExpenses.delete(telegramId);

    const descStr = pending.description ? ` (${pending.description})` : "";
    
    await ctx.answerCallbackQuery();
    return await ctx.editMessageText(`✅ ${category.name}${descStr}: ${pending.amount} 💸`);

  } catch (error) {
    console.error("Ошибка при подтверждении создания категории:", error);
    return await ctx.reply("⚠️ Не удалось создать категорию.");
  }
});

// 3. Обработчик отмены
bot.callbackQuery("cancel_create_category", async (ctx) => {
  const fromId = ctx.from?.id;
  if (fromId) {
    pendingExpenses.delete(String(fromId));
  }
  await ctx.answerCallbackQuery();
  return await ctx.editMessageText("❌ Отменено");
});