// apps/mini-app/src/App.tsx
import { Component, StrictMode, useEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type FormEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as LucideIcons from "lucide-react";
import { collection, doc, setDoc, getDoc, deleteDoc, onSnapshot, query, orderBy } from "firebase/firestore";
import { QRCodeSVG } from "qrcode.react";
import Barcode, { type BarcodeProps } from "react-barcode";
import { db } from "./firebase";
import { getCategoryColor, GOLDEN_RATIO_STEP } from "./categoryColors";
import {
  ICON_LABELS,
  MONTHS,
  intlLocale,
  loadLang,
  makeT,
  saveLang,
  type Lang,
  type Translator,
} from "./i18n";
import { buildChartGradient, type CategoryStat } from "./chartGradient";
import { nextSelectedCategoryIdOnOutsideTap } from "./chartInteraction";
import "./styles.css";

function lockAppHeight() {
  const tg = window.Telegram?.WebApp;

  const setHeight = () => {
    // viewportStableHeight — высота БЕЗ учёта поднятой клавиатуры.
    // Если Mini App открыт не в Telegram (обычный браузер) — fallback на innerHeight.
    const h = tg?.viewportStableHeight || window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${h}px`);
  };

  setHeight();

  if (tg?.onEvent) {
    // Стреляет при появлении/скрытии клавиатуры и при разворачивании приложения
    tg.onEvent('viewportChanged', setHeight);
  }
  // В браузере/десктопе клавиатура меняет innerHeight без viewportChanged — слушаем resize всегда
  window.addEventListener('resize', setHeight);

  window.addEventListener('orientationchange', () => setTimeout(setHeight, 300));
}

lockAppHeight();



type Category = { 
  id: string; 
  name: string; 
  icon: string | null; 
  color: string | null;
  budgets?: Record<string, number>; // { "2026-07": 5000 }
};
type Expense = { id: string; amount: number; description: string | null; createdAt: string; category: Category | null; qty?: number; unitPrice?: number };
type SavingsGoal = {
  id: string;
  name: string;
  targetAmount: number;
  savedAmount: number;
  icon: string | null;
  color: string | null;
  createdAt: string;
};
type Dashboard = { categories: Category[]; expenses: Expense[]; totalSpent: number; userCreatedAt: string; savingsGoals: SavingsGoal[] };
type Tab = "chart" | "expenses" | "cards" | "savings";

// Карта лояльности (Firestore: users/{userId}/loyalty_cards/{cardId})
type LoyaltyCard = {
  id: string;
  name: string;
  code: string;
  format: "qr" | "barcode";
  createdAt: string;
};

// ===== Коды карт лояльности: форматы, валидация, очистка сканов =====

// Выбор формата штрих-кода по содержимому кода:
// только цифры и 13 знаков → EAN13, только цифры и 8 знаков → EAN8,
// всё остальное (буквы вроде «mRS», 16+ цифр, составные payload) → CODE128 —
// универсальный формат, который кодирует любую длину и любой печатный ASCII
type BarcodeFormat = NonNullable<BarcodeProps["format"]>;

const barcodeFormatFor = (code: string): BarcodeFormat => {
  // Всегда CODE128 — универсальный формат, который кодирует любую длину и любой печатный ASCII.
  // CODE128 рендерит штрихи строго одной высоты без лишних горизонтальных линий (как на референсе Maxi),
  // в отличие от EAN-13, где крайние и центральные маркеры вылезают вниз из-за двумерной структуры штрих-кода.
  return "CODE128";
};

// Автоопределение формата: чисто цифровые коды считаем штрих-кодами, остальные — QR
const detectCardFormat = (code: string): "qr" | "barcode" => (/^\d{6,20}$/.test(code) ? "barcode" : "qr");

// Стандартная проверка контрольной цифры GS1 (EAN-8 / UPC-A / EAN-13)
function gs1ChecksumOk(digits: string): boolean {
  const check = Number(digits[digits.length - 1]);
  if (Number.isNaN(check)) return false;
  let sum = 0;
  [...digits.slice(0, -1)].reverse().forEach((digit, index) => {
    sum += Number(digit) * (index % 2 === 0 ? 3 : 1);
  });
  return (10 - (sum % 10)) % 10 === check;
}

// Проверка, что jsbarcode реально сможет отрисовать значение в выбранном формате
// (иначе react-barcode падает с ошибкой внутри эффекта → на экране пустая белая плашка)
const barcodeValueOk = (code: string, format: BarcodeFormat): boolean => {
  switch (format) {
    case "EAN13": return /^\d{12,13}$/.test(code) && (code.length === 12 || gs1ChecksumOk(code));
    case "EAN8": return /^\d{7,8}$/.test(code) && (code.length === 7 || gs1ChecksumOk(code));
    default: return isAsciiPrintable(code); // CODE128 кодирует любой печатный ASCII
  }
};

const isAsciiPrintable = (code: string): boolean => /^[\x20-\x7e]+$/.test(code);

// Очистка отсканированной строки: URL → код из query; составные payload
// (например, сербские карты вида «mRS;1;QdeX…») → только сегмент-идентификатор
function cleanScannedCode(raw: string): string {
  let code = raw.trim().replace(/[\u0000-\u001f\u007f]/g, "");

  if (/^https?:\/\//i.test(code)) {
    try {
      const url = new URL(code);
      const param = url.searchParams.get("code") ?? url.searchParams.get("id") ?? url.searchParams.get("card");
      code = param ?? url.pathname.split("/").filter(Boolean).pop() ?? code;
    } catch {
      // оставить строку как есть
    }
  }

  if (code.includes(";")) {
    const segments = code.split(";").map((segment) => segment.trim()).filter(Boolean);
    const numeric = segments.find((segment) => /^\d{6,20}$/.test(segment));
    const longestAlpha = [...segments]
      .filter((segment) => /^[A-Za-z0-9._+-]{4,}$/.test(segment))
      .sort((left, right) => right.length - left.length)[0];
    code = numeric ?? longestAlpha ?? segments[0] ?? code;
  }

  return code.slice(0, 120);
}

// Короткое отображение кода в списках: без сырого Base64/payload на весь экран
function shortCardCode(code: string, max = 24): string {
  if (!code) return "";
  if (code.length <= max) return code;
  return `${code.slice(0, Math.max(max - 1, 1))}…`;
}

// Дефолтный дашборд для нового пользователя: названия стартовых категорий
// зависят от языка интерфейса (существующие профили в Firestore не трогаем)
const defaultDashboard = (lang: Lang): Dashboard => ({
  categories: lang === "ru"
    ? [
        { id: "1", name: "Еда", icon: "food", color: "#3390ec" },
        { id: "2", name: "Транспорт", icon: "transport", color: "#2cb074" },
        { id: "3", name: "Покупки", icon: "shopping", color: "#f7a200" },
      ]
    : [
        { id: "1", name: "Food", icon: "food", color: "#3390ec" },
        { id: "2", name: "Transport", icon: "transport", color: "#2cb074" },
        { id: "3", name: "Shopping", icon: "shopping", color: "#f7a200" },
      ],
  expenses: [],
  totalSpent: 0,
  userCreatedAt: new Date().toISOString(),
  savingsGoals: [],
});

// Цвета категорий не хранятся константами: количество категорий динамическое,
// палитра считается хэшем от названия — см. getCategoryColor в ./categoryColors

// Псевдо-категория: модалка траты открыта вручную (без категории).
// Совпадение всегда по id (""), а позиция без категории попадает в «Остальное»
const MANUAL_NO_CATEGORY: Category = { id: "", name: "Остальное", icon: "other", color: null };

function getUserId(): string {
  const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
  if (tgUser?.id) return String(tgUser.id);

  let localId = localStorage.getItem("spendly_dev_user_id");
  if (!localId) {
    localId = "dev_user_" + Math.random().toString(36).substring(2, 9);
    localStorage.setItem("spendly_dev_user_id", localId);
  }
  return localId;
}

function toLocalDateTime(value: string) {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

function currentMonthKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

// ===== Кэш категорий товаров (экономия токенов Gemini) =====
// Firestore: коллекция item_category_cache, документ = userId,
// поле items = { [нормализованное имя товара]: название категории }.
type ItemCategoryCache = Record<string, string>;

// Нормализация имени товара: lowercase, trim, схлопывание пробелов
function normalizeItemName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

// Читает кэш «товар -> категория» из Firestore
async function readItemCategoryCache(userId: string): Promise<ItemCategoryCache> {
  try {
    const snap = await getDoc(doc(db, "item_category_cache", userId));
    return (snap.data()?.items as ItemCategoryCache | undefined) ?? {};
  } catch {
    return {};
  }
}

// Записывает/обновляет сопоставления «товар -> категория» (merge, не затирает остальные)
async function writeItemCategoryCache(userId: string, entries: ItemCategoryCache): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  try {
    await setDoc(doc(db, "item_category_cache", userId), { items: entries }, { merge: true });
  } catch (error) {
    console.warn("Не удалось обновить кэш категорий товаров:", error);
  }
}

// "16.9.2026. 17:50:44" (формат сербских чеков, месяц/день могут быть однозначными) -> ISO
function receiptDateToIso(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\.?\s+(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const [, day, month, year, hours, minutes] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatMonth(value: string, lang: Lang = "ru") {
  if (!value || typeof value !== "string" || !value.includes("-")) {
    return "";
  }

  const [yearStr, monthStr] = value.split("-");
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  if (isNaN(year) || isNaN(month)) return "";

  const date = new Date(year, month - 1, 1);
  if (isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat(lang === "en" ? "en-US" : "ru-RU", { month: "long", year: "numeric" }).format(date);
}

const ICON_MAP: Record<string, keyof typeof LucideIcons> = {
  grid: "LayoutGrid",
  card: "CreditCard",
  chart: "PieChart",
  goal: "Target",
  plus: "Plus",
  arrow: "ChevronRight",
  food: "Utensils",
  transport: "Car",
  shopping: "ShoppingBag",
  ent: "Ticket",
  health: "HeartPulse",
  home: "Home",
  gift: "Gift",
  wallet: "Wallet",
  coffee: "Coffee",
  book: "Book",
  movie: "Film",
  music: "Music",
  phone: "Smartphone",
  travel: "Plane",
  sport: "Dumbbell",
  education: "GraduationCap",
  pet: "Dog",
  beauty: "Sparkles",
  clothing: "Shirt",
  other: "Circle",
  baby: "Baby",
  bank: "Landmark",
  beer: "Beer",
  bike: "Bike",
  bus: "Bus",
  camera: "Camera",
  clapper: "Clapperboard",
  cloud: "Cloud",
  coins: "Coins",
  game: "Gamepad2",
  gas: "Fuel",
  glasses: "Glasses",
  icecream: "IceCream",
  lamp: "Lamp",
  leaf: "Leaf",
  paint: "Palette",
  pizza: "Pizza",
  receipt: "Receipt",
  scissors: "Scissors",
  tools: "Hammer",
  train: "Train",
  tv: "Tv",
  umbrella: "Umbrella",
  wine: "Wine",
  wrench: "Wrench",
  loyalty: "ScanBarcode",
};

const CATEGORY_ICONS = Object.keys(ICON_MAP).filter((key) => !["grid", "card", "chart", "goal", "plus", "arrow", "loyalty"].includes(key));
// Подписи иконок локализованы в ./i18n (ICON_LABELS: { ru, en })

function Icon({ name }: { name: string }) {
  const iconName = ICON_MAP[name] || ICON_MAP.other;
  const LucideIcon = (LucideIcons[iconName] as LucideIcons.LucideIcon) || LucideIcons.Circle;
  return <LucideIcon size={22} strokeWidth={1.9} />;
}

function formatMoneyWithLang(value: number, lang: Lang = "ru") {
  return new Intl.NumberFormat(intlLocale(lang), { style: "currency", currency: "RSD", maximumFractionDigits: 0 }).format(value);
}

function ExpenseRow({
  expense,
  lang,
  t,
  onLongPress,
}: {
  expense: Expense;
  lang: Lang;
  t: Translator;
  onLongPress: () => void;
}) {
  // Иконка строки траты остаётся нейтральной: цвет категории используется
  // только для плашек категорий и секторов диаграммы (без перекрашивания иконок)
  const { date, time } = useMemo(() => {
    const d = new Date(expense.createdAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
      date: `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    };
  }, [expense.createdAt]);

  const pressTimer = useRef<number | undefined>(undefined);

  const startPress = () => {
    pressTimer.current = window.setTimeout(() => {
      onLongPress();
    }, 650);
  };

  const endPress = () => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
  };

  return (
    <button
      className="expense-row"
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="expense-icon">{expense.category?.icon ? <Icon name={expense.category.icon} /> : "•"}</span>
      <div className="expense-info">
        <strong>{expense.description || expense.category?.name || t("expenseFallback")}</strong>
        <small>{expense.category?.name ?? t("categoryOther")}</small>
      </div>
      <div className="expense-amount">
        <b>−{formatMoneyWithLang(expense.amount, lang)}</b>
        <time>{date} {time}</time>
      </div>
    </button>
  );
}

