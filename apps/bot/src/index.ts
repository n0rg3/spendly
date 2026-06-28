import { bot } from "./bot";
import "./commands/start";

console.log("🤖 Spendly is running...");

await bot.start();