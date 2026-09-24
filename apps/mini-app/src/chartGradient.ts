// apps/mini-app/src/chartGradient.ts
// Раскладка кольцевой диаграммы (CSS conic-gradient) с учётом выбранной
// категории.
//
// Геометрия кольца фиксирована: внешний диаметр и положение всех секторов не
// зависят от выбора — пропорции всегда отражают реальный процент от суммы.
// Выделение категории делается двумя независимыми приёмами (см. .donut-ring и
// .donut-pop в styles.css):
//   1) базовое кольцо мягко приглушается — соседние секторы при этом стоят на
//      месте, потому что ни их углы, ни габарит контейнера не меняются;
//   2) выбранный сектор рисуется отдельным слоем, который больше кольца на 8px:
//      он выступает наружу от центра, увеличивая внешний радиус только себе.
//
// Базовый цвет сектора — пастельный bg из getCategoryColor, у выбранного —
// плотный chart-цвет (opacity 1 на фоне приглушённых остальных).

export type CategoryStat = {
  id: string;
  name: string;
  amount: number;
  /** Палитра категории (bg/border/chart из getCategoryColor) */
  color: import("./categoryColors").CategoryColor;
};

/** Сектор кольца: положение на окружности в процентах (0 % — 12 часов, по часовой стрелке) */
export type DonutSegment = {
  id: string;
  /** Начало сектора, % окружности */
  from: number;
  /** Конец сектора, % окружности */
  to: number;
  /** Плотный цвет сектора (chart) */
  color: string;
  /**
   * conic-gradient слоя-выступа: залит только этот сектор, остальные углы
   * прозрачны. Слой позиционируется с тем же центром, что и кольцо, поэтому
   * углы сектора совпадают с базовым кольцом.
   */
  wedge: string;
};

export type DonutLayout = {
  /** conic-gradient базового кольца: все секторы в фиксированных пропорциях */
  ring: string;
  /** Выбранный сектор (выступает наружу); undefined — выбора нет */
  active?: DonutSegment;
};

// Нейтральное кольцо, когда трат за месяц нет
const EMPTY_RING = "conic-gradient(#e9ebf3 0 100%)";

/** Округление процентов: короче строки градиентов, расхождение < 0.001 % */
const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Считает раскладку кольца: строку базового градиента и выбранный сектор.
 *
 * @param stats      категории месяца, отсортированные по убыванию суммы
 * @param selectedId выбранная категория. Если её нет среди секторов (нет трат
 *                   в этом месяце), выступа нет — выделять нечего
 */
export function buildDonutLayout(
  stats: CategoryStat[],
  selectedId?: string,
): DonutLayout {
  const total = stats.reduce((sum, item) => sum + item.amount, 0);
  if (!total) return { ring: EMPTY_RING };

  const selectedIndex =
    selectedId === undefined
      ? -1
      : stats.findIndex((item) => item.id === selectedId);

  let active: DonutSegment | undefined;
  // Доли считаются от общей суммы и не зависят от выбора, поэтому соседние
  // секторы при выделении категории не меняют ни размер, ни положение.
  // position копит «сырые» проценты: границы округляются только при выводе,
  // поэтому конец одного сектора всегда точно совпадает с началом следующего,
  // а последний сектор доходит ровно до 100 %
  let position = 0;
  const stops = stats.map((item, index) => {
    const start = round(position);
    const next = position + (item.amount / total) * 100;
    const end = round(next);
    const isSelected = index === selectedIndex;
    // Выбранный сектор в базовом кольце тоже плотный: под слоем-выступом он
    // не виден, но на стыке секторов не остаётся пастельной кромки
    const color = isSelected ? item.color.chart : item.color.bg;
    if (isSelected) {
      active = {
        id: item.id,
        from: start,
        to: end,
        color: item.color.chart,
        // Прозрачные стопы по краям обязательны: конусный градиент тянет первый
        // цвет назад, к 0 %, и без них был бы залит весь круг
        wedge:
          `conic-gradient(transparent 0 ${start}%, ` +
          `${item.color.chart} ${start}% ${end}%, transparent ${end}% 100%)`,
      };
    }
    position = next;
    return `${color} ${start}% ${end}%`;
  });

  return { ring: `conic-gradient(${stops.join(", ")})`, active };
}
