import type { LiveServerMessage } from "@sweethome/cctv-shared";
import type { CameraConfig } from "../config";
import { liveArgs } from "../recorder/ffmpeg";
import { headerHasAudio, liveMime } from "../audio";
import { initSegmentLength, MAX_INIT_BYTES } from "./init-segment";

export interface LiveChild {
  stdout: { on(ev: "data", cb: (c: Buffer) => void): void } | null;
  // stderr обязателен к вычитыванию: процесс запускается с обычными каналами,
  // и непрочитанный канал на 64 КБ переполняется — ffmpeg встаёт намертво, а
  // живая картинка замирает без единого сообщения. Заодно последняя строка
  // отсюда — единственный текст, который есть смысл показать зрителю.
  stderr: { on(ev: "data", cb: (c: Buffer) => void): void } | null;
  // "error" — отдельно от "exit": неудачный спавн (нет бинарника, нет прав)
  // у настоящего child_process обычно шлёт только "error", без "exit" вовсе.
  // Оба нужно слушать явно — необработанный "error" на EventEmitter иначе
  // превращается в брошенное исключение.
  on(ev: "exit" | "error", cb: (arg?: unknown) => void): void;
  // Как у настоящего child_process.kill — чтобы реальный ChildProcess подходил
  // сюда без приведений типа.
  kill(sig?: NodeJS.Signals): void;
}

export type LiveSpawner = (cmd: string, args: string[]) => LiveChild;

/** Куда уходит поток: бинарные фрагменты и текстовые сообщения. */
export interface Sink {
  send(data: Buffer): void;
  sendText(msg: LiveServerMessage): void;
}

/**
 * Один процесс ffmpeg на камеру. Первый пришедший фрагмент — заголовок потока
 * (`ftyp`+`moov`); он запоминается и уходит каждому новому зрителю, иначе
 * браузеру нечем инициализировать воспроизведение.
 */
export class LiveSession {
  private child: LiveChild | null = null;
  private header: Buffer | null = null;
  /** Кодеки объявляем по факту: они известны только из заголовка потока. */
  private mime: string | null = null;
  /** Куски, из которых ещё собирается заголовок: ffmpeg отдаёт его не за раз. */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private sinks = new Set<Sink>();
  /** Последняя строка из stderr — причина, которую видно зрителю, когда поток умер. */
  private lastStderr: string | undefined;
  /**
   * kill() не гарантирует синхронный exit (у настоящего child_process — почти
   * никогда). Пока флаг не поднят, поздний exit уже остановленной сессии не
   * должен ничего рассылать и не должен звать onExit — иначе он способен
   * стереть из хаба чужую, уже живую сессию той же камеры.
   */
  private stopped = false;

  constructor(
    private deps: { cam: CameraConfig; ffmpegPath: string; spawn: LiveSpawner; onExit: () => void }
  ) {}

  start(): void {
    if (this.child) return;
    const child = this.deps.spawn(this.deps.ffmpegPath, liveArgs({ cam: this.deps.cam }));
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.header === null) {
        this.collectHeader(chunk);
        return;
      }
      for (const s of this.sinks) s.send(chunk);
    });

    // Читаем так же, как рекордер (recorder/process.ts): иначе канал забьётся.
    child.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim().split("\n").pop();
      if (line) this.lastStderr = line;
    });

    child.on("exit", () => this.dropDeadChild("live stream stopped"));

    // Неудачный спавн (нет бинарника ffmpeg, нет прав на него) обычно шлёт
    // только "error", без последующего "exit" — без этого слушателя this.child
    // остался бы навсегда занятым, и хаб бесконечно переиспользовал бы мёртвую
    // сессию для всех новых зрителей, ничего им не показывая.
    child.on("error", (err) => {
      const message = (err as Error)?.message ?? "unknown error";
      this.dropDeadChild(`live stream failed: ${message}`);
    });
  }

  /**
   * Собирает заголовок потока (`ftyp`+`moov`) из кусков stdout.
   *
   * Первый кусок — не весь заголовок: на живых камерах `ftyp` приезжает
   * отдельно, а `moov` следом. Пока заголовок не собран целиком, ни кодеки не
   * известны (в `moov` описание дорожек), ни зрителю послать нечего — им
   * нечего инициализировать.
   */
  private collectHeader(chunk: Buffer): void {
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;

    // Заголовок такого размера — это уже не заголовок: не копим бесконечно.
    if (this.pendingBytes > MAX_INIT_BYTES) {
      this.pending = [];
      this.pendingBytes = 0;
      this.dropDeadChild("live stream header is not readable");
      return;
    }

    const buf = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
    const len = initSegmentLength(buf);
    if (len === null) return; // ещё не всё пришло

    this.header = buf.subarray(0, len);
    this.mime = liveMime(headerHasAudio(this.header));
    this.pending = [];
    this.pendingBytes = 0;

    for (const s of this.sinks) {
      s.sendText({ type: "ready", cam: this.deps.cam.id, mime: this.mime });
      s.send(this.header);
    }
    // Хвост того же куска — уже данные, а не заголовок.
    const rest = buf.subarray(len);
    if (rest.length > 0) for (const s of this.sinks) s.send(rest);
  }

  /** Общая уборка на смерть процесса — от штатного "exit" и от неудачного спавна ("error"). */
  private dropDeadChild(error: string): void {
    if (this.stopped) return;
    this.child = null;
    this.header = null;
    this.mime = null;
    this.pending = [];
    this.pendingBytes = 0;
    // Чёрный прямоугольник без объяснений — это заявка в поддержку, а не UI:
    // если ffmpeg что-то сказал перед смертью, зритель должен это увидеть.
    const reason = this.lastStderr ? `${error}: ${this.lastStderr}` : error;
    this.lastStderr = undefined;
    for (const s of this.sinks) {
      s.sendText({ type: "error", cam: this.deps.cam.id, error: reason });
    }
    // Процесс мёртв: данные из буфера пайпа могут прийти уже после exit, а у
    // подписчика к этому моменту закрыт MediaSource — фрагмент туда слать нельзя.
    this.sinks.clear();
    this.deps.onExit();
  }

  attach(sink: Sink): void {
    this.sinks.add(sink);
    // Сессия уже идёт — новому зрителю сразу и кодеки, и заголовок, в этом порядке.
    if (this.header !== null && this.mime !== null) {
      sink.sendText({ type: "ready", cam: this.deps.cam.id, mime: this.mime });
      sink.send(this.header);
    }
  }

  detach(sink: Sink): void {
    this.sinks.delete(sink);
  }

  size(): number {
    return this.sinks.size;
  }

  stop(): void {
    const child = this.child;
    this.stopped = true;
    this.child = null;
    this.header = null;
    this.mime = null;
    this.pending = [];
    this.pendingBytes = 0;
    this.lastStderr = undefined;
    this.sinks.clear();
    child?.kill("SIGTERM");
  }
}
