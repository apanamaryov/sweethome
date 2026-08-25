/** Камера в ответах API (без внутренних путей и адресов ffmpeg). */
export interface CameraInfo {
  id: string;
  name: string;
  /** Пишем ли прямо сейчас. */
  recording: boolean;
  /** Начало последнего попавшего в индекс сегмента, unix ms; null — записей нет. */
  lastSegmentMs: number | null;
  /** Сколько раз процесс записи перезапускался с момента старта модуля. */
  restarts: number;
  /** Последняя ошибка процесса записи, если есть. */
  lastError?: string;
  /**
   * Есть ли у камеры звук. Не все отдают: у одной из наших в потоке только
   * видео, и кнопка звука ей не нужна. Считается по заголовку записанного
   * потока, то есть отвечает и за архив тоже.
   */
  hasAudio: boolean;
  /**
   * Пишется ли звук в архив. Отдельно от `hasAudio`: перекодирование звука
   * стоит около трети ядра на камеру круглосуточно, и на слабом питании это
   * оказалось непозволительно — выключается через CCTV_RECORD_AUDIO.
   */
  recordsAudio: boolean;
}

/** Непрерывный отрезок записи. */
export interface Span {
  startMs: number;
  endMs: number;
}

/** Метка события с камеры (движение и прочие топики ONVIF). */
export interface MotionMark {
  tsMs: number;
  kind: string;
}

export interface TimelineResponse {
  cam: string;
  fromMs: number;
  toMs: number;
  spans: Span[];
  marks: MotionMark[];
  segments: number;
  bytes: number;
  /**
   * Начало первого НЕподрезанного сегмента интервала — нулевая отметка шкалы
   * плейлиста. `spans` подрезаны по границам запроса (для полос на ленте это
   * правильно), а плейлист намеренно включает сегмент, начавшийся до `fromMs`,
   * иначе плеер стартовал бы с дыркой. Без этой отметки клиент считал бы позицию
   * в одной системе отсчёта, а плеер играл бы в другой — перемотка промахивалась
   * бы ровно на этот сдвиг (до длины сегмента, всегда в прошлое).
   * null — в интервале нет записи.
   */
  playlistStartMs: number | null;
}

export interface StorageInfo {
  /** Доступна ли точка монтирования. */
  available: boolean;
  usedBytes: number;
  quotaBytes: number;
  /** Оценка глубины архива в сутках по фактическому расходу; null — данных мало. */
  depthDays: number | null;
  oldestMs: number | null;
  newestMs: number | null;
}

/** Сообщения клиента в /ws/cctv. */
export type LiveClientMessage =
  | { type: "subscribe"; cam: string }
  | { type: "unsubscribe"; cam: string };

/** Текстовые сообщения сервера в /ws/cctv (бинарные — сами фрагменты видео). */
export type LiveServerMessage =
  | { type: "ready"; cam: string; mime: string }
  | { type: "error"; cam: string; error: string };
