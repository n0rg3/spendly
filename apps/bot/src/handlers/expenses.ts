import { bot } from "../bot.js";
import { db } from "@sp3ndly/database";
import { getOrCreateUser } from "../utils/getOrCreateUser.js";

bot.command("add", async (ctx) => {
  const [amount, ...desc] = ctx.match?.split(" ") ?? [];

  if (!amount) {
    return ctx.reply("Используй: /add 100 кофе");
  }

  const user = await getOrCreateUser(String(ctx.from?.id));

  await db.expense.create({
    data: {
      amount: Number(amount),
      description: desc.join(" "),
      userId: user.id,
    },
  });

  return ctx.reply("Добавлено 💸");
});