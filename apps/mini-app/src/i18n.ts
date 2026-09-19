// apps/mini-app/src/i18n.ts
// Лёгкая локализация интерфейса: словарь Русский / Английский.
// Язык определяется автоматически (Telegram -> браузер), кэшируется
// в localStorage и переключается кнопкой в шапке приложения.

export type Lang = "ru" | "en";

type Dict = Record<string, string>;

const RU: Dict = {
  // ===== Вкладки / навигация =====
  tabChart: "График",
  tabExpenses: "Траты",
  tabCards: "Карты",
  tabSavings: "Накопления",
  navAria: "Основная навигация",
  addAria: "Добавить",
  addExpenseAria: "Добавить трату",

  // ===== Общие =====
  categoryOther: "Остальное",
  expenseFallback: "Расход",
  total: "Итого",
  save: "Сохранить",
  saving: "Сохраняю…",
  delete: "Удалить",
  cancel: "Отмена",
  create: "Создать",
  creating: "Создаю…",
  add: "Добавить",
  amountPlaceholder: "Сумма",
  description: "Описание",
  amountLabel: "Сумма",
  yearLabel: "{year} год",
  langAria: "Язык интерфейса",
  okGotIt: "Понятно",
  noDataYet: "Данные появятся после добавления трат.",

  // ===== Траты =====
  recentExpenses: "Последние траты",
  allExpenses: "Все траты",
  noExpensesMonth: "В этом месяце трат нет.",
  expenseAddError: "Не удалось добавить расход",
  expenseUpdateError: "Не удалось изменить трату",
  expenseDeleteError: "Не удалось удалить трату",
  confirmDeleteExpense: "Удалить трату?",
  invalidDateTime: "Укажите корректные дату и время",
  invalidAmount: "Укажите корректную сумму",
  cloudError: "Ошибка подключения к облаку",

  // ===== Категории =====
  categoryName: "Название категории",
  planned: "Планируемое",
  budgetFrom: "от {amount}",
  categoryAddError: "Не удалось добавить категорию",
  categoryUpdateError: "Не удалось изменить категорию",
  categoryDeleteError: "Не удалось удалить категорию",
  confirmDeleteCategory: "Удалить категорию «{name}»?",
};


// ===== Цели (RU) =====
export const RU_GOALS: Dict = {
  goalName: "Название цели",
  goalTarget: "Целевая сумма",
  goalOf: "из",
  createGoal: "Создать цель",
  firstGoalTitle: "Создайте первую цель",
  firstGoalSubtitle: "Например, отпуск, новый телефон или подушка безопасности.",
  addGoal: "Добавить цель",
  newGoal: "Новая цель",
  topUp: "Пополнить",
  withdraw: "Снять",
  goalAddError: "Не удалось создать цель",
  goalUpdateError: "Не удалось изменить цель",
  goalDeleteError: "Не удалось удалить цель",
  goalSaveError: "Не удалось обновить цель",
  confirmDeleteGoal: "Удалить цель «{name}»?",
};

// ===== Карты лояльности (RU) =====
export const RU_CARDS: Dict = {
  loyaltyTitle: "Карты лояльности",
  loyaltySubtitle: "Добавьте дисконтные карты магазинов — и показывайте код прямо с экрана на кассе.",
  addCard: "Добавить карту",
  cardNoCode: "У карты нет кода",
  cardNamePlaceholder: "Название магазина",
  cardCodePlaceholder: "Штрих-код / QR (числа или текст)",
  formatAuto: "Формат: определить автоматически",
  formatBarcode: "Штрих-код (Code128 / EAN-13)",
  formatQr: "QR-код",
  cameraHint: "Наведите камеру на штрих-код или QR-код карты",
  stopCamera: "Остановить камеру",
  saveCard: "Сохранить карту",
  cardSaveError: "Не удалось сохранить карту",
  cardDeleteError: "Не удалось удалить карту",
  confirmDeleteCard: "Удалить карту «{name}»?",
  scanCardHint: "Наведите на QR или штрих-код карты",
  cameraOpenError: "Не удалось открыть камеру. Разрешите доступ или введите код вручную.",
  scannerUnavailable: "QR-сканер недоступен: откройте Mini App в Telegram",
  collapse: "Свернуть",
};

// ===== Чек / сканер (RU) =====
export const RU_RECEIPT: Dict = {
  scanReceipt: "Сканировать QR-код чека",
  scanReceiptHint: "Отсканируйте QR на чеке",
  manualEntry: "Ввести вручную",
  receiptTitle: "Чек",
  receiptHint: "Отметьте нужные позиции, поправьте суммы и категории",
  receiptParsing: "Распознаём чек…",
  receiptParsingHint: "Это займёт несколько секунд",
  receiptLoadError: "Ошибка загрузки чека",
  receiptSaveError: "Не удалось сохранить траты из чека",
  noReceiptItems: "В чеке не найдено позиций.",
  itemNameAria: "Название позиции {name}",
  itemAmountAria: "Сумма позиции {name}",
  itemCategoryAria: "Категория позиции {name}",
};

