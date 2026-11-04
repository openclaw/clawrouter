// The 128 MB isolate is shared by every in-flight request, and request bodies
// are the one allocation callers size. Bodies of 1 MiB or more lease twice their
// bytes (parsed value plus one transport copy) until their response completes;
// past the budget a request is refused before it can take the isolate down.
export const bodyLeaseMinimum = 1024 * 1024;
export const bodyBudgetBytes = 96 * 1024 * 1024;
let charged = 0;

export class BodyLease {
  private held = 0;
  private transferred = false;
  // False, charging nothing more, when the growth would exceed the budget.
  grow(bytes: number): boolean {
    if (this.transferred) return false;
    const want = bytes < bodyLeaseMinimum ? 0 : 2 * bytes;
    if (want <= this.held) return true;
    if (charged - this.held + want > bodyBudgetBytes) return false;
    charged += want - this.held;
    this.held = want;
    return true;
  }
  // Inputs are exact pool charges, unlike grow's input-byte estimate. The caller
  // must retire every allocation not covered by the two successor lifetimes.
  splitCharges(retainedInputChargeBytes: number, responseChargeBytes: number): readonly [retainedInput: BodyLease, response: BodyLease] | null {
    if (this.transferred || !Number.isSafeInteger(this.held) || this.held <= 0 || this.held > bodyBudgetBytes
      || !Number.isSafeInteger(retainedInputChargeBytes) || retainedInputChargeBytes <= 0 || retainedInputChargeBytes > bodyBudgetBytes
      || !Number.isSafeInteger(responseChargeBytes) || responseChargeBytes <= 0 || responseChargeBytes > bodyBudgetBytes) return null;
    const total = retainedInputChargeBytes + responseChargeBytes;
    const next = charged - this.held + total;
    if (total > bodyBudgetBytes || !Number.isSafeInteger(next) || next < total || next > bodyBudgetBytes) return null;
    // No await, release/reacquire, or successor allocation on a failed verdict.
    const retainedInput = new BodyLease(), response = new BodyLease();
    retainedInput.held = retainedInputChargeBytes;
    response.held = responseChargeBytes;
    charged = next;
    this.held = 0;
    this.transferred = true;
    return [retainedInput, response];
  }
  get leased(): boolean { return this.held > 0; }
  release(): void { charged -= this.held; this.held = 0; }
}

export function bodyBudgetCharged(): number { return charged; }
