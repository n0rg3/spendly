// apps/mini-app/src/chartInteraction.ts
// Правила работы с выбором категории на экране аналитики.
//
// Выбор снимается тремя способами:
//   1) тап по той же категории в сетке или по её сектору (переключатель в
//      toggleCategorySelection);
//   2) тап «мимо графика» — по любому месту вне диаграммы и вне карточек категорий;
//   3) тап по «дырке» в центре кольца (см. sectorAtPoint: сектора там нет).

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

// ===== Hit-тест секторов диаграммы =====
// Геометрия взята из CSS: .donut — 190×190 (внешний радиус 95), «дырка» с
// подписью — 126×126 (внутренний радиус 63). Выбранный сектор дополнительно
// выступает наружу на 8px (.donut-pop), поэтому тап по нему тоже должен работать.
export const DONUT_OUTER_RADIUS = 95;
export const DONUT_INNER_RADIUS = 63;
const POP_MARGIN = 8;

/** Диапазон сектора в процентах окружности: 0 % — 12 часов, дальше по часовой */
export type DonutSegmentRange = { id: string; from: number; to: number };

/**
 * Id категории, чей сектор оказался под точкой тапа.
 * Возвращает undefined для «дырки» и для точки мимо кольца — там выбора нет,
 * и тап должен снимать его (см. nextSelectedCategoryIdOnOutsideTap).
 *
 * @param x смещение точки относительно центра кольца
 * @param y смещение точки относительно центра кольца
 * @param segments секторы из buildDonutLayout — те же границы, что и в градиенте
 */
export function sectorAtPoint(x: number, y: number, segments: DonutSegmentRange[]): string | undefined {
  const distance = Math.hypot(x, y);
  if (distance > DONUT_OUTER_RADIUS + POP_MARGIN || distance < DONUT_INNER_RADIUS) return undefined;
  // Угол: 0° — вверх (12 часов), растёт по часовой стрелке, как в conic-gradient
  const degrees = (Math.atan2(x, -y) * 180) / Math.PI;
  const percent = ((degrees + 360) % 360) / 3.6;
  return segments.find((segment) => percent >= segment.from && percent < segment.to)?.id;
}