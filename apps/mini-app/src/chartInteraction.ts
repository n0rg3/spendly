// apps/mini-app/src/chartInteraction.ts
// Правила снятия выбора категории на экране аналитики.
//
// Выбор снимается только двумя способами:
//   1) тап по той же категории в сетке (переключатель в toggleCategorySelection);
//   2) тап «мимо графика» — по любому месту вне диаграммы и вне карточек категорий.
// Тап по самой диаграмме выбор НЕ снимает, а тап по карточке категории
// переключает выбор на неё (поэтому такие тапы здесь игнорируются).

// Блоки, тапы внутри которых не снимают выбор
const SELECTION_KEEP_SELECTORS = [".chart-card", ".category-icon-button"] as const;

type ClosestTarget = { closest(selector: string): Element | null };

// Тап попал в диаграмму или в карточку категории (включая кнопку «Add»)?
export function shouldKeepCategorySelection(target: ClosestTarget | null): boolean {
  return SELECTION_KEEP_SELECTORS.some((selector) => Boolean(target?.closest(selector)));
}

// Новое значение выбранной категории после тапа. Возвращает прежнее значение
// (ту же ссылку), если выбор нужно сохранить — тогда React не перерисовывает
export function nextSelectedCategoryIdOnOutsideTap(
  target: ClosestTarget | null,
  selectedId: string | undefined
): string | undefined {
  if (!selectedId) return selectedId; // выбора и так нет
  if (shouldKeepCategorySelection(target)) return selectedId;
  return undefined;
}