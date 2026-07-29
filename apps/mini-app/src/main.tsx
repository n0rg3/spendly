import { StrictMode, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import * as LucideIcons from "lucide-react";
import "./styles.css";

type Category = { id: string; name: string; icon: string | null; color: string | null };
type Expense = { id: string; amount: number; description: string | null; createdAt: string; category: Category | null };
type Dashboard = { categories: Category[]; expenses: Expense[]; totalSpent: number; userCreatedAt: string };
type Tab = "categories" | "expenses" | "chart" | "savings";

const tabItems: { id: Tab; label: string; icon: string }[] = [
  { id: "categories", label: "Категории", icon: "grid" },
  { id: "expenses", label: "Траты", icon: "card" },
  { id: "chart", label: "График", icon: "chart" },
  { id: "savings", label: "Накопления", icon: "goal" },
];

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

function formatMonth(value: string) {
  const [year, month] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" })
    .format(new Date(year, month - 1, 1));
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
};

const CATEGORY_ICONS = Object.keys(ICON_MAP).filter((key) => !["grid", "card", "chart", "goal", "plus", "arrow"].includes(key));

const ICON_LABELS: Record<string, string> = {
  food: "Еда",
  transport: "Транспорт",
  shopping: "Покупки",
  ent: "Развлечения",
  health: "Здоровье",
  home: "Дом",
  gift: "Подарки",
  wallet: "Кошелёк",
  coffee: "Кофе",
  book: "Книга",
  movie: "Кино",
  music: "Музыка",
  phone: "Телефон",
  travel: "Путешествие",
  sport: "Спорт",
  education: "Образование",
  pet: "Питомец",
  beauty: "Красота",
  clothing: "Одежда",
  other: "Другое",
  baby: "Дети",
  bank: "Банк",
  beer: "Алкоголь",
  bike: "Велосипед",
  bus: "Автобус",
  camera: "Фото",
  clapper: "Видео",
  cloud: "Облако",
  coins: "Монеты",
  game: "Игры",
  gas: "Бензин",
  glasses: "Зрение",
  icecream: "Десерты",
  lamp: "Свет",
  leaf: "Природа",
  paint: "Творчество",
  pizza: "Пицца",
  receipt: "Чеки",
  scissors: "Услуги",
  tools: "Инструменты",
  train: "Поезд",
  tv: "ТВ",
  umbrella: "Зонт",
  wine: "Вино",
  wrench: "Ремонт",
};

function Icon({ name }: { name: string }) {
  const iconName = ICON_MAP[name] || ICON_MAP.other;
  const LucideIcon = (LucideIcons[iconName] as LucideIcons.LucideIcon) || LucideIcons.Circle;
  return <LucideIcon size={22} strokeWidth={1.9} />;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(value);
}

function ExpenseRow({ expense, onClick }: { expense: Expense; onClick: () => void }) {
  return (
    <button className="expense-row" onClick={onClick}>
      <span className="expense-icon">{expense.category?.icon ? <Icon name={expense.category.icon} /> : "•"}</span>
      <div>
        <strong>{expense.description || expense.category?.name || "Расход"}</strong>
        <small>{expense.category?.name ?? "Без категории"}</small>
      </div>
      <b>−{formatMoney(expense.amount)}</b>
    </button>
  );
}

function App() {
  const telegram = window.Telegram?.WebApp;
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [activeTab, setActiveTab] = useState<Tab>("categories");
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [showCategoryForm, setShowCategoryForm] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category>();
  const [editingExpense, setEditingExpense] = useState<Expense>();
  const [expenseCategory, setExpenseCategory] = useState<Category>();
  const [selectedMonth, setSelectedMonth] = useState(currentMonthKey);
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const [categoryIconValue, setCategoryIconValue] = useState("other");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [expandedAccId, setExpandedAccId] = useState<Set<string>>(new Set(["all"]));
  const categoryPressTimer = useRef<number | undefined>(undefined);
  const didLongPress = useRef(false);

  const request = async <T,>(path: string, options?: RequestInit): Promise<T> => {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...(options?.body ? { "Content-Type": "application/json" } : {}),
        ...(telegram?.initData ? { Authorization: `tma ${telegram.initData}` } : {}),
        ...options?.headers,
      },
    });
    const data = response.status === 204
      ? ({} as T & { error?: string })
      : (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Не удалось выполнить запрос");
    return data;
  };

  const loadDashboard = async () => {
    try {
      setError(undefined);
      setDashboard(await request<Dashboard>(`/api/dashboard?month=${selectedMonth}`));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить данные");
    }
  };

  useEffect(() => {
    telegram?.ready();
    telegram?.expand();
    void loadDashboard();
  }, [selectedMonth]);

  const addCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("categoryName") ?? "");
    const icon = String(form.get("categoryIcon") ?? "other");
    if (dashboard?.categories.some((c) => c.icon === icon)) {
      setError(`Иконка «${ICON_LABELS[icon] ?? icon}» уже используется`);
      return;
    }
    if (!name.trim()) return;
    setIsSubmitting(true);
    try {
      await request<Category>("/api/categories", { method: "POST", body: JSON.stringify({ name, icon }) });
      formElement.reset();
      setShowCategoryForm(false);
      await loadDashboard();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось создать категорию");
    } finally { setIsSubmitting(false); }
  };

  const addExpense = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setIsSubmitting(true);
    try {
      await request<Expense>("/api/expenses", {
        method: "POST",
        body: JSON.stringify({ amount: Number(form.get("amount")), description: String(form.get("description") ?? ""), categoryId: String(form.get("categoryId") ?? "") || undefined }),
      });
      formElement.reset();
      setShowExpenseForm(false);
      setExpenseCategory(undefined);
      await loadDashboard();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось добавить расход");
    } finally { setIsSubmitting(false); }
  };

  const updateCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingCategory) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("categoryName") ?? "");
    const icon = String(form.get("categoryIcon") ?? "other");
    if (dashboard?.categories.some((c) => c.id !== editingCategory?.id && c.icon === icon)) {
      setError(`Иконка «${ICON_LABELS[icon] ?? icon}» уже используется`);
      return;
    }
    if (!name.trim()) return;
    setIsSubmitting(true);
    try {
      await request<Category>(`/api/categories/${editingCategory.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, icon }),
      });
      setEditingCategory(undefined);
      await loadDashboard();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось изменить категорию");
    } finally { setIsSubmitting(false); }
  };

  const updateExpense = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingExpense) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const localDateTime = `${String(form.get("date"))}T${String(form.get("time"))}`;
    const createdAt = new Date(localDateTime);
    if (Number.isNaN(createdAt.getTime())) {
      setError("Укажите корректные дату и время");
      return;
    }
    setIsSubmitting(true);
    try {
      await request<Expense>(`/api/expenses/${editingExpense.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          amount: Number(form.get("amount")),
          description: String(form.get("description") ?? ""),
          categoryId: String(form.get("categoryId") ?? "") || undefined,
          createdAt: createdAt.toISOString(),
        }),
      });
      setEditingExpense(undefined);
      await loadDashboard();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось изменить трату");
    } finally { setIsSubmitting(false); }
  };

  const deleteCategory = async () => {
    if (!editingCategory || !window.confirm(`Удалить категорию «${editingCategory.name}»?`)) return;
    setIsSubmitting(true);
    try {
      await request<void>(`/api/categories/${editingCategory.id}`, { method: "DELETE" });
      setEditingCategory(undefined);
      await loadDashboard();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось удалить категорию");
    } finally { setIsSubmitting(false); }
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

  const categoryStats = useMemo(() => {
    const data = new Map<string, { id: string; name: string; amount: number; color: string }>();
    const colors = ["var(--button-color)", "color-mix(in srgb, var(--button-color) 80%, white)", "color-mix(in srgb, var(--button-color) 60%, white)", "color-mix(in srgb, var(--button-color) 40%, white)", "color-mix(in srgb, var(--button-color) 20%, white)"];
    dashboard?.expenses.forEach((expense) => {
      const key = expense.category?.id ?? "other";
      const current = data.get(key) ?? { id: key, name: expense.category?.name ?? "Другое", amount: 0, color: expense.category?.color ?? colors[data.size % colors.length] };
      current.amount += expense.amount;
      data.set(key, current);
    });
    return [...data.values()].sort((a, b) => b.amount - a.amount);
  }, [dashboard]);

  const chartBackground = useMemo(() => {
    const total = categoryStats.reduce((sum, item) => sum + item.amount, 0);
    if (!total) return "conic-gradient(#e9ebf3 0 100%)";
    let position = 0;
    return `conic-gradient(${categoryStats.map((item) => {
      const end = position + (item.amount / total) * 100;
      const segment = `${item.color} ${position}% ${end}%`;
      position = end;
      return segment;
    }).join(", ")})`;
  }, [categoryStats]);

  const user = telegram?.initDataUnsafe.user;
  const sortedCategories = [...(dashboard?.categories ?? [])].sort((left, right) => left.name.localeCompare(right.name, "ru"));
  const [selectedYear, selectedMonthNumber] = selectedMonth.split("-").map(Number);
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const startYear = dashboard?.userCreatedAt ? new Date(dashboard.userCreatedAt).getFullYear() : currentYear;
  const monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
  const changeMonthPart = (year: number, month: number) => {
    let targetMonth = month;
    if (year === currentYear && month > currentMonth) targetMonth = currentMonth;
    setSelectedMonth(`${year}-${String(targetMonth).padStart(2, "0")}`);
    setShowMonthPicker(false);
  };

  const groupedExpenses = useMemo(() => {
    const grouped = new Map<string, Expense[]>();
    dashboard?.expenses.forEach((ex) => {
      const key = ex.category?.id ?? "other";
      const group = grouped.get(key) ?? [];
      group.push(ex);
      grouped.set(key, group);
    });
    return grouped;
  }, [dashboard]);

  const toggleAccordion = (id: string) => {
    const next = new Set(expandedAccId);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedAccId(next);
  };

  return <main onClick={() => { setShowMonthPicker(false); setIconPickerOpen(false); }}>
    <header className="categories-header">
      {activeTab === "savings" ? (
        <>
          <div className="month-control">
            <button className="month-picker" onClick={(e) => { e.stopPropagation(); setShowMonthPicker((visible) => !visible); }}>
              <span>{selectedYear} год</span>
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
          <div className="avatar">{user?.first_name?.slice(0, 1) ?? "S"}</div>
        </>
      ) : (
        <>
          <div className="month-control">
            <button className="month-picker" onClick={(e) => { e.stopPropagation(); setShowMonthPicker((visible) => !visible); }}>
              <span>{formatMonth(selectedMonth)}</span>
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
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="month-total">
            <small>Траты за {formatMonth(selectedMonth)}</small>
            <b>{formatMoney(dashboard?.totalSpent ?? 0)}</b>
          </div>
        </>
      )}
    </header>
    {error && <p className="notice">{error}</p>}

    {activeTab === "expenses" && <>
      <div className="section-title"><h2>Последние траты</h2></div>
      {editingExpense && (() => {
        const initialDateTime = toLocalDateTime(editingExpense.createdAt);
        return <div className="modal-backdrop" onClick={() => setEditingExpense(undefined)}><form className="expense-modal" onSubmit={updateExpense} onClick={(e) => e.stopPropagation()}><div className="form-heading"><b>Редактировать</b><button type="button" className="close-button" onClick={() => setEditingExpense(undefined)}>×</button></div><input name="amount" type="number" min="1" step="1" defaultValue={editingExpense.amount} required autoFocus /><input name="description" maxLength={300} defaultValue={editingExpense.description ?? ""} placeholder="Что купили?" /><select name="categoryId" defaultValue={editingExpense.category?.id ?? ""}><option value="">Без категории</option>{dashboard?.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><div className="date-time"><input name="date" type="date" defaultValue={initialDateTime.date} required /><input name="time" type="time" defaultValue={initialDateTime.time} required /></div><button type="submit" disabled={isSubmitting}>{isSubmitting ? "Сохраняю…" : "Сохранить"}</button></form></div>;
      })()}

      <div className="accordion-list">
        <div className="accordion-item">
          <button className={`accordion-trigger ${expandedAccId.has("all") ? "active" : ""}`} onClick={() => toggleAccordion("all")}>
            <span>Все траты</span>
            <div className="accordion-right">
              <b>{formatMoney(dashboard?.totalSpent ?? 0)}</b>
              <Icon name="arrow" />
            </div>
          </button>
          {expandedAccId.has("all") && <div className="accordion-content list-card">{dashboard?.expenses.map(ex => <ExpenseRow key={ex.id} expense={ex} onClick={() => setEditingExpense(ex)} />)}</div>}
        </div>

        {[...groupedExpenses.entries()].map(([catId, expenses]) => {
          const category = expenses[0].category;
          const total = expenses.reduce((sum, e) => sum + e.amount, 0);
          return (
            <div className="accordion-item" key={catId}>
              <button className={`accordion-trigger ${expandedAccId.has(catId) ? "active" : ""}`} onClick={() => toggleAccordion(catId)}>
                <div className="accordion-left">
                  <span className="mini-icon">{category?.icon ? <Icon name={category.icon} /> : "•"}</span>
                  <span>{category?.name ?? "Без категории"}</span>
                </div>
                <div className="accordion-right">
                  <b>{formatMoney(total)}</b>
                  <Icon name="arrow" />
                </div>
              </button>
              {expandedAccId.has(catId) && <div className="accordion-content list-card">{expenses.map(ex => <ExpenseRow key={ex.id} expense={ex} onClick={() => setEditingExpense(ex)} />)}</div>}
            </div>
          );
        })}
      </div>
      {!dashboard?.expenses.length && <p className="empty">Добавьте первую трату.</p>}
    </>}

    {activeTab === "categories" && <>
      {editingCategory ? (
        <div className="modal-backdrop" onClick={() => setEditingCategory(undefined)}>
          <form className="expense-modal" onSubmit={updateCategory} onClick={(e) => e.stopPropagation()}>
            <div className="form-heading"><b>Редактировать</b><button type="button" className="close-button" onClick={() => setEditingCategory(undefined)}>×</button></div>
            <input name="categoryName" maxLength={50} defaultValue={editingCategory.name} placeholder="Название" required autoFocus />
            <div className="icon-dropdown">
              <input type="hidden" name="categoryIcon" value={categoryIconValue} />
              <button type="button" className="icon-dropdown-trigger" onClick={(e) => { e.stopPropagation(); setIconPickerOpen((open) => !open); }}>
                <span className="icon-dropdown-icon"><Icon name={categoryIconValue} /></span>
                <span className="icon-dropdown-label">{ICON_LABELS[categoryIconValue] ?? "Другое"}</span>
                <span className="icon-dropdown-arrow"><Icon name="arrow" /></span>
              </button>
              {iconPickerOpen && (
                <div className="icon-dropdown-panel" onClick={(e) => e.stopPropagation()}>
                  {CATEGORY_ICONS.map((icon) => {
                    const used = dashboard?.categories.some((c) => c.icon === icon && c.id !== editingCategory?.id);
                    return (
                      <button
                        type="button"
                        key={icon}
                        className={`icon-dropdown-option${categoryIconValue === icon ? " selected" : ""}`}
                        onClick={() => { setCategoryIconValue(icon); setIconPickerOpen(false); }}
                        disabled={used}
                      >
                        <Icon name={icon} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <button type="submit" disabled={isSubmitting}>{isSubmitting ? "Сохраняю…" : "Сохранить"}</button>
            <button type="button" className="danger-button" disabled={isSubmitting} onClick={deleteCategory}>Удалить</button>
          </form>
        </div>
      ) : showCategoryForm ? (
        <div className="modal-backdrop" onClick={() => setShowCategoryForm(false)}>
          <form className="expense-modal" onSubmit={addCategory} onClick={(e) => e.stopPropagation()}>
            <div className="form-heading"><b>Категория</b><button type="button" className="close-button" onClick={() => setShowCategoryForm(false)}>×</button></div>
            <input name="categoryName" maxLength={50} placeholder="Название" required autoFocus />
            <div className="icon-dropdown">
              <input type="hidden" name="categoryIcon" value={categoryIconValue} />
              <button type="button" className="icon-dropdown-trigger" onClick={(e) => { e.stopPropagation(); setIconPickerOpen((open) => !open); }}>
                <span className="icon-dropdown-icon"><Icon name={categoryIconValue} /></span>
                <span className="icon-dropdown-label">{ICON_LABELS[categoryIconValue] ?? "Другое"}</span>
                <span className="icon-dropdown-arrow"><Icon name="arrow" /></span>
              </button>
              {iconPickerOpen && (
                <div className="icon-dropdown-panel" onClick={(e) => e.stopPropagation()}>
              {CATEGORY_ICONS.map((icon) => {
                const used = dashboard?.categories.some((c) => c.icon === icon);
                return (
                  <button
                    type="button"
                    key={icon}
                    className={`icon-dropdown-option${categoryIconValue === icon ? " selected" : ""}`}
                    onClick={() => { setCategoryIconValue(icon); setIconPickerOpen(false); }}
                    disabled={used}
                  >
                    <Icon name={icon} />
                  </button>
                );
              })}
                </div>
              )}
            </div>
            <button type="submit" disabled={isSubmitting}>{isSubmitting ? "Сохраняю…" : "Создать"}</button>
          </form>
        </div>
      ) : null}
      <section className="category-icon-grid">{sortedCategories.map((category) => <button className="category-icon-button" key={category.id} onPointerDown={() => startCategoryPress(category)} onPointerUp={endCategoryPress} onPointerCancel={endCategoryPress} onContextMenu={(event) => event.preventDefault()} onClick={() => { if (didLongPress.current) { didLongPress.current = false; return; } setExpenseCategory(category); }}><span className="system-icon-bg"><Icon name={category.icon || "other"} /></span><b>{category.name}</b><small>{formatMoney(categoryStats.find((item) => item.id === category.id)?.amount ?? 0)}</small></button>)}<button className="category-icon-button add-category-button" onClick={() => { setEditingCategory(undefined); setCategoryIconValue("other"); setIconPickerOpen(false); setShowCategoryForm(true); }}><span><Icon name="plus" /></span><b>Добавить</b></button></section>
      {expenseCategory && <div className="modal-backdrop" onClick={() => setExpenseCategory(undefined)}><form className="expense-modal" onSubmit={addExpense} onClick={(e) => e.stopPropagation()}><input name="amount" type="number" min="1" step="1" placeholder="Сумма, ₽" required autoFocus /><input name="description" maxLength={300} placeholder="Что купили?" /><select name="categoryId" defaultValue={expenseCategory.id}>{dashboard?.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><button type="submit" disabled={isSubmitting}>{isSubmitting ? "Сохраняю…" : "Сохранить"}</button></form></div>}
    </>}

    {activeTab === "chart" && <>
      <section className="chart-card"><div className="donut" style={{ background: chartBackground }}><div><small>Всего</small><b>{formatMoney(dashboard?.totalSpent ?? 0)}</b></div></div><div className="legend">{categoryStats.map((item) => <div key={item.name}><i style={{ background: item.color }} /><span>{item.name}</span><b>{formatMoney(item.amount)}</b></div>)}{categoryStats.length === 0 && <p className="empty">Данные появятся после добавления трат.</p>}</div></section>
    </>}

    {activeTab === "savings" && <><section className="savings-card"><span className="savings-icon"><Icon name="goal" /></span><h2>Создайте первую цель</h2><p>Например, отпуск, новый телефон или финансовую подушку.</p><button type="button">Добавить накопление</button></section></>}

    <nav aria-label="Основная навигация">{tabItems.map((item) => <button key={item.id} className={activeTab === item.id ? "active" : ""} onClick={() => setActiveTab(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</nav>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
