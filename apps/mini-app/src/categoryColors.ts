// apps/mini-app/src/categoryColors.ts
// Автогенерация палитры категорий: количество категорий динамическое,
// поэтому цвет считается детерминированно из названия (одно имя → один цвет).

export type CategoryColor = {
  /** Основной цвет: иконка, текст, сектор круговой диаграммы */
  main: string;
  /** Полупрозрачный фон плашки/квадрата иконки под графиком */
  bg: string;
};

// Строковый хэш (djb2-подобный) → hue 0..359, saturation/lightness фиксированы,
// чтобы все цвета были одинаково яркими и контрастными на светлой и тёмной теме
export const getCategoryColor = (categoryName: string): CategoryColor => {
  let hash = 0;
  for (let i = 0; i < categoryName.length; i++) {
    hash = categoryName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return {
    main: `hsl(${hue}, 75%, 55%)`, // Для иконок, текста и секторов графика
    bg: `hsl(${hue}, 75%, 55%, 0.15)`, // Полупрозрачный фон для карточки категории
  };
};
