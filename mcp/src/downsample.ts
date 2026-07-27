/**
 * Равномерное прореживание ряда до maxPoints точек. Первая и последняя точки
 * сохраняются всегда — иначе агент видит «обрезанный» интервал и делает выводы
 * о данных, которых нет.
 */
export function downsample<T>(
  rows: T[],
  maxPoints: number
): { rows: T[]; downsampled: boolean; sourcePoints: number } {
  const sourcePoints = rows.length;
  if (sourcePoints <= maxPoints) return { rows, downsampled: false, sourcePoints };

  // Шаг считается по интервалам, а не по точкам: так выборка укладывается ровно
  // в limit точек вместе с обоими концами (при limit=2 это просто первая и последняя).
  const limit = Math.max(2, Math.trunc(maxPoints));
  const step = Math.ceil((sourcePoints - 1) / (limit - 1));
  const picked = rows.filter((_, i) => i % step === 0);
  const last = rows[sourcePoints - 1];
  if (picked[picked.length - 1] !== last) picked.push(last);
  return { rows: picked, downsampled: true, sourcePoints };
}
