// ===== Название позиции чека: суффикс количества « xN» =====
//
// Количество модель/сервер отдают ОТДЕЛЬНЫМ числовым полем (qty), поэтому суффикс « xN»
// формируется здесь, перед показом позиции в форме чека. Функция идемпотентна: если « xN»
// уже стоит в конце строки (например, его всё-таки вернула модель), повторно он НЕ
// дописывается — иначе получилось бы «Pivo x2 x2». При quantity <= 1 суффикс не нужен.

export function formatReceiptItemName(name: string, quantity: number): string {
  const cleanName = String(name ?? "").trim();
  if (!cleanName || !Number.isFinite(quantity) || quantity <= 1) return cleanName;
  // Суффикс уже есть — не дублируем (регистр «x» не важен: x2 == X2)
  const hasSuffix = new RegExp(`\\s*x${quantity}$`, "i").test(cleanName);
  return hasSuffix ? cleanName : `${cleanName} x${quantity}`;
}
