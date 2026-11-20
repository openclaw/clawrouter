// Run each owned cleanup once, preserving the original failure and cleanup order.
export async function cleanupFixture(steps, primary = { failed: false }) {
  const failures = [];
  for (const step of steps) {
    try { await step(); } catch (error) { failures.push(error); }
  }
  if (!failures.length) return;
  if (primary.failed) failures.unshift(primary.error);
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, "Fixture operation and cleanup failed");
}
