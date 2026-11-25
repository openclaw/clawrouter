# Stop public checks after a test failure

A failing Node test can leave open handles after the failure is already known.
The ordinary outer watchdog still bounds that run, but waiting for it can make
cheap-first verification slower than direct inference.

For public acceptance checks in a disposable sandbox, opt in with:

```js
const box = await sandbox(image);
try {
  return await check(box, testPaths, 120000, { stopOnTestFailure: true });
} finally {
  await box.close();
}
```

This mode listens to Node's structured `test:fail` events and aborts the test
runner after a failure that is not marked TODO or skipped. Candidate stdout
cannot trigger it by printing a failure-looking line. The existing outer
process-group watchdog remains in place. GC exposure and required test-name
selection still apply. The default check command is unchanged.

Passing candidates must finish the complete selected test run. Nothing returns
a pass early. A stopped run may have incomplete TAP accounting and
`valid: false`; treat that as rejection, not as a completed full-test grade.
Keep independent full grading separate from this public acceptance check.

Always dispose of the sandbox after this check. Aborting Node's runner does not
prove that every descendant created by candidate code has exited; do not reuse
the sandbox for another candidate. Disposal removes the remaining processes.
This is the same single-use ownership boundary used by isolated verification.

Enable this in a new, frozen experiment before measuring its effect. It changes
failure feedback and execution timing, so do not turn it on during a trial or
combine its measurements with a previously frozen default run. Fixture-level
speedups do not establish a model-quality gain or production latency result.

## Focused evidence

On a pinned Node 24.22.1 runtime, both a failed assertion with an open handle
and an uncaught exception with a pending test emitted failure events before
reaching a two-second outer deadline. The event-aborting prototype returned
in roughly 60 ms; forged output and TODO cases did not trigger cancellation.

A replay of a saved Undici request-header repair kept the same public verdicts:
the rejected draft failed in 128 ms, and the passing control completed its full
check in 4.16 seconds. These are diagnostic replays, not a paired model study or
an end-to-end service benchmark. The running model-format experiment does not
enable this mode.

The programmatic runner retains the CLI default file concurrency. Failure-stop
changes rejection timing, not the scheduling policy for passing test files.
