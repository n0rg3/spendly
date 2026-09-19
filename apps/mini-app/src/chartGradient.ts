// apps/mini-app/src/chartGradient.ts
// Построение конического градиента круговой диаграммы с учётом выбранной
// категории.
//
// Базовое состояние: секторы окрашены теми же цветами, что и карточки
// категорий (пастельный bg из getCategoryColor). Ярким (плотный chart-цвет)
// сектор становится ТОЛЬКО при выделении своей категории — пропорции при
// этом не искажаются, сектор всегда отражает реальный процент от суммы.

export type CategoryStat = {
  id: string;
  name: string;
  amount: number;
  /** Палитра категории (bg/border/chart из getCategoryColor) */
  color: import("./categoryColors").CategoryColor;
};

// Нейтральное кольцо, когда трат за месяц нет
const EMPTY_RING = "conic-gradient(#e9ebf3 0 100%)";

/**
 * Строит conic-gradient для круговой диаграммы.
 *
 * Секторы в базовом состоянии идентичны цветам карточек категорий (bg).
 * Выделенная категория подсвечивается ярким цветом сектора (chart) —
 * как сейчас, но пропорции кольца не меняются.
 */
export function buildChartGradient(
  stats: CategoryStat[],
  selectedId?: string,
): string {
  const total = stats.reduce((sum, item) => sum + item.amount, 0);
  if (!total) return EMPTY_RING;

  const selectionActive = selectedId !== undefined;
  const selectedIndex = selectionActive
    ? stats.findIndex((item) => item.id === selectedId)
    : -1;
  // Выбранной категории может не быть среди секторов (нет трат в этом месяце) —
  // тогда подсвечивать нечего: рисуем диаграмму в базовых цветах карточек
  const hasSelectedSegment = selectedIndex >= 0;

  // Все секторы рисуются в реальных пропорциях от общей суммы.
  // Базовый цвет = цвет карточки категории; ярким становится только выделенный
  let position = 0;
  const segments = stats.map((item, index) => {
    const share = (item.amount / total) * 100;
    const end = position + share;
    const isSelected = hasSelectedSegment && index === selectedIndex;
    const color = isSelected ? item.color.chart : item.color.bg;
    const segment = `${color} ${position}% ${end}%`;
    position = end;
    return segment;
  });

  return `conic-gradient(${segments.join(", ")})`;
}
