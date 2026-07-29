import { bot } from "../bot.js";
import { db } from "@sp3ndly/database";
import { getOrCreateUser } from "../utils/getOrCreateUser.js";

bot.command("addcat", async (ctx) => {
  const name = ctx.match;

  if (!name) {
    return ctx.reply("Используй: /addcat Food");
  }

  const user = await getOrCreateUser(String(ctx.from?.id));

  // Сохраняем категорию в lowercase для регистронезависимого поиска
  await db.category.create({
    data: {
      name: name.toLowerCase(),
      userId: user.id,
    },
  });

  return ctx.reply(`Категория "${name}" добавлена`);
});

// Обработчик создания категории из инлайн-кнопки
bot.callbackQuery(/^create_category:(.+):(.+):(.*)$/, async (ctx) => {
  const match = ctx.match;
  if (!match) return ctx.answerCallbackQuery();
  const categoryName = match[1]!;
  const amount = Number(match[2]!);
  const description = match[3] || undefined;
  const telegramId = String(ctx.from?.id);

  const user = await getOrCreateUser(telegramId);

  // Создаём категорию в lowercase
  const category = await db.category.create({
    data: {
      name: categoryName.toLowerCase(),
      userId: user.id,
    },
  });

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
  await ctx.editMessageText(`✅ ${category.name}${descStr}: ${amount} 💸`);

  await ctx.answerCallbackQuery();
});

// Обработчик отмены
bot.callbackQuery(/^cancel$/, async (ctx) => {
  await ctx.editMessageText("❌ Отменено");
  await ctx.answerCallbackQuery();
});