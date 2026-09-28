// ===== Даты чека: «стена часов» вместо UTC =====
//
// Разбор чека целиком делает Gemini на сервере и отдаёт dateTime в ISO 8601, поэтому на
// клиенте нет ни регэкспов формата сербского чека, ни кэша категорий — только защита
// от сдвига времени.
//
// Проблема: модель присылает «2026-09-16T17:50:44Z» (или «+02:00»), new Date() считает
// 17:50 временем UTC и прибавляет локальный пояс — в UTC+2 на экране появлялось 19:50
// вместо 17:50 с чека. Поэтому здесь разбираются ТОЛЬКО цифры даты/времени: любой часовой
// пояс отбрасывается, а момент покупки собирается локальным конструктором Date.
// Так время на чеке и время в трате совпадают при любом часовом поясе устройства.

export type ReceiptWallClock = {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
};

const RECEIPT_WALL_CLOCK = /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

// «2026-09-16T17:50:44Z» / «2026-09-16 17:50» -> цифры как напечатаны на чеке; мусор -> null
export function receiptWallClock(value: string | null): ReceiptWallClock | null {
  if (!value) return null;
  const match = RECEIPT_WALL_CLOCK.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4] ?? 0);
  const minutes = Number(match[5] ?? 0);
  const seconds = Number(match[6] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59 || seconds > 59) {
    return null;
  }
  // Дата должна существовать в календаре (отсекаем 31.02)
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day, hours, minutes, seconds };
}

// Момент покупки чека в createdAt: цифры чека трактуются как локальные, без сдвигов.
// Отдаём ISO-момент (он нужен сортировке и группировке), который в локальной зоне
// отображается ровно как время, напечатанное на чеке.
export function receiptDateToIso(value: string | null): string | null {
  const wallClock = receiptWallClock(value);
  if (!wallClock) return null;
  const { year, month, day, hours, minutes, seconds } = wallClock;
  return new Date(year, month - 1, day, hours, minutes, seconds).toISOString();
}

// Подпись даты/времени чека в модалке: «2026-09-16 17:50» — ровно как напечатано на чеке
export function formatReceiptDateTime(value: string | null): string | null {
  const wallClock = receiptWallClock(value);
  if (!wallClock) return null;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${wallClock.year}-${pad(wallClock.month)}-${pad(wallClock.day)} ${pad(wallClock.hours)}:${pad(wallClock.minutes)}`;
}

// Ключ месяца (YYYY-MM) в ЛОКАЛЬНОЙ зоне. createdAt хранится в UTC, поэтому сравнение
// по префиксу строки относило чек, купленный в 00:30 при UTC+2, к предыдущим суткам —
// и такой чек выпадал из своего месяца.
export function localMonthKey(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
