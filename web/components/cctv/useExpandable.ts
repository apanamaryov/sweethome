"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Увеличение картинки по клику.
 *
 * Кадр у этих камер 1920×2160 — две линзы одна над другой, — поэтому в обычном
 * размере он вписан в окно, иначе на десктопе не помещается даже одна линза.
 * Разглядеть его крупно можно кликом.
 *
 * Это не полноэкранный режим браузера, а слой поверх страницы: штатный
 * полноэкранный подменил бы наши кнопки своими, а у штатных ползунок
 * перематывает так, что воспроизведение больше не поднимается (подробности —
 * в modules/cctv/CLAUDE.md). Плюс элемент видео при этом никуда не переезжает:
 * меняется только класс обёртки, поэтому живой поток и архив не обрываются.
 */
export function useExpandable(): { expanded: boolean; toggle: () => void } {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((v) => !v), []);

  // Esc — единственный выход, который не требует попасть по картинке, и
  // привычный для всего, что раскрывается поверх страницы.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  return { expanded, toggle };
}
