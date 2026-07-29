import { bot } from "./bot.js";
import "./commands/start.js";
import "./handlers/categories.js";
import "./handlers/expenses.js";
import "./handlers/text.js";

// Обработчик ошибок — бот не падает при проблемах с БД
bot.catch((err) => {
  console.error("Bot error:", err);
});

console.log("🤖 Spendly is running...");

bot.start();
