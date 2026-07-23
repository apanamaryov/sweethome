export interface Transport {
  /** "serial" | "mock" */
  readonly name: string;
  /** Human-readable device path/identifier, or null. */
  readonly device: string | null;
  /** True for the simulated transport (no real inverter). */
  readonly mock: boolean;

  open(): Promise<void>;
  close(): Promise<void>;

  /**
   * Write a fully-built Modbus RTU request and read back the response.
   * `expectedLen` — длина нормального ответа; транспорт завершает чтение,
   * когда накоплено столько байт ЛИБО когда пришёл кадр-исключение
   * (5 байт, у второго байта выставлен бит 0x80).
   * Throws on timeout or I/O error.
   */
  transact(frame: Buffer, timeoutMs: number, expectedLen: number): Promise<Buffer>;
}