// ===== API / инфраструктура (RU) =====
export const RU_API: Dict = {
  apiNotConfigured:
    "API не настроен: задай VITE_API_URL (адрес serverless-функции, напр. https://<project>.vercel.app) и пересобери приложение",
  apiPlaceholder: "API не настроен: VITE_API_URL всё ещё содержит заглушку ({url})",
  apiLocalhost: "Некорректный VITE_API_URL ({url}): на GitHub Pages нельзя обращаться к localhost",
};

// ===== Основной словарь (EN) =====
export const EN: Dict = {
  tabChart: "Chart",
  tabExpenses: "Expenses",
  tabCards: "Cards",
  tabSavings: "Savings",
  navAria: "Main navigation",
  addAria: "Add",
  addExpenseAria: "Add expense",

  categoryOther: "Other",
  expenseFallback: "Expense",
  total: "Total",
  save: "Save",
  saving: "Saving…",
  delete: "Delete",
  cancel: "Cancel",
  create: "Create",
  creating: "Creating…",
  add: "Add",
  amountPlaceholder: "Amount",
  description: "Description",
  amountLabel: "Amount",
  yearLabel: "{year}",
  langAria: "Interface language",
  okGotIt: "Got it",
  noDataYet: "Data will appear after adding expenses.",

  recentExpenses: "Recent expenses",
  allExpenses: "All expenses",
  noExpensesMonth: "No expenses this month.",
  expenseAddError: "Could not add the expense",
  expenseUpdateError: "Could not update the expense",
  expenseDeleteError: "Could not delete the expense",
  confirmDeleteExpense: "Delete this expense?",
  invalidDateTime: "Enter a valid date and time",
  invalidAmount: "Enter a valid amount",
  cloudError: "Cloud connection error",

  categoryName: "Category name",
  planned: "Planned",
  budgetFrom: "from {amount}",
  categoryAddError: "Could not add a category",
  categoryUpdateError: "Could not update the category",
  categoryDeleteError: "Could not delete the category",
  confirmDeleteCategory: "Delete category “{name}”?",
};

// ===== Цели (EN) =====
export const EN_GOALS: Dict = {
  goalName: "Goal name",
  goalTarget: "Target amount",
  goalOf: "of",
  createGoal: "Create goal",
  firstGoalTitle: "Create your first goal",
  firstGoalSubtitle: "For example, a vacation, a new phone, or an emergency fund.",
  addGoal: "Add goal",
  newGoal: "New goal",
  topUp: "Top up",
  withdraw: "Withdraw",
  goalAddError: "Could not create the goal",
  goalUpdateError: "Could not update the goal",
  goalDeleteError: "Could not delete the goal",
  goalSaveError: "Could not update the goal",
  confirmDeleteGoal: "Delete goal “{name}”?",
};

// ===== Карты лояльности (EN) =====
export const EN_CARDS: Dict = {
  loyaltyTitle: "Loyalty cards",
  loyaltySubtitle: "Add store loyalty cards and show the code right at the checkout.",
  addCard: "Add card",
  cardNoCode: "No code for this card",
  cardNamePlaceholder: "Store name",
  cardCodePlaceholder: "Barcode / QR (digits or text)",
  formatAuto: "Format: detect automatically",
  formatBarcode: "Barcode (Code128 / EAN-13)",
  formatQr: "QR code",
  cameraHint: "Point the camera at the card's barcode or QR code",
  stopCamera: "Stop camera",
  saveCard: "Save card",
  cardSaveError: "Could not save the card",
  cardDeleteError: "Could not delete the card",
  confirmDeleteCard: "Delete card “{name}”?",
  scanCardHint: "Point at the card's QR or barcode",
  cameraOpenError: "Could not open the camera. Allow access or enter the code manually.",
  scannerUnavailable: "QR scanner unavailable: open the Mini App in Telegram",
  collapse: "Collapse",
};

// ===== Чек / сканер (EN) =====
export const EN_RECEIPT: Dict = {
  scanReceipt: "Scan receipt QR code",
  scanReceiptHint: "Scan the QR code on the receipt",
  manualEntry: "Enter manually",
  receiptTitle: "Receipt",
  receiptHint: "Check the items, adjust amounts and categories",
  receiptParsing: "Recognizing the receipt…",
  receiptParsingHint: "This will take a few seconds",
  receiptLoadError: "Failed to load the receipt",
  receiptSaveError: "Could not save receipt items",
  noReceiptItems: "No items found in the receipt.",
  itemNameAria: "Item name {name}",
  itemAmountAria: "Item amount {name}",
  itemCategoryAria: "Item category {name}",
};

