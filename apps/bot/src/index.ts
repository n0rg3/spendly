import { bot } from "./bot.js";
import "./commands/start.js";
import { db } from "@sp3ndly/database";
import "./handlers/categories.js";
import "./handlers/expenses.js";
const users = await db.user.findMany();

console.log(users);
console.log("🤖 Spendly is running...");

await bot.start();





