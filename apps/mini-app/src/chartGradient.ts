// apps/mini-app/src/chartGradient.ts
// Раскладка кольцевой диаграммы (CSS conic-gradient) с учётом выбранной
// категории.
//
// Геометрия кольца фиксирована: внешний диаметр и положение всех секторов не
// зависят от выбора — пропорции всегда отражают реальный процент от суммы.
// Состояния (цвета секторов формируются динамически, см. getCategoryColor):
//   - ничего не выбрано: каждый сектор залит своим сочным цветом, opacity 1;
//   - категория выбрана: её сектор остаётся сочным и увеличивается отдельным
//     слоем (выступ наружу), а остальные секторы берут тот же оттенок с
//     alpha 0.25 — тускнеют, но не исчезают и не меняют пропорции.

export type CategoryStat = {
  id: string;
  name: string;
  amount: number;
  /** Палитра категории (chart/dimmed/border из getCategoryColor) */
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
  /**
   * Границы всех секторов — для hit-теста тапа (см. sectorAtPoint).
   * Ровно те же значения, что ушли в градиент, поэтому зона тапа совпадает
   * с нарисованным сектором.
   */
  segments: { id: string; from: number; to: number }[];
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
  if (!total) return { ring: EMPTY_RING, segments: [] };

  const selectedIndex =
    selectedId === undefined
      ? -1
      : stats.findIndex((item) => item.id === selectedId);

  let active: DonutSegment | undefined;
  // Границы секторов для hit-теста: ровно те же числа, что уходят в градиент,
  // поэтому зона тапа совпадает с нарисованным сектором
  const segments: { id: string; from: number; to: number }[] = [];
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
    // В обычном состоянии все секторы сочные. При выборе категории остальные
    // берут свой оттенок с alpha 0.25 (dimmed): тусклые, но узнаваемые.
    const color = isSelected || selectedIndex === -1 ? item.color.chart : item.color.dimmed;
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
    segments.push({ id: item.id, from: start, to: end });
    return `${color} ${start}% ${end}%`;
  });

  return { ring: `conic-gradient(${stops.join(", ")})`, active, segments };
}
