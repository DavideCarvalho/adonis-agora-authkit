import { createInterface, type Interface } from 'node:readline/promises';

/** Line prompts on the terminal, including hidden input for secret fields (4.7). */
export class Prompter {
  private rl?: Interface;

  get interface(): Interface {
    this.rl ??= createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY,
    });
    return this.rl;
  }

  get interactive(): boolean {
    return Boolean(process.stdin.isTTY);
  }

  ask(question: string, signal?: AbortSignal): Promise<string> {
    return signal
      ? this.interface.question(question, { signal })
      : this.interface.question(question);
  }

  /** Reads without echoing: the value is never shown back, logged, or stored by the CLI. */
  async askSecret(question: string): Promise<string> {
    const rl = this.interface as unknown as { _writeToOutput?: (s: string) => void };
    const original = rl._writeToOutput;
    let shown = false;
    rl._writeToOutput = (s: string) => {
      if (!shown) {
        shown = true;
        original?.call(rl, s);
      }
    };
    try {
      return await this.interface.question(question);
    } finally {
      rl._writeToOutput = original;
      process.stdout.write('\n');
    }
  }

  async confirm(question: string): Promise<boolean> {
    if (!this.interactive) return false;
    return /^y(es)?$/i.test((await this.ask(`${question} [y/N] `)).trim());
  }

  close() {
    this.rl?.close();
    this.rl = undefined;
  }
}
