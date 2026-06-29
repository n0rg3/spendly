import { bot } from "../bot.js";
import { db } from "@sp3ndly/database";

bot.command("addcat", async (ctx) => {
  const name = ctx.match;

  if (!name) {
    return ctx.reply("Используй: /addcat Food");
  }

  const user = await db.user.upsert({
    where: { telegramId: String(ctx.from?.id) },
    update: {},
    create: {
      telegramId: String(ctx.from?.id),
    },
  });

  await db.category.create({
    data: {
      name,
      userId: user.id,
    },
  });

  return ctx.reply(`Категория "${name}" добавлена`);
});