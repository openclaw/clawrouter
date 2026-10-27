// The 128 MB isolate is shared by every in-flight request, and request bodies
// are the one allocation callers size. Bodies of 1 MiB or more lease twice their
// bytes (parsed value plus one transport copy) until their response completes;
// past the budget a request is refused before it can take the isolate down.
export const bodyLeaseMinimum = 1024 * 1024;
export const bodyBudgetBytes = 96 * 1024 * 1024;
let charged = 0;

export class BodyLease {
  private held = 0;
  // False, charging nothing more, when the growth would exceed the budget.
  grow(bytes: number): boolean {
    const want = bytes < bodyLeaseMinimum ? 0 : 2 * bytes;
    if (want <= this.held) return true;
    if (charged - this.held + want > bodyBudgetBytes) return false;
    charged += want - this.held;
    this.held = want;
    return true;
  }
  get leased(): boolean { return this.held > 0; }
  release(): void { charged -= this.held; this.held = 0; }
}

export function bodyBudgetCharged(): number { return charged; }
