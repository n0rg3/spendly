import { bot } from "../bot.js";
import { getOrCreateUser } from "../utils/getOrCreateUser.js";

bot.command("start", async (ctx) => {
  await getOrCreateUser(String(ctx.from?.id));

  return ctx.reply(
    "sp3ndly 💸\n\nДобавь расход:\n/add 100 кофе"
  );
});