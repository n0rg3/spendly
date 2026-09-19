// apps/mini-app/src/cardDrag.ts
// Логика ручной сортировки карт лояльности (drag & drop).
// Основана на Pointer Events — работает и на тач-экранах, и мышью.
// На время перетаскивания кэшируются rect-ы строк списка; по позиции
// указателя вычисляются индекс вставки и Y линии-индикатора.

export type CardDragRect = { id: string; top: number; bottom: number };

/** Вертикальный gap сетки .cards-list (используется для позиции линии) */
export const CARD_LIST_GAP = 10;

/** Текущий индекс карты в списке (-1, если не найдена) */
export const cardIndexById = (cards: { id: string }[], id: string): number =>
  cards.findIndex((card) => card.id === id);

/**
 * Индекс вставки: сколько «чужих» строк (без перетаскиваемой) выше указателя.
 * Сравнение по центрам строк — карта встаёт после той, чей центр пройден.
 */
export function cardDropIndex(rects: CardDragRect[], dragId: string, pointerY: number): number {
  const others = rects.filter((rect) => rect.id !== dragId);
  let index = 0;
  for (const rect of others) {
    if (pointerY > (rect.top + rect.bottom) / 2) index++;
  }
  return index;
}

/**
 * Y-координата линии-индикатора вставки (в координатах вьюпорта):
 * на границе между соседними строками (середина gap-а).
 */
export function cardDropLineY(rects: CardDragRect[], dragId: string, index: number): number {
  const others = rects.filter((rect) => rect.id !== dragId);
  if (others.length === 0) {
    return rects[0] ? rects[0].top - CARD_LIST_GAP / 2 : 0;
  }
  if (index <= 0) return others[0].top - CARD_LIST_GAP / 2;
  if (index >= others.length) return others[others.length - 1].bottom + CARD_LIST_GAP / 2;
  return (others[index - 1].bottom + others[index].top) / 2;
}