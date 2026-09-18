// apps/mini-app/src/chartGradient.ts
// Построение конического градиента круговой диаграммы с учётом выбранной
// категории: выбранная часть подсвечивается, остальные — приглушаются,
// но НЕ меняют своих пропорций (сектор не увеличивается в размерах).

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
 * Важно: выбранная категория НЕ увеличивается в размерах — её сектор
 * всегда отражает реальный процент от общей суммы трат. Подсветка
 * достигается за счёт приглушения остальных секторов (color-mix с
 * фоном), а не за счёт изменения пропорций.
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
  // тогда подсвечивать нечего: рисуем обычную диаграмму без приглушения
  const hasSelectedSegment = selectedIndex >= 0;

  // Все секторы рисуются в реальных пропорциях от общей суммы.
  // Выбранная категория не меняет свой угол — подсвечивается лишь визуально.
  let position = 0;
  const segments = stats.map((item, index) => {
    const share = (item.amount / total) * 100;
    const end = position + share;
    // Остальные секторы приглушаются — выбранная часть читается как ярче
    const dimmed = hasSelectedSegment && index !== selectedIndex;
    const color = dimmed
      ? `color-mix(in srgb, ${item.color.chart} 45%, var(--secondary-bg-color))`
      : item.color.chart;
    const segment = `${color} ${position}% ${end}%`;
    position = end;
    return segment;
  });

  return `conic-gradient(${segments.join(", ")})`;
}
