// apps/mini-app/src/categoryMatch.ts
// Сопоставление категории, которую вернула модель, с категорией пользователя.
// Позиция НЕ должна «падать в Остальное» только из-за того, что модель назвала категорию
// по-своему («Продукты» вместо «Еда»), поэтому матчинг идёт по нескольким уровням:
// точное название -> ID -> вхождение названий -> группа синонимов (RU/EN/SR).

/** Название категории в сравнимом виде: Unicode-форма, неразрывные пробелы, регистр */
export function normalizeCategoryName(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u00a0\u2007\u2009\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Группы синонимов категорий (RU / EN / SR).
 * Модель может вернуть «Продукты», «Groceries» или «Hrana», а в интерфейсе пользователя
 * категория называется «Еда» — такие названия обязаны сходиться, иначе позиция уедет
 * в «Остальное». Первое название группы — её ключ.
 */
export const CATEGORY_SYNONYM_GROUPS: string[][] = [
  ["еда", "продукты", "продукты питания", "еда и напитки", "food", "groceries", "hrana", "namirnice"],
  ["кафе", "кафе и рестораны", "рестораны", "тусичи", "cafe", "cafes", "restaurants", "tusici", "kafic"],
  ["транспорт", "бензин", "топливо", "transport", "prevoz", "gorivo"],
  ["дом", "хозтовары", "home", "kuca", "dom"],
  ["покупки", "shopping", "kupovina"],
  ["развлечения", "entertainment", "zabava"],
  ["здоровье", "аптека", "health", "apoteka", "zdravlje"],
  ["остальное", "другое", "прочее", "other", "ostalo"],
];

/** Ключ группы синонимов для нормализованного названия (null — название вне групп) */
function synonymKey(normalizedName: string): string | null {
  if (!normalizedName) return null;
  for (const group of CATEGORY_SYNONYM_GROUPS) {
    if (group.includes(normalizedName)) return group[0];
  }
  return null;
}

export type CategoryMatch<T> = {
  category: T;
  /** Как именно сошлось — удобно для лога [Receipt Items Parsed] */
  matchedBy: "name" | "id" | "contains" | "synonym";
};

/**
 * Ищет категорию пользователя для названия/ID из ответа модели.
 * Не нашли — null: позиция уходит в «Остальное» (пустой id в селекте), а не теряется.
 */
export function matchCategory<T extends { id: string; name: string }>(
  categories: T[],
  aiCategory: string | null | undefined,
): CategoryMatch<T> | null {
  const wanted = normalizeCategoryName(aiCategory);
  if (!wanted || categories.length === 0) return null;

  // 1) точное совпадение названия (регистр, лишние пробелы и Unicode-форма не важны)
  const byName = categories.find((category) => normalizeCategoryName(category.name) === wanted);
  if (byName) return { category: byName, matchedBy: "name" };

  // 2) модель могла вернуть ID категории
  const raw = String(aiCategory ?? "").trim();
  const byId = categories.find((category) => category.id === raw);
  if (byId) return { category: byId, matchedBy: "id" };

  // 3) «Кафе» ~ «Кафе и рестораны»: одно название содержится в другом
  const byContains = categories.find((category) => {
    const name = normalizeCategoryName(category.name);
    return name.includes(wanted) || wanted.includes(name);
  });
  if (byContains) return { category: byContains, matchedBy: "contains" };

  // 4) синонимы: «Продукты» <-> «Еда», «Кафе» <-> «Тусичи», «Groceries» <-> «Hrana»
  const key = synonymKey(wanted);
  if (key) {
    const bySynonym = categories.find((category) => synonymKey(normalizeCategoryName(category.name)) === key);
    if (bySynonym) return { category: bySynonym, matchedBy: "synonym" };
  }

  return null;
}
