// apps/mini-app/src/chartGradient.ts
// Построение конического градиента круговой диаграммы с учётом выбранной
// категории: выбранная часть показывается крупнее, остальные — приглушаются.

export type CategoryStat = {
  id: string;
  name: string;
  amount: number;
  /** Цвет категории (hsl из getCategoryColor): фон плашки и сектор диаграммы */
  color: string;
};

// Насколько доля выбранной категории «приближается» к полному кругу:
// показанная доля = raw + BOOST * (1 - raw), но не больше MAX —
// иначе остальные категории исчезли бы и сектор перестал быть «частью» целого
export const SELECTED_SHARE_BOOST = 0.55;
export const SELECTED_SHARE_MAX = 0.85;

// Нейтральное кольцо, когда трат за месяц нет
const EMPTY_RING = "conic-gradient(#e9ebf3 0 100%)";

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
  // тогда увеличивать нечего: рисуем обычную диаграмму без приглушения
  const hasSelectedSegment = selectedIndex >= 0;
  const rawShares = stats.map((item) => item.amount / total);
  const rawSelected = hasSelectedSegment ? rawShares[selectedIndex] : 0;

  // Увеличиваем долю, только если категорий несколько и выбранная — не весь
  // круг: иначе в кольце осталась бы «дырка» до 100%
  const canBoost = hasSelectedSegment && stats.length > 1 && rawSelected < 1;
  const shownSelected = canBoost
    ? Math.min(
        SELECTED_SHARE_MAX,
        rawSelected + SELECTED_SHARE_BOOST * (1 - rawSelected),
      )
    : rawSelected;
  const restRaw = 1 - rawSelected;
  const restShown = 1 - shownSelected;

  let position = 0;
  const segments = stats.map((item, index) => {
    const share =
      index === selectedIndex
        ? shownSelected
        : canBoost && restRaw > 0
          ? (rawShares[index] / restRaw) * restShown
          : rawShares[index];
    const end = position + share * 100;
    // Остальные секторы приглушаются — выбранная часть читается как увеличенная
    const dimmed = hasSelectedSegment && index !== selectedIndex;
    const color = dimmed
      ? `color-mix(in srgb, ${item.color} 45%, var(--secondary-bg-color))`
      : item.color;
    const segment = `${color} ${position}% ${end}%`;
    position = end;
    return segment;
  });

  return `conic-gradient(${segments.join(", ")})`;
}
