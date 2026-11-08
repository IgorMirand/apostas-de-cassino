export interface PollingLoopOptions {
  batchSize: number;
  pollIntervalMs: number;
  onError?: ((error: unknown) => void) | undefined;
}

/** Laço de polling com parada graciosa: `stop()` espera o ciclo em andamento concluir. */
export class PollingLoop {
  private loop: Promise<void> | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;

  /** `cycle` devolve quantos itens pegou: lote cheio => há mais, não dorme. */
  constructor(private readonly cycle: () => Promise<number>, private readonly options: PollingLoopOptions) {}

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let handled = 0;
      try {
        handled = await this.cycle();
      } catch (error) {
        this.options.onError?.(error);
      }
      if (!this.stopping && handled < this.options.batchSize) await this.sleep(this.options.pollIntervalMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      this.wake = done;
      function done() { clearTimeout(timer); resolve(); }
    });
  }
}