function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// Daily per-entry token counters. In memory only: a restart resets them.
export class UsageTracker {
  #day = today();
  #counts = new Map<string, number>();
  #now: () => string;

  constructor(now: () => string = today) {
    this.#now = now;
    this.#day = now();
  }

  #roll(): void {
    const d = this.#now();
    if (d !== this.#day) {
      this.#day = d;
      this.#counts.clear();
    }
  }

  add(entryName: string, tokens: number): void {
    this.#roll();
    this.#counts.set(entryName, (this.#counts.get(entryName) ?? 0) + tokens);
  }

  today(entryName: string): number {
    this.#roll();
    return this.#counts.get(entryName) ?? 0;
  }

  overCap(entryName: string, cap: number | undefined): boolean {
    return cap !== undefined && this.today(entryName) >= cap;
  }
}
