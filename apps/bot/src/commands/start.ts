import { bot } from "../bot";

bot.command("start", async (ctx) => {
  await ctx.reply("👋 Добро пожаловать в Spendly!");
});