import { bot } from "../bot.js";
import { firestore } from "../firebase.js";
import { getOrCreateUser } from "../utils/getOrCreateUser.js";
import { pendingExpenses } from "./text.js";

type Category = { id: string; name: string; icon: string | null; color: string | null };
type Expense = { id: string; amount: number; description: string | null; createdAt: string; category: Category | null };
type Dashboard = { categories: Category[]; expenses: Expense[]; totalSpent: number; userCreatedAt: string };

// 1. Команда /addcat Название
bot.command("addcat", async (ctx) => {
  try {
    const rawName = ctx.match.trim();

    if (!rawName) {
      return await ctx.reply("Используй: /addcat Еда");
    }

    const fromId = ctx.from?.id;
    if (!fromId) return;

    const telegramId = String(fromId);
    const userDocRef = firestore.collection("users").doc(telegramId);
    const userSnap = await userDocRef.get();

    if (!userSnap.exists) {
      return await ctx.reply("⚠️ Сначала отправьте расход, чтобы создать профиль.");
    }

    const dashboard = userSnap.data() as Dashboard;

    // Приводим к красивому виду: Первая буква заглавная, остальные строчные
    const categoryName = rawName.charAt(0).toUpperCase() + rawName.slice(1);

    // Проверяем, нет ли уже такой категории
    const existing = dashboard.categories.find(
      (c) => c.name.toLowerCase() === categoryName.toLowerCase()
    );

    if (existing) {
      return await ctx.reply(`Категория "${existing.name}" уже существует!`);
    }

    // Создаём новую категорию
    const newCategory: Category = {
      id: String(Date.now()),
      name: categoryName,
      icon: null,
      color: null,
    };

    const updated: Dashboard = {
      ...dashboard,
      categories: [...dashboard.categories, newCategory],
    };

    await userDocRef.set(updated);

    return await ctx.reply(`✅ Категория "${categoryName}" добавлена`);
  } catch (error) {
    console.error("Ошибка в /addcat:", error);
    return await ctx.reply("⚠️ Не удалось добавить категорию.");
  }
});

// 2. Обработчик создания категории из инлайн-кнопки
bot.callbackQuery("confirm_create_category", async (ctx) => {
  try {
    const fromId = ctx.from?.id;
    if (!fromId) return;

    const telegramId = String(fromId);
    const pending = pendingExpenses.get(telegramId);

    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Сессия истекла" });
      return await ctx.editMessageText("⏱ Время ожидания истекло. Напишите расход заново.");
    }

    const userDocRef = firestore.collection("users").doc(telegramId);
    const userSnap = await userDocRef.get();

    if (!userSnap.exists) {
      await ctx.answerCallbackQuery({ text: "Ошибка" });
      return await ctx.editMessageText("⚠️ Профиль не найден.");
    }

    const dashboard = userSnap.data() as Dashboard;

    // Делаем красивое имя с Заглавной буквы
    const formattedCategoryName =
      pending.categoryName.charAt(0).toUpperCase() + pending.categoryName.slice(1);

    // Создаём категорию
    const newCategory: Category = {
      id: String(Date.now()),
      name: formattedCategoryName,
      icon: null,
      color: null,
    };

    // Создаём расход
    const newExpense: Expense = {
      id: String(Date.now() + 1),
      amount: pending.amount,
      description: pending.description ?? null,
      createdAt: new Date().toISOString(),
      category: { id: newCategory.id, name: newCategory.name, icon: null, color: null },
    };

    const updatedExpenses = [newExpense, ...dashboard.expenses];
    const updated: Dashboard = {
      ...dashboard,
      categories: [...dashboard.categories, newCategory],
      expenses: updatedExpenses,
      totalSpent: updatedExpenses.reduce((sum, e) => sum + e.amount, 0),
    };

    await userDocRef.set(updated);

    // Очищаем временную запись
    pendingExpenses.delete(telegramId);

    const descStr = pending.description ? ` (${pending.description})` : "";

    await ctx.answerCallbackQuery();
    return await ctx.editMessageText(`✅ ${newCategory.name}${descStr}: ${pending.amount} 💸`);
  } catch (error) {
    console.error("Ошибка при подтверждении создания категории:", error);
    return await ctx.reply("⚠️ Не удалось создать категорию.");
  }
});

// 3. Обработчик отмены
bot.callbackQuery("cancel_create_category", async (ctx) => {
  const fromId = ctx.from?.id;
  if (fromId) {
    pendingExpenses.delete(String(fromId));
  }
  await ctx.answerCallbackQuery();
  return await ctx.editMessageText("❌ Отменено");
});