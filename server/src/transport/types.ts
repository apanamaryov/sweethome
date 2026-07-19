export interface Transport {
  /** "serial" | "hid" | "mock" */
  readonly name: string;
  /** Human-readable device path/identifier, or null. */
  readonly device: string | null;
  /** True for the simulated transport (no real inverter). */
  readonly mock: boolean;

  open(): Promise<void>;
  close(): Promise<void>;

  /**
   * Write a fully-built command frame (command + CRC + CR) and read back the
   * complete response bytes (up to and including the trailing CR).
   * Throws on timeout or I/O error.
   */
  transact(frame: Buffer, timeoutMs: number): Promise<Buffer>;
}
