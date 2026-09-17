// apps/mini-app/src/categoryColors.ts
// Автогенерация палитры категорий: количество категорий динамическое,
// поэтому цвет считается детерминированно из названия (одно имя → один цвет).

// Насыщенность и светлота фиксированы: все плашки категорий одинаково яркие,
// а белые иконка, название и сумма читаются на любом hue.
// Один и тот же цвет используется и для плашки, и для сектора диаграммы.
const PLATE_SATURATION = 65;
const PLATE_LIGHTNESS = 45;

/**
 * Возвращает один яркий насыщенный HSL-цвет категории: `hsl(hue, 65%, 45%)`.
 * Это фон плашки категории (на «Графике» и на «Тратах») и цвет её сектора
 * в круговой диаграмме — цвета синхронизированы по построению.
 */
export const getCategoryColor = (categoryName: string): string => {
  // Строковый хэш (djb2-подобный) → hue 0..359
  let hash = 0;
  for (let i = 0; i < categoryName.length; i++) {
    hash = categoryName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, ${PLATE_SATURATION}%, ${PLATE_LIGHTNESS}%)`;
};