// Ловим ошибки отрисовки jsbarcode (они происходят внутри useEffect компонента
// react-barcode и не ловятся обычным try/catch) — вместо падения показываем QR
class CodeErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Не удалось отрисовать штрих-код, показываю QR-код:", error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// Рендер кода карты: 1D-штрих-код (EAN13/EAN8/CODE128) → 2D QR-код как fallback.
// CodeErrorBoundary — аналог try/catch: ошибки jsbarcode происходят внутри useEffect
// компонента react-barcode и обычным try/catch не ловятся, поэтому вместо пустой
// белой плашки автоматически рендерится QR-код.
function CardCodeView({ card, t }: { card: LoyaltyCard; t: Translator }) {
  if (!card.code) {
    return <p className="loyalty-codes-empty">{t("cardNoCode")}</p>;
  }

  const qrFallback = (
    <div className="loyalty-code-qr">
      <QRCodeSVG
        value={card.code}
        // size задаёт внутреннюю систему координат (квадратный viewBox)
        // и фиксированный размер 230px — QR не растягивается во всю ширину,
        // а остаётся квадратным в центре белой плашки
        size={230}
        // Стандартный уровень коррекции ошибок (Medium) — подойдёт для длинных строк,
        // обеспечивая хорошую плотность матрицы, как в официальном приложении Idea / Super Kartica
        level="M"
        // Белые отступы (quiet zone) по краям — обязательно для сканеров на кассе,
        // которые могут не прочитать код без полей
        includeMargin={true}
        bgColor="#ffffff"
        fgColor="#000000"
      />
    </div>
  );

  let format: BarcodeFormat | null = null;
  if (card.format === "barcode") {
    const detected = barcodeFormatFor(card.code);
    if (barcodeValueOk(card.code, detected)) {
      format = detected;
    } else if (isAsciiPrintable(card.code)) {
      // Невалидный EAN (например, битая контрольная сумма) — универсальный Code128
      format = "CODE128";
    }
    // Непечатный ASCII (кириллица и т.п.) — рендерим QR-код ниже
  }

  if (!format) {
    return qrFallback;
  }

  return (
    <div className="loyalty-code-box">
      {/* key сбрасывает состояние boundary при смене карты/кода */}
      <CodeErrorBoundary key={`${card.id}-${card.code}`} fallback={qrFallback}>
        {/* Пропорции как на референсе Maxi: плотные штрихи (width 2.2), компактная высота (55),
            margin 0 — компактный код без лишних отступов, строго одна высота штрихов */}
        <Barcode
          value={card.code}
          format={format}
          width={2.2}
          height={55}
          margin={0}
          displayValue={false}
          background="#ffffff"
          lineColor="#000000"
        />
      </CodeErrorBoundary>
    </div>
  );
}

function evaluateExpression(expression: string): number {
  try {
    const sanitized = expression.replace(/,/g, ".");
    const result = Function(`"use strict"; return (${sanitized})`)();
    if (typeof result === "number" && isFinite(result)) {
      return Math.round(result);
    }
    return NaN;
  } catch {
    return NaN;
  }
}

function App() {
  const telegram = window.Telegram?.WebApp;
  const [dashboard, setDashboard] = useState<Dashboard>();
  // Язык интерфейса: автоопределение (Telegram/браузер) + переключатель в шапке
  const [lang, setLang] = useState<Lang>(loadLang);
  const [activeTab, setActiveTab] = useState<Tab>("chart");
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [showCategoryForm, setShowCategoryForm] = useState(false);
  const [showGoalForm, setShowGoalForm] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category>();
  const [editingExpense, setEditingExpense] = useState<Expense>();
  const [editingGoal, setEditingGoal] = useState<SavingsGoal>();
  const [goalTopUpGoal, setGoalTopUpGoal] = useState<SavingsGoal>();
  const [goalOperationType, setGoalOperationType] = useState<"add" | "withdraw" | null>(null);
  const [goalIconValue, setGoalIconValue] = useState("goal");
  const [expenseCategory, setExpenseCategory] = useState<Category>();
  const [selectedMonth, setSelectedMonth] = useState(currentMonthKey);
  // Категория, выбранная тапом в сетке на экране графиков: её часть диаграммы
  // показывается крупнее и подписывается именем в центре кольца
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | undefined>(undefined);
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const [categoryIconValue, setCategoryIconValue] = useState("other");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [expandedAccId, setExpandedAccId] = useState<Set<string>>(new Set());
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
  const [loyaltyCards, setLoyaltyCards] = useState<LoyaltyCard[]>([]);
  const [showCardForm, setShowCardForm] = useState(false);
  const [expandedCard, setExpandedCard] = useState<LoyaltyCard>();
  const categoryPressTimer = useRef<number | undefined>(undefined);
  const didLongPress = useRef(false);
  const goalPressTimer = useRef<number | undefined>(undefined);
  const goalDidLongPress = useRef(false);
  const operatorInputRef = useRef<HTMLInputElement | null>(null);
  const amountInputRef = useRef<HTMLInputElement | null>(null);

  // ===== Локализация (RU / EN) =====
  // t — переводчик; локальная обёртка formatMoney сохраняет имя функции,
  // чтобы не менять десятки мест вызова внутри компонента
  const t = useMemo(() => makeT(lang), [lang]);
  const formatMoney = (value: number) => formatMoneyWithLang(value, lang);
  const iconLabel = (icon: string) => ICON_LABELS[lang][icon] ?? ICON_LABELS.ru[icon] ?? "•";
  const toggleLang = () =>
    setLang((current) => {
      const next: Lang = current === "ru" ? "en" : "ru";
      saveLang(next);
      return next;
    });

  // Сброс прокрутки страницы при открытии клавиатуры (предотвращает сдвиг окна вверх)
// Сброс прокрутки страницы при открытии клавиатуры (предотвращает сдвиг окна вверх)
useEffect(() => {
  const handleFocusIn = (e: FocusEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
      window.scrollTo(0, 0);
      document.body.scrollTop = 0;
    }
  };

  document.addEventListener("focusin", handleFocusIn);
  return () => document.removeEventListener("focusin", handleFocusIn);
}, []);

