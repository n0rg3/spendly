import { firestore } from "../firebase.js";

const DEFAULT_DASHBOARD = {
  categories: [
    { id: "1", name: "Еда", icon: "food", color: "#3390ec" },
    { id: "2", name: "Транспорт", icon: "transport", color: "#2cb074" },
    { id: "3", name: "Покупки", icon: "shopping", color: "#f7a200" },
  ],
  expenses: [],
  totalSpent: 0,
  userCreatedAt: new Date().toISOString(),
  savingsGoals: [],
};

export async function getOrCreateUser(telegramId: string) {
  const userDocRef = firestore.collection("users").doc(telegramId);
  const docSnap = await userDocRef.get();

  if (!docSnap.exists) {
    await userDocRef.set(DEFAULT_DASHBOARD);
    return { id: telegramId, telegramId, ...DEFAULT_DASHBOARD };
  }

  const data = docSnap.data()!;
  return { id: telegramId, telegramId, ...data };
}