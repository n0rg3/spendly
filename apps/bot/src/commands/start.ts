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

  const keyboard = new InlineKeyboard().webApp("🚀 Открыть Spendly", miniAppUrl);
  await ctx.reply(
    "👋 Привет! Добро пожаловать в <b>Spendly</b> — твой личный трекер расходов.\n\n"
    + "📊 Учитывай все траты по категориям\n"
    + "📈 Смотри статистику и графики\n"
    + "🎯 Копи на цели\n\n"
    + "Нажми кнопку ниже, чтобы открыть мини-приложение 👇",
    { reply_markup: keyboard, parse_mode: "HTML" },
  );
});
