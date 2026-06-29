import { bot } from "../bot.js";

bot.command("start", async (ctx) => {
  await ctx.reply("👋 Добро пожаловать в Spendly!");
});