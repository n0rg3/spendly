// apps/mini-app/src/categoryColors.ts
// Автогенерация палитры категорий: количество категорий динамическое,
// поэтому цвет считается детерминированно из названия (одно имя → один цвет).
//
// Палитра смягчена: фон карточек полупрозрачный пастельный, цвет секторов
// диаграммы — более насыщенный для контраста на белом/светлом фоне.

export type CategoryColor = {
  /** Полупрозрачный пастельный фон карточки категории (15–25% альфа) */
  bg: string;
  /** Лёгкая рамка для чёткости контура карточки */
  border: string;
  /** Плотный цвет сектора Donut Chart (без прозрачности) */
  chart: string;
};

const BG_SATURATION = 55;
const BG_LIGHTNESS = 45;
const BG_ALPHA = 0.20;

const BORDER_SATURATION = 60;
const BORDER_LIGHTNESS = 50;
const BORDER_ALPHA = 0.35;

const CHART_SATURATION = 65;
const CHART_LIGHTNESS = 55;

/** Шаг золотого сечения: hue соседних категорий разводится на 137.5°, чтобы секторы не сливались. */
export const GOLDEN_RATIO_STEP = 137.5;

const normalizeHue = (hue: number): number => ((hue % 360) + 360) % 360;

/**
 * Возвращает палитру категории: фон, рамка и цвет сектора диаграммы.
 *
 * @param categoryName  имя категории — из него детерминированно считается hue
 * @param hueOverride   явный hue (например, золотое сечение для секторов диаграммы);
 *                      если не задан, hue считается из имени категории
 */
export const getCategoryColor = (categoryName: string, hueOverride?: number): CategoryColor => {
  let hue: number;
  if (hueOverride !== undefined) {
    hue = normalizeHue(hueOverride);
  } else {
    // Строковый хэш (djb2-подобный) → hue 0..359
    let hash = 0;
    for (let i = 0; i < categoryName.length; i++) {
      hash = categoryName.charCodeAt(i) + ((hash << 5) - hash);
    }
    hue = normalizeHue(Math.abs(hash));
  }
  return {
    bg: `hsla(${hue}, ${BG_SATURATION}%, ${BG_LIGHTNESS}%, ${BG_ALPHA})`,
    border: `hsla(${hue}, ${BORDER_SATURATION}%, ${BORDER_LIGHTNESS}%, ${BORDER_ALPHA})`,
    chart: `hsl(${hue}, ${CHART_SATURATION}%, ${CHART_LIGHTNESS}%)`,
  };
};
