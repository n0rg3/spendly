import { bot } from "../bot.js";
import { firestore } from "../firebase.js";
import { getOrCreateUser } from "../utils/getOrCreateUser.js";

type Category = { id: string; name: string; icon: string | null; color: string | null };
type Expense = { id: string; amount: number; description: string | null; createdAt: string; category: Category | null };
type Dashboard = { categories: Category[]; expenses: Expense[]; totalSpent: number; userCreatedAt: string };

bot.command("add", async (ctx) => {
  const [amount, ...desc] = ctx.match?.split(" ") ?? [];

  if (!amount) {
    return ctx.reply("Используй: /add 100 кофе");
  }

  const fromId = ctx.from?.id;
  if (!fromId) return;

  const telegramId = String(fromId);
  const userDocRef = firestore.collection("users").doc(telegramId);
  const userSnap = await userDocRef.get();

  let dashboard: Dashboard;
  if (!userSnap.exists) {
    await getOrCreateUser(telegramId);
    const newSnap = await userDocRef.get();
    dashboard = newSnap.data() as Dashboard;
  } else {
    dashboard = userSnap.data() as Dashboard;
  }

  const newExpense: Expense = {
    id: String(Date.now()),
    amount: Number(amount),
    description: desc.join(" ") || null,
    createdAt: new Date().toISOString(),
    category: null,
  };

  const updatedExpenses = [newExpense, ...dashboard.expenses];
  const updated: Dashboard = {
    ...dashboard,
    expenses: updatedExpenses,
    totalSpent: updatedExpenses.reduce((sum, e) => sum + e.amount, 0),
  };

  await userDocRef.set(updated);

  return ctx.reply("Добавлено 💸");
});