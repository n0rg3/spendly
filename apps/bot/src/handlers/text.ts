import { InlineKeyboard } from "grammy";
import { bot } from "../bot.js";
import { firestore } from "../firebase.js";
import { getOrCreateUser } from "../utils/getOrCreateUser.js";

type Category = { id: string; name: string; icon: string | null; color: string | null };
type Expense = { id: string; amount: number; description: string | null; createdAt: string; category: Category | null };
type Dashboard = { categories: Category[]; expenses: Expense[]; totalSpent: number; userCreatedAt: string };

// Хранилище временных данных: telegramId -> { categoryName, amount, description }
export const pendingExpenses = new Map<
  string,
  { categoryName: string; amount: number; description?: string }
>();

bot.on("message:text", async (ctx) => {
  try {
    const fromId = ctx.from?.id;
    if (!fromId) return;

    const text = ctx.message.text.trim();
    const telegramId = String(fromId);

    // Пропускаем команды
    if (text.startsWith("/")) return;

    // Парсим: "категория описание сумма" или "категория сумма"
    const parts = text.split(/\s+/);
    if (parts.length < 2) return; // Пропускаем невалидный ввод

    // Последняя часть — сумма
    const amountStr = parts[parts.length - 1]!.replace(",", ".");
    const amount = Number(amountStr);
    if (isNaN(amount) || amount <= 0) return;

    // Первая часть — категория
    const categoryName = parts[0]!;

    // Всё между категорией и суммой — описание
    const description = parts.length > 2
      ? parts.slice(1, -1).join(" ")
      : undefined;

    const userDocRef = firestore.collection("users").doc(telegramId);
    const userSnap = await userDocRef.get();

    let dashboard: Dashboard;
    if (!userSnap.exists) {
      // Создаём нового пользователя через getOrCreateUser
      await getOrCreateUser(telegramId);
      const newSnap = await userDocRef.get();
      dashboard = newSnap.data() as Dashboard;
    } else {
      dashboard = userSnap.data() as Dashboard;
    }

    // Поиск категории БЕЗ учета регистра
    const category = dashboard.categories.find(
      (c) => c.name.toLowerCase() === categoryName.toLowerCase()
    );

    if (!category) {
      // Сохраняем временные данные в Map
      pendingExpenses.set(telegramId, { categoryName, amount, description });

      const createKeyboard = new InlineKeyboard()
        .text(`✅ Создать "${categoryName}"`, "confirm_create_category")
        .text("❌ Отмена", "cancel_create_category");

      return await ctx.reply(
        `Категория "${categoryName}" не найдена. Создать?`,
        { reply_markup: createKeyboard },
      );
    }

    // Сохраняем расход
    const newExpense: Expense = {
      id: String(Date.now()),
      amount,
      description: description ?? null,
      createdAt: new Date().toISOString(),
      category: { id: category.id, name: category.name, icon: category.icon, color: category.color },
    };

    const updatedExpenses = [newExpense, ...dashboard.expenses];
    const updated: Dashboard = {
      ...dashboard,
      expenses: updatedExpenses,
      totalSpent: updatedExpenses.reduce((sum, e) => sum + e.amount, 0),
    };

    await userDocRef.set(updated);

    const descStr = description ? ` (${description})` : "";
    return await ctx.reply(`✅ ${category.name}${descStr}: ${amount} 💸`);
  } catch (error) {
    console.error("Ошибка при обработке сообщения:", error);
    return await ctx.reply("⚠️ Ошибка при записи. Проверьте консоль.");
  }
});