// ===== API / инфраструктура (EN) =====
export const EN_API: Dict = {
  apiNotConfigured:
    "API is not configured: set VITE_API_URL (the serverless function URL, e.g. https://<project>.vercel.app) and rebuild the app",
  apiPlaceholder: "API is not configured: VITE_API_URL still contains a placeholder ({url})",
  apiLocalhost: "Invalid VITE_API_URL ({url}): localhost is not reachable from GitHub Pages",
};

export const STRINGS: Record<Lang, Dict> = {
  ru: { ...RU, ...RU_GOALS, ...RU_CARDS, ...RU_RECEIPT, ...RU_API },
  en: { ...EN, ...EN_GOALS, ...EN_CARDS, ...EN_RECEIPT, ...EN_API },
};

const LANG_STORAGE_KEY = "spendly_lang";

/** Определяет язык: сохранённый -> Telegram -> язык браузера -> русский. */
export function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    if (stored === "ru" || stored === "en") return stored;
  } catch {
    // localStorage недоступен — идём дальше по цепочке
  }

  const tgCode = window.Telegram?.WebApp?.initDataUnsafe?.user?.language_code;
  const browserCode = typeof navigator !== "undefined" ? navigator.language : undefined;
  const code = (tgCode || browserCode || "ru").toLowerCase();
  return code.startsWith("ru") ? "ru" : "en";
}

export function loadLang(): Lang {
  return detectLang();
}

export function saveLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // без localStorage просто работаем на текущем языке
  }
}

export type Translator = (key: string, vars?: Record<string, string | number>) => string;

/** Фабрика переводчика: t("key", { name: "..." }) с подстановкой {placeholders}. */
export function makeT(lang: Lang): Translator {
  return (key, vars) => {
    let text = STRINGS[lang][key] ?? STRINGS.ru[key] ?? key;
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  };
}

/** Локаль для Intl (даты, деньги, сравнение строк). */
export const intlLocale = (lang: Lang): string => (lang === "ru" ? "ru-RU" : "en-US");

/** Названия месяцев для пикера (с заглавной буквы, как в текущем UI). */
export const MONTHS: Record<Lang, string[]> = {
  ru: [
    "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
  ],
  en: [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ],
};

/** Подписи иконок категорий/целей в пикере иконок. */
export const ICON_LABELS: Record<Lang, Record<string, string>> = {
  ru: {
    food: "Еда", transport: "Транспорт", shopping: "Покупки", ent: "Развлечения",
    health: "Здоровье", home: "Дом", gift: "Подарки", wallet: "Кошелёк",
    coffee: "Кофе", book: "Книга", movie: "Кино", music: "Музыка",
    phone: "Телефон", travel: "Путешествие", sport: "Спорт", education: "Образование",
    pet: "Питомец", beauty: "Красота", clothing: "Одежда", other: "Другое",
    baby: "Дети", bank: "Банк", beer: "Алкоголь", bike: "Велосипед",
    bus: "Автобус", camera: "Фото", clapper: "Видео", cloud: "Облако",
    coins: "Монеты", game: "Игры", gas: "Бензин", glasses: "Зрение",
    icecream: "Десерты", lamp: "Свет", leaf: "Природа", paint: "Творчество",
    pizza: "Пицца", receipt: "Чеки", scissors: "Услуги", tools: "Инструменты",
    train: "Поезд", tv: "ТВ", umbrella: "Зонт", wine: "Вино",
    wrench: "Ремонт", goal: "Цель",
  },
  en: {
    food: "Food", transport: "Transport", shopping: "Shopping", ent: "Fun",
    health: "Health", home: "Home", gift: "Gifts", wallet: "Wallet",
    coffee: "Coffee", book: "Books", movie: "Movies", music: "Music",
    phone: "Phone", travel: "Travel", sport: "Sport", education: "Education",
    pet: "Pets", beauty: "Beauty", clothing: "Clothes", other: "Other",
    baby: "Kids", bank: "Bank", beer: "Alcohol", bike: "Bike",
    bus: "Bus", camera: "Photo", clapper: "Video", cloud: "Cloud",
    coins: "Coins", game: "Games", gas: "Fuel", glasses: "Vision",
    icecream: "Desserts", lamp: "Light", leaf: "Nature", paint: "Art",
    pizza: "Pizza", receipt: "Receipts", scissors: "Services", tools: "Tools",
    train: "Train", tv: "TV", umbrella: "Umbrella", wine: "Wine",
    wrench: "Repair", goal: "Goal",
  },
};
