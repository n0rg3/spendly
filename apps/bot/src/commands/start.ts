import { InlineKeyboard } from "grammy";
import { bot } from "../bot.js";

bot.command("start", async (ctx) => {
  const miniAppUrl = process.env.MINI_APP_URL;

  if (!miniAppUrl) {
    await ctx.reply(
      "👋 Добро пожаловать в Spendly! Мини-приложение пока не настроено.",
    );
    return;
  }

  const keyboard = new InlineKeyboard().webApp("Открыть Spendly", miniAppUrl);
  await ctx.reply("👋 Добро пожаловать в Spendly!", { reply_markup: keyboard });
});