// Инициализация Telegram WebApp
useEffect(() => {
  if (window.Telegram?.WebApp) {
    window.Telegram.WebApp.ready();
    window.Telegram.WebApp.expand();
    // Mini App закрывается сразу, без всплывающего подтверждения Telegram
    window.Telegram.WebApp.disableClosingConfirmation?.();
  }
}, []);

  // Автофокус на поле суммы при выборе категории
  useEffect(() => {
    if (expenseCategory && amountInputRef.current) {
      amountInputRef.current?.focus();
      operatorInputRef.current = amountInputRef.current;
    }
  }, [expenseCategory]);

  // Уход с экрана аналитики (тапы по нижней навигации вне main) снимает выбор
  useEffect(() => {
    if (activeTab !== "chart") setSelectedCategoryId(undefined);
  }, [activeTab]);

  const insertOperator = (op: string) => {
    const input = operatorInputRef.current;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const newValue = input.value.slice(0, start) + op + input.value.slice(end);
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    nativeSetter?.call(input, newValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const newPos = start + op.length;
    input.setSelectionRange(newPos, newPos);
    input.focus();
  };

  // Реалтайм-подписка на Firestore
  useEffect(() => {
    telegram?.ready();
    // @ts-ignore
    telegram?.setViewportSettings?.({ expand: true, animation: false });
    

    const userId = getUserId();
    const userDocRef = doc(db, "users", userId);

    const unsubscribe = onSnapshot(
      userDocRef,
      (docSnap) => {
        if (docSnap.exists()) {
          setDashboard(docSnap.data() as Dashboard);
        } else {
          const initialDashboard = defaultDashboard(lang);
          void setDoc(userDocRef, initialDashboard);
          setDashboard(initialDashboard);
        }
      },
      (err) => {
        console.error("Firestore error:", err);
        setError(t("cloudError"));
      }
    );

    return () => unsubscribe();
  }, []);

  // Realtime-подписка на карты лояльности (подколлекция users/{userId}/loyalty_cards)
  useEffect(() => {
    const cardsQuery = query(collection(db, "users", getUserId(), "loyalty_cards"), orderBy("createdAt", "desc"));
    return onSnapshot(
      cardsQuery,
      (snapshot) => {
        setLoyaltyCards(snapshot.docs.map((cardDoc) => ({ id: cardDoc.id, ...(cardDoc.data() as Omit<LoyaltyCard, "id">) })));
      },
      (err) => console.error("Firestore loyalty_cards error:", err),
    );
  }, []);

  const saveToFirebase = async (updated: Dashboard) => {
    const userId = getUserId();
    await setDoc(doc(db, "users", userId), updated);
  };

  const filteredExpenses = useMemo(() => {
    if (!dashboard?.expenses) return [];
    return dashboard.expenses.filter((e) => {
      if (!e.createdAt) return false;
      return e.createdAt.startsWith(selectedMonth);
    });
  }, [dashboard, selectedMonth]);

  const filteredTotalSpent = useMemo(() => {
    return filteredExpenses.reduce((sum, e) => sum + e.amount, 0);
  }, [filteredExpenses]);

  const addCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("categoryName") ?? "").trim();
    const icon = String(form.get("categoryIcon") ?? "other");
    const budgetStr = String(form.get("budget") ?? "").trim();
    const budgetAmount = budgetStr ? evaluateExpression(budgetStr) : 0;

    if (!name || !dashboard) return;

    setIsSubmitting(true);
    setError(undefined);
    try {
      const newCategory: Category = {
        id: String(Date.now()),
        name,
        icon,
        color: null,
        ...(budgetAmount > 0 ? { budgets: { [selectedMonth]: budgetAmount } } : {}),
      };
      const updated: Dashboard = {
        ...dashboard,
        categories: [...dashboard.categories, newCategory],
      };

      await saveToFirebase(updated);
      formElement.reset();
      setShowCategoryForm(false);
    } catch {
      setError(t("categoryAddError"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const addExpense = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const amountStr = String(form.get("amount") ?? "").trim();
    const amount = evaluateExpression(amountStr);
    const description = String(form.get("description") ?? "");
    const categoryId = String(form.get("categoryId") ?? "");

    if (!amountStr || !amount || amount <= 0 || !dashboard) return;

    setIsSubmitting(true);
    setError(undefined);
    try {
      const category = dashboard.categories.find((c) => c.id === categoryId) || null;
      const newExpense: Expense = {
        id: String(Date.now()),
        amount,
        description,
        createdAt: new Date().toISOString(),
        category,
      };

      const newExpenses = [newExpense, ...dashboard.expenses];
      const updated: Dashboard = {
        ...dashboard,
        expenses: newExpenses,
        totalSpent: newExpenses.reduce((sum, e) => sum + e.amount, 0),
      };

      await saveToFirebase(updated);
      formElement.reset();
      setShowExpenseForm(false);
      setExpenseCategory(undefined);
    } catch {
      setError(t("expenseAddError"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const updateCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingCategory || !dashboard) return;

    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("categoryName") ?? "").trim();
    const icon = String(form.get("categoryIcon") ?? "other");
    const budgetStr = String(form.get("budget") ?? "").trim();
    const budgetAmount = budgetStr ? evaluateExpression(budgetStr) : 0;

    if (!name) return;

    setIsSubmitting(true);
    setError(undefined);
    try {
      const budgets = { ...(editingCategory.budgets || {}) };
      if (budgetAmount > 0) {
        budgets[selectedMonth] = budgetAmount;
      } else {
        delete budgets[selectedMonth];
      }

      const updatedCategories = dashboard.categories.map((c) =>
        c.id === editingCategory.id ? { ...c, name, icon, budgets } : c
      );

      // Обновляем ссылку на категорию во всех привязанных тратах
      const updatedExpenses = dashboard.expenses.map((e) => {
        if (e.category?.id === editingCategory.id) {
          return { ...e, category: { ...e.category, name, icon, budgets } };
        }
        return e;
      });

      await saveToFirebase({ ...dashboard, categories: updatedCategories, expenses: updatedExpenses });
      setEditingCategory(undefined);
    } catch {
      setError(t("categoryUpdateError"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const updateExpense = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingExpense || !dashboard) return;

    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const localDateTime = `${String(form.get("date"))}T${String(form.get("time"))}`;
    const createdAt = new Date(localDateTime);

    if (Number.isNaN(createdAt.getTime())) {
      setError(t("invalidDateTime"));
      return;
    }

    const amountStr = String(form.get("amount") ?? "").trim();
    const amount = evaluateExpression(amountStr);
    const description = String(form.get("description") ?? "");
    const categoryId = String(form.get("categoryId") ?? "");
    const category = dashboard.categories.find((c) => c.id === categoryId) || null;

    if (!amountStr || !amount || amount <= 0) {
      setError(t("invalidAmount"));
      return;
    }

    setIsSubmitting(true);
    setError(undefined);
    try {
      const updatedExpenses = dashboard.expenses.map((e) =>
        e.id === editingExpense.id
          ? { ...e, amount, description, category, createdAt: createdAt.toISOString() }
          : e
      );

      await saveToFirebase({
        ...dashboard,
        expenses: updatedExpenses,
        totalSpent: updatedExpenses.reduce((sum, e) => sum + e.amount, 0),
      });
      setEditingExpense(undefined);
    } catch {
      setError(t("expenseUpdateError"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const deleteCategory = async () => {
    if (!editingCategory || !dashboard || !window.confirm(t("confirmDeleteCategory", { name: editingCategory.name }))) return;

    setIsSubmitting(true);
    setError(undefined);
    try {
      const updatedCategories = dashboard.categories.filter((c) => c.id !== editingCategory.id);
      // Убираем категорию из расходов
      const updatedExpenses = dashboard.expenses.map((e) =>
        e.category?.id === editingCategory.id ? { ...e, category: null } : e
      );

      await saveToFirebase({ ...dashboard, categories: updatedCategories, expenses: updatedExpenses });
      setEditingCategory(undefined);
    } catch {
      setError(t("categoryDeleteError"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const deleteExpense = async () => {
    if (!editingExpense || !dashboard || !window.confirm(t("confirmDeleteExpense"))) return;

    setIsSubmitting(true);
    setError(undefined);
    try {
      const updatedExpenses = dashboard.expenses.filter((e) => e.id !== editingExpense.id);

      await saveToFirebase({
        ...dashboard,
        expenses: updatedExpenses,
        totalSpent: updatedExpenses.reduce((sum, e) => sum + e.amount, 0),
      });
      setEditingExpense(undefined);
    } catch {
      setError(t("expenseDeleteError"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const addGoal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("goalName") ?? "").trim();
    const targetStr = String(form.get("targetAmount") ?? "").trim();
    const targetAmount = evaluateExpression(targetStr);
    const icon = String(form.get("goalIcon") ?? "goal");

    if (!name || !targetAmount || targetAmount <= 0 || !dashboard) return;

    setIsSubmitting(true);
    setError(undefined);
    try {
      const newGoal: SavingsGoal = {
        id: String(Date.now()),
        name,
        targetAmount,
        savedAmount: 0,
        icon,
        color: null,
        createdAt: new Date().toISOString(),
      };
      const updated: Dashboard = {
        ...dashboard,
        savingsGoals: [...(dashboard.savingsGoals ?? []), newGoal],
      };

      await saveToFirebase(updated);
      formElement.reset();
      setShowGoalForm(false);
    } catch {
      setError(t("goalAddError"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const updateGoal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingGoal || !dashboard) return;

    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("goalName") ?? "").trim();
    const targetStr = String(form.get("targetAmount") ?? "").trim();
    const targetAmount = evaluateExpression(targetStr);
    const icon = String(form.get("goalIcon") ?? "goal");

    if (!name || !targetAmount || targetAmount <= 0) return;

    setIsSubmitting(true);
    setError(undefined);
    try {
      const updatedGoals = (dashboard.savingsGoals ?? []).map((g) =>
        g.id === editingGoal.id ? { ...g, name, targetAmount, icon } : g
      );

      await saveToFirebase({ ...dashboard, savingsGoals: updatedGoals });
      setEditingGoal(undefined);
    } catch {
      setError(t("goalUpdateError"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const deleteGoal = async () => {
    if (!editingGoal || !dashboard || !window.confirm(t("confirmDeleteGoal", { name: editingGoal.name }))) return;

    setIsSubmitting(true);
    setError(undefined);
    try {
      const updatedGoals = (dashboard.savingsGoals ?? []).filter((g) => g.id !== editingGoal.id);
      await saveToFirebase({ ...dashboard, savingsGoals: updatedGoals });
      setEditingGoal(undefined);
    } catch {
      setError(t("goalDeleteError"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const adjustGoalAmount = async (formElement: HTMLFormElement, mode: "add" | "withdraw") => {
    if (!goalTopUpGoal || !goalOperationType || !dashboard) return;

    const form = new FormData(formElement);
    const amountStr = String(form.get("topUpAmount") ?? "").trim();
    const amount = evaluateExpression(amountStr);
    if (!amountStr || !amount || amount <= 0) return;

    setIsSubmitting(true);
    setError(undefined);
    try {
      const updatedGoals = (dashboard.savingsGoals ?? []).map((g) =>
        g.id === goalTopUpGoal.id
          ? { ...g, savedAmount: mode === "add" ? g.savedAmount + amount : Math.max(0, g.savedAmount - amount) }
          : g
      );

      await saveToFirebase({ ...dashboard, savingsGoals: updatedGoals });
      formElement.reset();
      setGoalTopUpGoal(undefined);
      setGoalOperationType(null);
    } catch {
      setError(t("goalSaveError"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const startGoalPress = (goal: SavingsGoal) => {
    goalDidLongPress.current = false;
    goalPressTimer.current = window.setTimeout(() => {
      goalDidLongPress.current = true;
      setEditingGoal(goal);
      setGoalIconValue(goal.icon || "goal");
      setIconPickerOpen(false);
    }, 650);
  };

  const endGoalPress = () => {
    if (goalPressTimer.current) window.clearTimeout(goalPressTimer.current);
  };

  const startCategoryPress = (category: Category) => {
    didLongPress.current = false;
    categoryPressTimer.current = window.setTimeout(() => {
      didLongPress.current = true;
      setEditingCategory(category);
      setCategoryIconValue(category.icon || "other");
      setIconPickerOpen(false);
    }, 650);
  };

  const endCategoryPress = () => {
    if (categoryPressTimer.current) window.clearTimeout(categoryPressTimer.current);
  };

  // Тап по категории выбирает её (повторный тап снимает выбор) — выбранная
  // категория показывается на диаграмме крупнее с подписью имени
  const toggleCategorySelection = (categoryId: string) => {
    setSelectedCategoryId((current) => (current === categoryId ? undefined : categoryId));
  };

  // Сброс выбора «мимо графика»: тап вне диаграммы и вне карточек категорий
  // (пустое место под сеткой, промежутки сетки, другие экраны) снимает выбор.
  // Правила и список «своих» блоков — в ./chartInteraction
  const handleOutsideChartTap = (event: ReactMouseEvent<HTMLElement>) => {
    setSelectedCategoryId((current) =>
      nextSelectedCategoryIdOnOutsideTap(event.target as HTMLElement | null, current)
    );
  };

  const categoryStats = useMemo<CategoryStat[]>(() => {
    const data = new Map<string, { id: string; name: string; amount: number; color: import("./categoryColors").CategoryColor }>();

    filteredExpenses.forEach((expense) => {
      const key = expense.category?.id ?? "other";
      const name = expense.category?.name ?? t("categoryOther");
      const current = data.get(key) ?? {
        id: key,
        name,
        amount: 0,
        // Палитра детерминированно выводится из названия: одинаковые категории
        // в диаграмме и в сетке всегда получают один и тот же hue
        color: getCategoryColor(name),
      };
      current.amount += expense.amount;
      data.set(key, current);
    });

    // Секторы рисуются по убыванию суммы, поэтому порядок в массиве = порядок
    // секторов на кольце. Пересчитываем hue золотым сечением (шаг 137.5°):
    // цвета остаются из той же палитры, что у карточек категорий, но у соседних
    // секторов hue разводится, чтобы они не сливались
    return [...data.values()]
      .sort((a, b) => b.amount - a.amount)
      .map((item, index) => ({
        ...item,
        color: getCategoryColor(item.name, index * GOLDEN_RATIO_STEP),
      }));
  }, [filteredExpenses, t]);

  // Цвета плашек категорий в сетке под графиком = цвета их секторов на диаграмме
  const categoryColorById = useMemo(
    () => new Map(categoryStats.map((item) => [item.id, item.color])),
    [categoryStats]
  );

  const chartTotal = useMemo(
    () => categoryStats.reduce((sum, item) => sum + item.amount, 0),
    [categoryStats]
  );

  // Данные выбранной категории: имя всегда берём из списка категорий (у неё
  // может не быть трат в этом месяце), сумму и цвет — из статистики, если есть
  const selectedCategoryMeta = useMemo(() => {
    if (!selectedCategoryId) return undefined;
    const stat = categoryStats.find((item) => item.id === selectedCategoryId);
    const name = stat?.name ?? dashboard?.categories.find((item) => item.id === selectedCategoryId)?.name;
    // Категория удалена или id устарел — считаем, что выбор снят
    if (!name) return undefined;
    const color = stat?.color ?? getCategoryColor(name);
    return {
      id: selectedCategoryId,
      name,
      amount: stat?.amount ?? 0,
      color,
    };
  }, [categoryStats, dashboard, selectedCategoryId]);

  // Диаграмма: выбранная категория показывается крупнее, остальные — приглушённо.
  // Передаём id из selectedCategoryMeta: если категория удалена или id устарел,
  // билдер получает undefined и диаграмма остаётся обычной (без приглушения всех секторов)
  const chartBackground = useMemo(
    () => buildChartGradient(categoryStats, selectedCategoryMeta?.id),
    [categoryStats, selectedCategoryMeta?.id]
  );

  // Подпись в центре кольца: без выбора — месяц целиком, с выбором — имя
  // выбранной категории, её сумма и доля в тратах месяца
  const donutLabel = selectedCategoryMeta?.name ?? t("total");
  const donutAmount = selectedCategoryMeta ? selectedCategoryMeta.amount : chartTotal;
  const donutPercent =
    selectedCategoryMeta && chartTotal > 0
      ? Math.round((selectedCategoryMeta.amount / chartTotal) * 100)
      : undefined;

  const user = telegram?.initDataUnsafe?.user;
  // Категории в выпадающих списках и сетке — по алфавиту (учитывая язык интерфейса)
  const sortedCategories = [...(dashboard?.categories ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name, intlLocale(lang))
  );
  const [selectedYear, selectedMonthNumber] = selectedMonth.split("-").map(Number);
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const startYear = dashboard?.userCreatedAt ? new Date(dashboard.userCreatedAt).getFullYear() : currentYear;
  const monthNames = MONTHS[lang];

  const changeMonthPart = (year: number, month: number) => {
    let targetMonth = month;
    if (year === currentYear && month > currentMonth) targetMonth = currentMonth;
    setSelectedMonth(`${year}-${String(targetMonth).padStart(2, "0")}`);
    // В другом месяце у категории могут быть совсем другие траты — выбор снимаем
    setSelectedCategoryId(undefined);
    setShowMonthPicker(false);
  };

  const groupedExpenses = useMemo(() => {
    const grouped = new Map<string, Expense[]>();
    filteredExpenses.forEach((ex) => {
      const key = ex.category?.id ?? "other";
      const group = grouped.get(key) ?? [];
      group.push(ex);
      grouped.set(key, group);
    });

    // Внутри каждой категории траты сортируются по алфавиту (описание/название)
    grouped.forEach((expenses, key) => {
      grouped.set(
        key,
        [...expenses].sort((a, b) =>
          (a.description || a.category?.name || "").localeCompare(
            b.description || b.category?.name || "",
            intlLocale(lang),
          ),
        ),
      );
    });

    // Сами группы категорий — тоже по алфавиту (стабильный порядок аккордеона)
    return new Map(
      [...grouped.entries()].sort((a, b) => {
        const nameA = a[1][0]?.category?.name ?? t("categoryOther");
        const nameB = b[1][0]?.category?.name ?? t("categoryOther");
        return nameA.localeCompare(nameB, intlLocale(lang));
      }),
    );
  }, [filteredExpenses, lang, t]);

  const toggleAccordion = (id: string) => {
    const next = new Set(expandedAccId);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedAccId(next);
  };

  // ===== iOS Action Sheet («+» меню) =====
  const openAddMenu = () => {
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("medium");
    console.log("Open add menu");
    setIsAddMenuOpen(true);
  };

  const closeAddMenu = () => setIsAddMenuOpen(false);

  // Свайп вниз по шиту закрывает меню
  const onSheetTouchStart = (e: React.TouchEvent) => {
    (e.currentTarget as HTMLDivElement).setAttribute("data-sy", String(e.touches[0].clientY));
  };

  const onSheetTouchMove = (e: React.TouchEvent) => {
    const sheet = e.currentTarget as HTMLDivElement;
    const startY = Number(sheet.getAttribute("data-sy") ?? "");
    if (Number.isNaN(startY)) return;
    const dy = Math.max(0, e.touches[0].clientY - startY);
    sheet.style.transition = "none";
    sheet.style.transform = `translateY(${dy}px)`;
  };

  const onSheetTouchEnd = (e: React.TouchEvent) => {
    const sheet = e.currentTarget as HTMLDivElement;
    const startY = Number(sheet.getAttribute("data-sy") ?? "");
    sheet.style.transition = "";
    sheet.style.transform = "";
    if (!Number.isNaN(startY) && e.changedTouches[0].clientY - startY > 60) {
      closeAddMenu();
    }
    sheet.removeAttribute("data-sy");
  };

  // Закрытие по Escape (для десктопа)
  useEffect(() => {
    if (!isAddMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAddMenu();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isAddMenuOpen]);

  // ===== Нативный QR-сканер Telegram + парсинг чека =====
  const [isReceiptLoading, setIsReceiptLoading] = useState(false);
  const [parsedReceipt, setParsedReceipt] = useState<{
    dateTime: string | null;
    items: { name: string; qty: number; price: number; total: number; category: string | null }[];
    total: number;
  }>();
  const [receiptError, setReceiptError] = useState<string>();

  const parseReceipt = async (receiptUrl: string) => {
    setIsReceiptLoading(true);
    setReceiptError(undefined);
    try {
      // --- Адрес API (serverless-функция на Vercel) ---
      // VITE_API_URL задаётся при сборке (см. apps/mini-app/.env):
      //   production (GitHub Pages): https://<project>.vercel.app
      //   dev: пусто -> vite проксирует /api -> http://localhost:3001
      // Клиент НИКОГДА не обращается к localhost, если открыт не на localhost.
      const isLocalPage = ["localhost", "127.0.0.1"].includes(window.location.hostname);
      const apiUrl = (import.meta.env.VITE_API_URL || "").trim().replace(/\/+$/, "");

      if (!apiUrl) {
        if (!isLocalPage) {
          throw new Error(t("apiNotConfigured"));
        }
      } else if (/change-me|your-app|example\.com/i.test(apiUrl)) {
        throw new Error(t("apiPlaceholder", { url: apiUrl }));
      } else if (!isLocalPage && /^(https?:\/\/)?(localhost|127\.0\.0\.1)/i.test(apiUrl)) {
        throw new Error(t("apiLocalhost", { url: apiUrl }));
      }

      if (!apiUrl) {
        console.info("[receipt] VITE_API_URL пуст — dev-режим, запрос через vite-прокси /api -> localhost:3001");
      }

      const response = await fetch(`${apiUrl}/api/receipts/parse`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Совместимость, если VITE_API_URL указывает на ngrok Free (interstitial-страница).
          // На Vercel-функции заголовок просто игнорируется.
          "ngrok-skip-browser-warning": "true",
        },
        // categories — названия категорий пользователя, чтобы Gemini вернул их же
        // (если не передать, функция использует дефолтный список из ТЗ)
        // categoryCache — сопоставления «товар -> категория» из Firestore:
        // сервер подставит их без обращения к Gemini (экономия токенов)
        body: JSON.stringify({
          qrUrl: receiptUrl,
          categories: dashboard?.categories.map((c) => c.name),
          categoryCache: await readItemCategoryCache(getUserId()),
        }),
      });

      const payload = (await response.json().catch(() => null)) as { error?: string; dateTime?: string | null; items?: { name: string; qty: number; price: number; total: number; category: string | null }[]; total?: number } | null;

      if (!response.ok || !payload || !payload.items) {
        console.error("API Error Details:", { status: response.status, statusText: response.statusText, url: response.url, payload });
        throw new Error(payload?.error || `Ошибка API: HTTP ${response.status}`);
      }

      setParsedReceipt({
        dateTime: payload.dateTime ?? null,
        items: payload.items,
        total: payload.total ?? payload.items.reduce((sum, item) => sum + item.total, 0),
      });
    } catch (error) {
      console.error("API Error Details:", error);
      console.error("API Error Message:", error instanceof Error ? error.message : String(error));
      setReceiptError(error instanceof Error ? error.message : t("receiptLoadError"));
    } finally {
      setIsReceiptLoading(false);
    }
  };

  const handleQrReceived = (data?: { data?: string }) => {
    const receiptUrl = data?.data;
    if (!receiptUrl) return;
    // QR получен — закрываем сканер и отписываемся от событий
    telegram?.offEvent("qrTextReceived", handleQrReceived);
    telegram?.offEvent("scanQrPopupClosed", handleReceiptScanClosed);
    telegram?.closeScanQrPopup?.();
    void parseReceipt(receiptUrl);
  };

  // Попап нативного сканера закрыт без результата — снимаем подписки,
  // чтобы обработчик не «стрелял» при следующих сканированиях
  const handleReceiptScanClosed = () => {
    telegram?.offEvent("qrTextReceived", handleQrReceived);
    telegram?.offEvent("scanQrPopupClosed", handleReceiptScanClosed);
  };

  // Черновики позиций чека: название, сумма и категория, отредактированные вручную.
  // ВАЖНО: черновик хранит только реально изменённые поля — ручной выбор категории
  // меняет исключительно привязку категории и НЕ трогает сумму позиции,
  // поэтому итог чека не «списывается» при смене категории
  const [receiptDrafts, setReceiptDrafts] = useState<Record<number, Partial<{ name: string; amount: number; categoryId: string }>>>({});

  const setReceiptDraft = (index: number, patch: Partial<{ name: string; amount: number; categoryId: string }>) => {
    setReceiptDrafts((prev) => ({ ...prev, [index]: { ...(prev[index] ?? {}), ...patch } }));
  };

  const closeReceipt = () => {
    setParsedReceipt(undefined);
    setReceiptDrafts({});
    setReceiptError(undefined);
  };

  const receiptItemName = (index: number) => receiptDrafts[index]?.name ?? parsedReceipt?.items[index]?.name ?? "";
  // Сумма позиции: только явно отредактированное валидное значение,
  // иначе — исходная стоимость из чека (мусор/NaN/пустое поле игнорируем)
  const receiptItemAmount = (index: number) => {
    const draftAmount = receiptDrafts[index]?.amount;
    if (draftAmount !== undefined && Number.isFinite(draftAmount) && draftAmount > 0) return draftAmount;
    return parsedReceipt?.items[index]?.total ?? 0;
  };
  const receiptItemCategoryId = (index: number) => {
    const draftId = receiptDrafts[index]?.categoryId;
    if (draftId !== undefined) return draftId;
    const aiName = parsedReceipt?.items[index]?.category;
    return dashboard?.categories.find((c) => c.name === aiName)?.id ?? "";
  };

  // «Сохранить все траты»: создаёт отдельную трату на каждую позицию чека
  const confirmReceipt = async () => {
    if (!parsedReceipt || !dashboard) return;

    const includedIndexes = parsedReceipt.items.map((_, index) => index);
    if (includedIndexes.length === 0) return;

    const createdAt = receiptDateToIso(parsedReceipt.dateTime) || new Date().toISOString();

    const newExpenses: Expense[] = includedIndexes.map((index, order) => {
      const item = parsedReceipt.items[index];
      const categoryId = receiptItemCategoryId(index);
      const category = dashboard.categories.find((c) => c.id === categoryId) || null;
      return {
        id: `${Date.now()}-${order}`,
        amount: receiptItemAmount(index),
        description: receiptItemName(index).trim() || item.name,
        createdAt,
        category,
        qty: item.qty,
        unitPrice: item.price,
      };
    });

    try {
      const allExpenses = [...newExpenses, ...dashboard.expenses];
      await saveToFirebase({
        ...dashboard,
        expenses: allExpenses,
        totalSpent: allExpenses.reduce((sum, e) => sum + e.amount, 0),
      });

      // Успешное сохранение чека: фиксируем сопоставления «товар -> категория» в кэше
      const cacheEntries: ItemCategoryCache = {};
      for (const expense of newExpenses) {
        if (!expense.description || !expense.category) continue;
        const key = normalizeItemName(expense.description);
        if (key) cacheEntries[key] = expense.category.name;
      }
      await writeItemCategoryCache(getUserId(), cacheEntries);

      closeReceipt();
    } catch {
      setReceiptError(t("receiptSaveError"));
    }
  };

  const startQrScan = () => {
    closeAddMenu();
    if (!telegram?.showScanQrPopup) {
      console.warn("QR-сканер недоступен: откройте Mini App в Telegram");
      return;
    }
    telegram.onEvent("qrTextReceived", handleQrReceived);
    telegram.onEvent("scanQrPopupClosed", handleReceiptScanClosed);
    telegram.showScanQrPopup({ text: t("scanReceiptHint") });
  };

  // «Ввести вручную» — та же модалка траты, но без предвыбранной категории
  const openManualExpense = () => {
    closeAddMenu();
    setExpenseCategory(MANUAL_NO_CATEGORY);
  };

  // ===== Карты лояльности =====
  const [cardNameDraft, setCardNameDraft] = useState("");
  const [cardCodeDraft, setCardCodeDraft] = useState("");
  const [cardFormError, setCardFormError] = useState<string>();
  const [isCameraScannerOpen, setIsCameraScannerOpen] = useState(false);
  const html5ScannerRef = useRef<import("html5-qrcode").Html5Qrcode | null>(null);
  const cardScanHandledRef = useRef(false);

  // Остановка веб-сканера (html5-qrcode). Ref обнуляем сразу, чтобы не остановить дважды.
  const stopCameraScanner = async () => {
    const scanner = html5ScannerRef.current;
    if (!scanner) return;
    html5ScannerRef.current = null;
    try {
      await scanner.stop();
      scanner.clear();
    } catch (error) {
      console.warn("Остановка веб-сканера:", error);
    }
  };

  const openCameraScanner = () => {
    cardScanHandledRef.current = false;
    setCardFormError(undefined);
    setIsCameraScannerOpen(true);
  };

  const closeCameraScanner = async () => {
    await stopCameraScanner();
    setIsCameraScannerOpen(false);
  };

  // Веб-сканер камеры (html5-qrcode): читает EAN-13/EAN-8/UPC/Code128/Code39/ITF/QR —
  // то, что нативный сканер Telegram часто игнорирует для 1D штрих-кодов
  useEffect(() => {
    if (!isCameraScannerOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
        const scanner = new Html5Qrcode("card-scanner-region", {
          formatsToSupport: [
            Html5QrcodeSupportedFormats.QR_CODE,
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.UPC_E,
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.ITF,
          ],
          verbose: false,
        });
        html5ScannerRef.current = scanner;
        await scanner.start(
          { facingMode: "environment" },
          {
            fps: 10,
            // Широкая и невысокая зона сканирования — оптимальна для 1D штрих-кодов
            qrbox: (viewfinderWidth: number, viewfinderHeight: number) => {
              const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
              return { width: Math.round(minEdge * 0.9), height: Math.round(minEdge * 0.55) };
            },
          },
          (decodedText: string) => {
            if (cardScanHandledRef.current) return;
            cardScanHandledRef.current = true;
            window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
            setCardCodeDraft(cleanScannedCode(decodedText));
            void closeCameraScanner();
          },
          () => {
            // Кадр без кода — штатная ситуация, пропускаем
          },
        );
        if (cancelled) void closeCameraScanner();
      } catch (error) {
        console.error("Веб-сканер недоступен:", error);
        if (!cancelled) {
          setIsCameraScannerOpen(false);
          setCardFormError(t("cameraOpenError"));
        }
      }
    })();
    return () => {
      cancelled = true;
      void stopCameraScanner();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCameraScannerOpen]);

  // Нативный сканер Telegram: получен текст из QR/штрих-кода
  const handleCardCodeReceived = (data?: { data?: string }) => {
    const raw = data?.data?.trim();
    if (!raw) return;
    cardScanHandledRef.current = true;
    telegram?.offEvent("qrTextReceived", handleCardCodeReceived);
    telegram?.offEvent("scanQrPopupClosed", handleCardScanPopupClosed);
    telegram?.closeScanQrPopup?.();
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
    setCardCodeDraft(cleanScannedCode(raw));
  };

  // Нативный сканер закрыт без результата — вероятно, это 1D штрих-код, который
  // Telegram не распознал. Автоматически открываем веб-сканер как fallback.
  const handleCardScanPopupClosed = () => {
    telegram?.offEvent("qrTextReceived", handleCardCodeReceived);
    telegram?.offEvent("scanQrPopupClosed", handleCardScanPopupClosed);
    if (!cardScanHandledRef.current) openCameraScanner();
  };

  const startCardCodeScan = () => {
    setCardFormError(undefined);
    cardScanHandledRef.current = false;
    if (telegram?.showScanQrPopup) {
      telegram.onEvent("qrTextReceived", handleCardCodeReceived);
      telegram.onEvent("scanQrPopupClosed", handleCardScanPopupClosed);
      telegram.showScanQrPopup({ text: t("scanCardHint") });
      return;
    }
    // Нативный сканер недоступен (обычный браузер) — сразу включаем веб-сканер
    openCameraScanner();
  };

  // Поддержка клавиатуры Telegram: при фокусе на поле прокручиваем его в видимую
  // область модалки, чтобы «Сохранить»/«Отмена» оставались доступны
  const scrollFieldIntoView = (event: ReactFocusEvent<HTMLElement>) => {
    const target = event.currentTarget;
    window.setTimeout(() => target.scrollIntoView({ block: "center", behavior: "smooth" }), 250);
  };

  const addLoyaltyCard = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("cardName") ?? "").trim();
    const code = cardCodeDraft.trim();
    const formatChoice = String(form.get("cardFormat") ?? "auto");

    if (!name || !code) return;

    const format: "qr" | "barcode" = formatChoice === "auto" ? detectCardFormat(code) : (formatChoice as "qr" | "barcode");
    const cardId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      await setDoc(doc(db, "users", getUserId(), "loyalty_cards", cardId), {
        name,
        code,
        format,
        createdAt: new Date().toISOString(),
      });
      setShowCardForm(false);
      setCardNameDraft("");
      setCardCodeDraft("");
      setCardFormError(undefined);
    } catch {
      setCardFormError(t("cardSaveError"));
    }
  };

  const removeLoyaltyCard = async (card: LoyaltyCard) => {
    if (!window.confirm(t("confirmDeleteCard", { name: card.name }))) return;
    try {
      await deleteDoc(doc(db, "users", getUserId(), "loyalty_cards", card.id));
      setExpandedCard(undefined);
    } catch {
      setError(t("cardDeleteError"));
    }
  };

  const isModalOpen = editingExpense || editingCategory || showCategoryForm || expenseCategory || showGoalForm || editingGoal || goalTopUpGoal || isReceiptLoading || parsedReceipt || showCardForm || expandedCard;

  // Кнопка переключения языка (RU ⇄ EN) — общий элемент шапки
  const langToggle = (
    <button
      type="button"
      className="lang-toggle"
      onClick={(e) => {
        e.stopPropagation();
        toggleLang();
      }}
      aria-label={t("langAria")}
      title={t("langAria")}
    >
      {lang === "ru" ? "RU" : "EN"}
    </button>
  );

  return (
    <main
      className={isModalOpen ? "modal-open" : ""}
      onClick={(event) => {
        setShowMonthPicker(false);
        setIconPickerOpen(false);
        handleOutsideChartTap(event);
      }}
    >
      <header className="categories-header">
        {activeTab === "savings" ? (
          <>
            <div className="month-control">
              <button className="month-picker" onClick={(e) => { e.stopPropagation(); setShowMonthPicker((v) => !v); }}>
                <span>{t("yearLabel", { year: selectedYear })}</span>
              </button>
              {showMonthPicker && (
                <div className="month-menu" style={{ gridTemplateColumns: "1fr" }} onClick={(e) => e.stopPropagation()}>
                  <select value={selectedYear} onChange={(event) => changeMonthPart(Number(event.target.value), selectedMonthNumber)}>
                    {Array.from({ length: Math.max(1, currentYear - startYear + 1) }, (_, index) => currentYear - index).map((year) => (
                      <option key={year} value={year}>{year}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="header-actions">
              {langToggle}
              <div className="avatar">{user?.first_name?.slice(0, 1) ?? "S"}</div>
            </div>
          </>
        ) : (
          <>
            <div className="month-control">
              <button className="month-picker" onClick={(e) => { e.stopPropagation(); setShowMonthPicker((v) => !v); }}>
                <span>{formatMonth(selectedMonth, lang)}</span>
              </button>
              {showMonthPicker && (
                <div className="month-menu" onClick={(e) => e.stopPropagation()}>
                  <select value={selectedMonthNumber} onChange={(event) => changeMonthPart(selectedYear, Number(event.target.value))}>
                    {monthNames.map((month, index) => (
                      <option key={month} value={index + 1} disabled={selectedYear === currentYear && index + 1 > currentMonth}>
                        {month}
                      </option>
                    ))}
                  </select>
                  <select value={selectedYear} onChange={(event) => changeMonthPart(Number(event.target.value), selectedMonthNumber)}>
                    {Array.from({ length: Math.max(1, currentYear - startYear + 1) }, (_, index) => currentYear - index).map((year) => (
                      <option key={year} value={year}>{year}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="header-actions">
              {langToggle}
              <div className="month-total">
                <b>{formatMoney(filteredTotalSpent)}</b>
              </div>
            </div>
          </>
        )}
      </header>

      {error && <p className="notice">{error}</p>}

      {activeTab === "expenses" && (
        <>
          <div className="section-title"><h2>{t("recentExpenses")}</h2></div>
          {editingExpense && (() => {
            const initialDateTime = toLocalDateTime(editingExpense.createdAt);
            return (
              <div 
                className="modal-backdrop" 
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) {
                    setEditingExpense(undefined);
                  }
                }}
              >
                <form className="expense-modal expense-modal--plain" onSubmit={updateExpense} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                  <input name="amount" type="text" inputMode="numeric" defaultValue={String(editingExpense.amount)} placeholder={t("amountPlaceholder")} required onFocus={(e) => { operatorInputRef.current = e.currentTarget; }} />
                  <input name="description" maxLength={300} defaultValue={editingExpense.description ?? ""} placeholder={t("description")} />
                  <div className="select-wrapper">
                    <select name="categoryId" defaultValue={editingExpense.category?.id ?? ""}>
                      <option value="">{t("categoryOther")}</option>
                      {sortedCategories.map((category) => (
                        <option key={category.id} value={category.id}>{category.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="date-time">
                    <input name="date" type="date" defaultValue={initialDateTime.date} required />
                    <input name="time" type="time" defaultValue={initialDateTime.time} required />
                  </div>
                  <div className="button-row">
                    <button type="submit" disabled={isSubmitting}>{isSubmitting ? t("saving") : t("save")}</button>
                    <button type="button" className="danger-button" disabled={isSubmitting} onClick={deleteExpense}>{t("delete")}</button>
                  </div>
                </form>
              </div>
            );
          })()}

          <div className="accordion-list">
            <div className="accordion-item">
                  <button className={`accordion-trigger ${expandedAccId.has("all") ? "inactive" : ""}`} onClick={() => toggleAccordion("all")}>
                    <span>{t("allExpenses")}</span>
                    <div className="accordion-right">
                      <b>{formatMoney(filteredTotalSpent)}</b>
                      <Icon name="arrow" />
                    </div>
                  </button>
                  {expandedAccId.has("all") && (
                    <div className="accordion-content list-card">
                      {filteredExpenses.map((ex) => (
                        <ExpenseRow key={ex.id} expense={ex} lang={lang} t={t} onLongPress={() => setEditingExpense(ex)} />
                      ))}
                    </div>
                  )}
            </div>

            {[...groupedExpenses.entries()].map(([catId, expenses]) => {
              const category = expenses[0].category;
              const total = expenses.reduce((sum, e) => sum + e.amount, 0);
              // Тот же цвет, что у плашки на «Графике» и у сектора диаграммы
              const categoryColor =
                categoryColorById.get(catId) ?? getCategoryColor(category?.name ?? t("categoryOther"));
              return (
                <div className="accordion-item accordion-item--category" key={catId} style={{ background: categoryColor.bg }}>
                  <button className={`accordion-trigger ${expandedAccId.has(catId) ? "active" : ""}`} onClick={() => toggleAccordion(catId)}>
                    <div className="accordion-left">
                      <span className="mini-icon">{category?.icon ? <Icon name={category.icon} /> : "•"}</span>
                      <span>{category?.name ?? t("categoryOther")}</span>
                    </div>
                    <div className="accordion-right">
                      <b>{formatMoney(total)}</b>
                      <Icon name="arrow" />
                    </div>
                  </button>
                  {expandedAccId.has(catId) && (
                    <div className="accordion-content list-card">
                      {expenses.map((ex) => (
                        <ExpenseRow key={ex.id} expense={ex} lang={lang} t={t} onLongPress={() => setEditingExpense(ex)} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {!filteredExpenses.length && <p className="empty">{t("noExpensesMonth")}</p>}
        </>
      )}

      {/* Модалки категорий — на корневом уровне, чтобы «Добавить категорию» работала и из вкладки «График» */}
      {editingCategory ? (
            <div 
              className="modal-backdrop" 
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                  setEditingCategory(undefined);
                }
              }}
            >
              <form className="expense-modal expense-modal--plain" onSubmit={updateCategory} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                <input name="categoryName" maxLength={50} defaultValue={editingCategory.name} placeholder={t("categoryName")} required autoFocus />
                
                <div className="budget-icon-row">
                  <input name="budget" type="text" inputMode="numeric" defaultValue={String(editingCategory.budgets?.[selectedMonth] || "")} placeholder={t("planned")} />

                  <div className="icon-dropdown">
                    <input type="hidden" name="categoryIcon" value={categoryIconValue} />
                    <button type="button" className="icon-dropdown-trigger" onClick={(e) => { e.stopPropagation(); setIconPickerOpen((o) => !o); }}>
                      <span className="icon-dropdown-icon"><Icon name={categoryIconValue} /></span>
                      <span className="icon-dropdown-label">{iconLabel(categoryIconValue)}</span>
                      <span className="icon-dropdown-arrow"><Icon name="arrow" /></span>
                    </button>
                    {iconPickerOpen && (
                      <div className="icon-dropdown-panel" onClick={(e) => e.stopPropagation()}>
                        {CATEGORY_ICONS.map((icon) => {
                          return (
                            <button
                              type="button"
                              key={icon}
                              className={`icon-dropdown-option${categoryIconValue === icon ? " selected" : ""}`}
                              onClick={() => { setCategoryIconValue(icon); setIconPickerOpen(false); }}
                            >
                              <Icon name={icon} />
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
                <div className="button-row">
                  <button type="submit" disabled={isSubmitting}>{isSubmitting ? t("saving") : t("save")}</button>
                  <button type="button" className="danger-button" disabled={isSubmitting} onClick={deleteCategory}>{t("delete")}</button>
                </div>
              </form>
            </div>
          ) : showCategoryForm ? (
            <div className="modal-backdrop" onClick={() => setShowCategoryForm(false)}>
              <form className="expense-modal expense-modal--plain" onSubmit={addCategory} onClick={(e) => e.stopPropagation()}>
                <input name="categoryName" maxLength={50} placeholder={t("categoryName")} required autoFocus />
                <div className="budget-icon-row">
                  <input name="budget" type="text" inputMode="numeric" placeholder={t("planned")} onFocus={(e) => { operatorInputRef.current = e.currentTarget; }} />

                  <div className="icon-dropdown">
                    <input type="hidden" name="categoryIcon" value={categoryIconValue} />
                    <button type="button" className="icon-dropdown-trigger" onClick={(e) => { e.stopPropagation(); setIconPickerOpen((o) => !o); }}>
                      <span className="icon-dropdown-icon"><Icon name={categoryIconValue} /></span>
                      <span className="icon-dropdown-label">{iconLabel(categoryIconValue)}</span>
                      <span className="icon-dropdown-arrow"><Icon name="arrow" /></span>
                    </button>
                    {iconPickerOpen && (
                      <div className="icon-dropdown-panel" onClick={(e) => e.stopPropagation()}>
                        {CATEGORY_ICONS.map((icon) => {
                          return (
                            <button
                              type="button"
                              key={icon}
                              className={`icon-dropdown-option${categoryIconValue === icon ? " selected" : ""}`}
                              onClick={() => { setCategoryIconValue(icon); setIconPickerOpen(false); }}
                            >
                              <Icon name={icon} />
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
                <button type="submit" disabled={isSubmitting}>{isSubmitting ? t("creating") : t("create")}</button>
              </form>
            </div>
          ) : null}

      {activeTab === "chart" && (
        <div className="chart-tab">
          {/* ===== Sticky-блок: диаграмма не уходит при скролле ===== */}
          <section className="chart-card chart-card--sticky">
            <div
              className={`donut${selectedCategoryMeta ? " donut--selected" : ""}`}
              style={{
                background: chartBackground,
                // Подсветка кольца цветом выбранной категории (chart — плотный цвет сектора)
                boxShadow: selectedCategoryMeta
                  ? `0 0 0 6px color-mix(in srgb, ${selectedCategoryMeta.color.chart} 22%, transparent)`
                  : undefined,
              }}
            >
              <div>
                <small
                  style={{
                    color: selectedCategoryMeta ? selectedCategoryMeta.color.chart : undefined,
                  }}
                >
                  {donutLabel}
                </small>
                <b>{formatMoney(donutAmount)}</b>
                {donutPercent !== undefined && (
                  <span className="donut-share">{donutPercent}% месяца</span>
                )}
              </div>
            </div>
            {/* Легенды нет — суммы и цвета категорий показывает сетка ниже */}
            {categoryStats.length === 0 && <p className="empty">{t("noDataYet")}</p>}
          </section>

          {/* ===== Скроллируемая часть: сетка категорий под графиком ===== */}
          <section className="chart-categories">
            <div className="category-icon-grid">
              {sortedCategories.map((category) => {
                // Тот же цвет, что у сектора диаграммы: сначала берём цвет из
                // статистики (там уже посчитан от названия), иначе считаем хэш
                const categoryColor =
                  categoryColorById.get(category.id) ?? getCategoryColor(category.name);
                const isSelected = category.id === selectedCategoryId;
                const categoryStat = categoryStats.find((item) => item.id === category.id);
                return (
                <button
                  className={`category-icon-button${isSelected ? " selected" : ""}`}
                  key={category.id}
                  aria-pressed={isSelected}
                  style={{
                    background: categoryColor.bg,
                    border: `1px solid ${categoryColor.border}`,
                    // Кольцо-разрыв в цвете категории: видно и вне плашки
                    boxShadow: isSelected
                      ? `0 0 0 2.5px var(--bg-color), 0 0 0 5px ${categoryColor.chart}`
                      : undefined,
                  }}
                  onPointerDown={() => startCategoryPress(category)}
                  onPointerUp={endCategoryPress}
                  onPointerCancel={endCategoryPress}
                  onContextMenu={(e) => e.preventDefault()}
                  onClick={() => {
                    if (didLongPress.current) {
                      didLongPress.current = false;
                      return;
                    }
                    // Тап выбирает категорию: её часть на диаграмме показывается
                    // крупнее с подписью имени; редактирование — только long press
                    toggleCategorySelection(category.id);
                  }}
                >
                  <span className="category-icon-wrapper">
                    <Icon name={category.icon || "other"} />
                  </span>
                  <b>{category.name}</b>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px' }}>
                    <small>{formatMoney(categoryStat?.amount ?? 0)}</small>
                    {category.budgets?.[selectedMonth] && (
                      <small style={{ fontSize: '9px', opacity: 0.8 }}>{t("budgetFrom", { amount: formatMoney(category.budgets[selectedMonth]) })}</small>
                    )}
                  </div>
                </button>
                );
              })}
              {/* Кнопка «Добавить категорию» — последний элемент сетки */}
              <button
                className="category-icon-button add-category-button"
                onClick={() => {
                  setEditingCategory(undefined);
                  setCategoryIconValue("other");
                  setIconPickerOpen(false);
                  setShowCategoryForm(true);
                }}
              >
                <span><Icon name="plus" /></span>
                <b>{t("add")}</b>
                <small style={{ fontSize: '9px' }}>{'\u00A0'}</small>
              </button>
            </div>
          </section>
        </div>
      )}

      {activeTab === "savings" && (
        <>
          {editingGoal ? (
            <div 
              className="modal-backdrop" 
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                  setEditingGoal(undefined);
                }
              }}
            >
              <form className="expense-modal expense-modal--plain" onSubmit={updateGoal} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                <input name="goalName" maxLength={50} defaultValue={editingGoal.name} placeholder={t("goalName")} required autoFocus />
                <div className="budget-icon-row">
                  <input name="targetAmount" type="text" inputMode="numeric" defaultValue={String(editingGoal.targetAmount)} placeholder={t("goalTarget")} required onFocus={(e) => { operatorInputRef.current = e.currentTarget; }} />
                  <div className="icon-dropdown">
                    <input type="hidden" name="goalIcon" value={goalIconValue} />
                    <button type="button" className="icon-dropdown-trigger" onClick={(e) => { e.stopPropagation(); setIconPickerOpen((o) => !o); }}>
                      <span className="icon-dropdown-icon"><Icon name={goalIconValue} /></span>
                      <span className="icon-dropdown-label">{iconLabel(goalIconValue)}</span>
                      <span className="icon-dropdown-arrow"><Icon name="arrow" /></span>
                    </button>
                    {iconPickerOpen && (
                      <div className="icon-dropdown-panel" onClick={(e) => e.stopPropagation()}>
                        {CATEGORY_ICONS.map((icon) => (
                          <button
                            type="button"
                            key={icon}
                            className={`icon-dropdown-option${goalIconValue === icon ? " selected" : ""}`}
                            onClick={() => { setGoalIconValue(icon); setIconPickerOpen(false); }}
                          >
                            <Icon name={icon} />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="button-row">
                  <button type="submit" disabled={isSubmitting}>{isSubmitting ? t("saving") : t("save")}</button>
                  <button type="button" className="danger-button" disabled={isSubmitting} onClick={deleteGoal}>{t("delete")}</button>
                </div>
              </form>
            </div>
          ) : showGoalForm ? (
            <div className="modal-backdrop" onClick={() => setShowGoalForm(false)}>
              <form className="expense-modal expense-modal--plain" onSubmit={addGoal} onClick={(e) => e.stopPropagation()}>
                <input name="goalName" maxLength={50} placeholder={t("goalName")} required autoFocus />
                <div className="budget-icon-row">
                  <input name="targetAmount" type="text" inputMode="numeric" placeholder={t("goalTarget")} required onFocus={(e) => { operatorInputRef.current = e.currentTarget; }} />
                  <div className="icon-dropdown">
                    <input type="hidden" name="goalIcon" value={goalIconValue} />
                    <button type="button" className="icon-dropdown-trigger" onClick={(e) => { e.stopPropagation(); setIconPickerOpen((o) => !o); }}>
                      <span className="icon-dropdown-icon"><Icon name={goalIconValue} /></span>
                      <span className="icon-dropdown-label">{iconLabel(goalIconValue)}</span>
                      <span className="icon-dropdown-arrow"><Icon name="arrow" /></span>
                    </button>
                    {iconPickerOpen && (
                      <div className="icon-dropdown-panel" onClick={(e) => e.stopPropagation()}>
                        {CATEGORY_ICONS.map((icon) => (
                          <button
                            type="button"
                            key={icon}
                            className={`icon-dropdown-option${goalIconValue === icon ? " selected" : ""}`}
                            onClick={() => { setGoalIconValue(icon); setIconPickerOpen(false); }}
                          >
                            <Icon name={icon} />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <button type="submit" disabled={isSubmitting}>{isSubmitting ? t("creating") : t("createGoal")}</button>
              </form>
            </div>
          ) : goalTopUpGoal && goalOperationType ? (
            <div 
              className="modal-backdrop" 
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                  setGoalTopUpGoal(undefined);
                  setGoalOperationType(null);
                }
              }}
            >
              <form className="expense-modal expense-modal--plain" onSubmit={(e) => { e.preventDefault(); void adjustGoalAmount(e.currentTarget, goalOperationType); }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                <div className="goal-topup-title">
                  <span className="goal-topup-icon"><Icon name={goalTopUpGoal.icon || "goal"} /></span>
                  <div>
                    <b>{goalTopUpGoal.name}</b>
                    <small>{formatMoney(goalTopUpGoal.savedAmount)} {t("goalOf")} {formatMoney(goalTopUpGoal.targetAmount)}</small>
                  </div>
                </div>
                <input name="topUpAmount" type="text" inputMode="numeric" placeholder={t("amountLabel")} required autoFocus onFocus={(e) => { operatorInputRef.current = e.currentTarget; }} />
                <div className="button-row">
                  <button type="submit" disabled={isSubmitting}>{isSubmitting ? t("saving") : t("save")}</button>
                </div>
              </form>
            </div>
          ) : null}

          {(dashboard?.savingsGoals?.length ?? 0) === 0 ? (
            <section className="savings-card">
              <span className="savings-icon"><Icon name="goal" /></span>
              <h2>{t("firstGoalTitle")}</h2>
              <p>{t("firstGoalSubtitle")}</p>
              <button type="button" onClick={() => { setEditingGoal(undefined); setGoalIconValue("goal"); setIconPickerOpen(false); setShowGoalForm(true); }}>{t("addGoal")}</button>
            </section>
          ) : (
            <div className="goals-list">
              {(dashboard?.savingsGoals ?? []).map((goal) => {
                const progress = goal.targetAmount > 0 ? Math.min(100, Math.round((goal.savedAmount / goal.targetAmount) * 100)) : 0;
                const isDone = goal.savedAmount >= goal.targetAmount;
                return (
                  <div className={`goal-card${isDone ? " goal-card--done" : ""}`} key={goal.id}>
                    <button
                      className="goal-card-main"
                      onPointerDown={() => startGoalPress(goal)}
                      onPointerUp={endGoalPress}
                      onPointerCancel={endGoalPress}
                      onContextMenu={(e) => e.preventDefault()}
                    >
                      <span className="goal-card-icon"><Icon name={goal.icon || "goal"} /></span>
                      <div className="goal-card-info">
                        <div className="goal-card-head">
                          <b>{goal.name}</b>
                          <span className="goal-card-percent">{progress}%</span>
                        </div>
                        <div className="goal-progress-track">
                          <div className="goal-progress-fill" style={{ width: `${progress}%` }} />
                        </div>
                        <div className="goal-card-amounts">
                          <small>{formatMoney(goal.savedAmount)}</small>
                          <small>{t("goalOf")} {formatMoney(goal.targetAmount)}</small>
                        </div>
                      </div>
                    </button>
                    <div className="goal-card-actions">
                      <button type="button" onClick={() => { setGoalTopUpGoal(goal); setGoalOperationType("add"); }}>{t("topUp")}</button>
                      <button type="button" className="goal-card-withdraw" onClick={() => { setGoalTopUpGoal(goal); setGoalOperationType("withdraw"); }}>{t("withdraw")}</button>
                    </div>
                  </div>
                );
              })}
              <button
                className="add-goal-button"
                onClick={() => {
                  setEditingGoal(undefined);
                  setGoalIconValue("goal");
                  setIconPickerOpen(false);
                  setShowGoalForm(true);
                }}
              >
                <Icon name="plus" />
                <span>{t("newGoal")}</span>
              </button>
            </div>
          )}
        </>
      )}

      {activeTab === "cards" && (
        <>
          {loyaltyCards.length === 0 ? (
            <section className="savings-card">
              <span className="savings-icon"><Icon name="loyalty" /></span>
              <h2>{t("loyaltyTitle")}</h2>
              <p>{t("loyaltySubtitle")}</p>
              <button type="button" onClick={() => { setCardNameDraft(""); setCardCodeDraft(""); setCardFormError(undefined); setShowCardForm(true); }}>{t("addCard")}</button>
            </section>
          ) : (
            <div className="cards-list">
              {loyaltyCards.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  className="loyalty-card"
                  onClick={() => {
                    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
                    setExpandedCard(card);
                  }}
                >
                  <span className="loyalty-card-icon"><Icon name="loyalty" /></span>
                  <div className="loyalty-card-info">
                    <strong>{card.name}</strong>
                    <small>{shortCardCode(card.code)}</small>
                  </div>
                  <Icon name="arrow" />
                </button>
              ))}
              <button
                type="button"
                className="add-card-button"
                onClick={() => { setCardNameDraft(""); setCardCodeDraft(""); setCardFormError(undefined); setShowCardForm(true); }}
              >
                <Icon name="plus" />
                <span>{t("addCard")}</span>
              </button>
            </div>
          )}
        </>
      )}

      <nav className={`floating-tab-bar${isModalOpen ? " tab-bar-hidden" : ""}`} aria-label={t("navAria")}>
        {/* SVG-фон бара: скруглённые края + плавная выемка (arc/curve) вокруг центральной FAB */}
        <svg className="tab-bar-shape" viewBox="0 0 390 64" preserveAspectRatio="none" aria-hidden="true">
          <path
            d="M 32 0
               H 127
               C 141 0 147 5 154 18
               C 161 31 178 48 195 48
               C 212 48 229 31 236 18
               C 243 5 249 0 263 0
               H 358
               A 32 32 0 0 1 390 32
               A 32 32 0 0 1 358 64
               H 32
               A 32 32 0 0 1 0 32
               A 32 32 0 0 1 32 0
               Z"
          />
        </svg>
        <button
          type="button"
          className={activeTab === "chart" ? "active" : ""}
          onClick={() => {
            window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
            setActiveTab("chart");
          }}
        >
          <Icon name="chart" />
          <span>{t("tabChart")}</span>
        </button>
        <button
          type="button"
          className={activeTab === "expenses" ? "active" : ""}
          onClick={() => {
            window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
            setActiveTab("expenses");
          }}
        >
          <Icon name="card" />
          <span>{t("tabExpenses")}</span>
        </button>
        <button
          type="button"
          className="fab-button"
          aria-label={t("addAria")}
          onClick={openAddMenu}
        />
        <button
          type="button"
          className={activeTab === "cards" ? "active" : ""}
          onClick={() => {
            window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
            setActiveTab("cards");
          }}
        >
          <Icon name="loyalty" />
          <span>{t("tabCards")}</span>
        </button>
        <button
          type="button"
          className={activeTab === "savings" ? "active" : ""}
          onClick={() => {
            window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
            setActiveTab("savings");
          }}
        >
          <Icon name="goal" />
          <span>{t("tabSavings")}</span>
        </button>
      </nav>

      {/* ===== Модалка добавления траты (категория опциональна; доступна с любой вкладки) ===== */}
      {expenseCategory && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setExpenseCategory(undefined);
            }
          }}
        >
          <form className="expense-modal expense-modal--plain" onSubmit={addExpense} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <div className="input-with-operators">
              <input name="amount" type="text" inputMode="numeric" placeholder={t("amountPlaceholder")} required ref={amountInputRef} onFocus={(e) => { operatorInputRef.current = e.currentTarget; }} />
              <div className="operator-bar">
                {["+", "-", "*", "/"].map((op) => (
                  <button key={op} type="button" className="operator-btn" onClick={() => insertOperator(op)}>{op === "*" ? "×" : op === "/" ? "÷" : op}</button>
                ))}
              </div>
            </div>
            {/* Категории — по алфавиту; «Остальное» (пустое значение) — позиция без категории */}
            <select name="categoryId" value={expenseCategory?.id ?? ""} onChange={(e) => setExpenseCategory(e.target.value === "" ? MANUAL_NO_CATEGORY : (dashboard?.categories.find((c) => c.id === e.target.value) ?? MANUAL_NO_CATEGORY))}>
              <option value="">{t("categoryOther")}</option>
              {sortedCategories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
            <input name="description" maxLength={300} placeholder={t("description")} />
            <button type="submit" disabled={isSubmitting}>{isSubmitting ? t("saving") : t("save")}</button>
          </form>
        </div>
      )}

      {/* ===== Лоадер парсинга чека ===== */}
      {isReceiptLoading && (
        <div className="modal-backdrop receipt-backdrop">
          <div className="receipt-loader">
            <span className="receipt-spinner" />
            <p>{t("receiptParsing")}</p>
            <small>{t("receiptParsingHint")}</small>
          </div>
        </div>
      )}

      {/* ===== Ошибка парсинга чека ===== */}
      {receiptError && !isReceiptLoading && (
        <div className="modal-backdrop" onClick={() => setReceiptError(undefined)}>
          <div className="expense-modal expense-modal--plain" onClick={(e) => e.stopPropagation()}>
            <p className="receipt-error-text">{receiptError}</p>
            <button type="button" onClick={() => setReceiptError(undefined)}>{t("okGotIt")}</button>
          </div>
        </div>
      )}

      {/* ===== Модалка подтверждения транзакций из чека ===== */}
      {parsedReceipt && !isReceiptLoading && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeReceipt();
          }}
        >
          <form
            className="expense-modal expense-modal--plain receipt-modal"
            onSubmit={(e) => { e.preventDefault(); void confirmReceipt(); }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="receipt-modal-header">
              <b>{t("receiptTitle")}</b>
              {parsedReceipt.dateTime && <span className="receipt-date">🗓 {parsedReceipt.dateTime}</span>}
              <small>{t("receiptHint")}</small>
            </div>

            <div className="receipt-items">
              {parsedReceipt.items.map((item, index) => {
                return (
                  <div key={`${item.name}-${index}`} className="receipt-item">
                    <div className="receipt-item-info">
                      {/* Название товара — редактируемое поле */}
                      <input
                        type="text"
                        maxLength={300}
                        className="receipt-name-input"
                        defaultValue={item.name}
                        onChange={(e) => setReceiptDraft(index, { name: e.target.value })}
                        onFocus={(e) => { operatorInputRef.current = e.currentTarget; }}
                        aria-label={t("itemNameAria", { name: item.name })}
                      />
                      <small className="receipt-item-qty">{item.qty} × {formatMoney(item.price)}</small>
                      {/* Стоимость + категория — в одну строку */}
                      <div className="receipt-item-controls">
                        <input
                          type="text"
                          inputMode="decimal"
                          className="receipt-amount-input"
                          defaultValue={String(item.total)}
                          onFocus={(e) => { operatorInputRef.current = e.currentTarget; }}
                          onChange={(e) => setReceiptDraft(index, { amount: evaluateExpression(e.target.value) })}
                          placeholder={String(item.total)}
                          aria-label={t("itemAmountAria", { name: item.name })}
                        />
                        <select
                          value={receiptItemCategoryId(index)}
                          onChange={(e) => {
                            // Ручной выбор категории меняет ТОЛЬКО привязку категории
                            // позиции: сумма позиции и итог чека не пересчитываются
                            setReceiptDraft(index, { categoryId: e.target.value });
                            // Смена категории — сразу обновляем кэш «товар -> категория»
                            const selectedCategory = dashboard?.categories.find((c) => c.id === e.target.value);
                            if (selectedCategory) {
                              const key = normalizeItemName(item.name);
                              if (key) void writeItemCategoryCache(getUserId(), { [key]: selectedCategory.name });
                            }
                          }}
                          aria-label={t("itemCategoryAria", { name: item.name })}
                        >
                          <option value="">{t("categoryOther")}</option>
                          {sortedCategories.map((category) => (
                            <option key={category.id} value={category.id}>{category.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                );
              })}
              {parsedReceipt.items.length === 0 && (
                <p className="empty">{t("noReceiptItems")}</p>
              )}
            </div>

            <div className="receipt-total">
              <span>{t("total")}</span>
              <b>{formatMoney(parsedReceipt.items.reduce((sum, _, index) => sum + (receiptItemAmount(index) || 0), 0))}</b>
            </div>

            <div className="button-row">
              <button type="submit" disabled={isSubmitting}>
                {isSubmitting ? t("saving") : t("save")}
              </button>
              <button type="button" className="danger-button" onClick={closeReceipt}>{t("cancel")}</button>
            </div>
          </form>
        </div>
      )}

      {/* ===== Модалка добавления карты лояльности ===== */}
      {showCardForm && (
        <div className="modal-backdrop" onClick={() => setShowCardForm(false)}>
          <form
            className="expense-modal expense-modal--plain expense-modal--card"
            onSubmit={(e) => { e.preventDefault(); void addLoyaltyCard(e); }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              name="cardName"
              maxLength={60}
              placeholder={t("cardNamePlaceholder")}
              required
              autoFocus
              value={cardNameDraft}
              onChange={(e) => setCardNameDraft(e.target.value)}
              onFocus={scrollFieldIntoView}
            />
            <div className="card-code-row">
              <input
                name="cardCode"
                maxLength={100}
                placeholder={t("cardCodePlaceholder")}
                required
                value={cardCodeDraft}
                onChange={(e) => { setCardCodeDraft(e.target.value); setCardFormError(undefined); }}
                onFocus={(e) => { operatorInputRef.current = e.currentTarget; scrollFieldIntoView(e); }}
              />
              <button type="button" className="card-scan-button" onClick={startCardCodeScan} aria-label={t("scanCardHint")}>
                <Icon name="loyalty" />
              </button>
            </div>
            <select name="cardFormat" defaultValue="auto" onFocus={scrollFieldIntoView}>
              <option value="auto">{t("formatAuto")}</option>
              <option value="barcode">{t("formatBarcode")}</option>
              <option value="qr">{t("formatQr")}</option>
            </select>
            {isCameraScannerOpen && (
              <div className="card-scanner-box">
                <div id="card-scanner-region" />
                <p className="card-scanner-hint">{t("cameraHint")}</p>
                <button
                  type="button"
                  className="card-scanner-stop"
                  onClick={() => void closeCameraScanner()}
                >
                  {t("stopCamera")}
                </button>
              </div>
            )}
            {cardFormError && <p className="receipt-error-text">{cardFormError}</p>}
            <div className="button-row">
              <button type="submit" disabled={isSubmitting}>{t("saveCard")}</button>
              <button type="button" className="danger-button" onClick={() => setShowCardForm(false)}>{t("cancel")}</button>
            </div>
          </form>
        </div>
      )}

      {/* ===== Полноэкранный показ кода карты (для кассы) ===== */}
      {expandedCard && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setExpandedCard(undefined);
          }}
        >
          <div className="loyalty-fullscreen" onClick={(e) => e.stopPropagation()}>
            <b>{expandedCard.name}</b>
            <small className="loyalty-fullscreen-code">{shortCardCode(expandedCard.code, 44)}</small>
            <div className="loyalty-codes">
              <CardCodeView key={expandedCard.id} card={expandedCard} t={t} />
            </div>
            <div className="button-row">
              <button type="button" onClick={() => setExpandedCard(undefined)}>{t("collapse")}</button>
              <button type="button" className="danger-button" onClick={() => void removeLoyaltyCard(expandedCard)}>{t("delete")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== iOS Action Sheet: «+» меню ===== */}
      {isAddMenuOpen && (
        <div
          className="add-menu-backdrop"
          onClick={closeAddMenu}
          aria-hidden="false"
          role="presentation"
        >
          <div
            className="add-menu-sheet"
            role="dialog"
            aria-label={t("addExpenseAria")}
            onTouchStart={onSheetTouchStart}
            onTouchMove={onSheetTouchMove}
            onTouchEnd={onSheetTouchEnd}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="add-menu-grabber" />
            <button
              type="button"
              className="add-menu-item"
              onClick={startQrScan}
            >
              {t("scanReceipt")}
            </button>
            <button
              type="button"
              className="add-menu-item"
              onClick={openManualExpense}
            >
              {t("manualEntry")}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);