# Fusion test deadlines

Disposable checks can retain a declared Node test deadline when switching to
failure-stop execution:

```js
await check(box, paths, 120_000, {
  testTimeoutMs: 5_000,
  stopOnTestFailure: true,
});
```

`testTimeoutMs` is optional. It must be a positive integer no greater than Node's
2,147,483,647 ms timer limit and smaller than the outer process-group watchdog. Without it, the existing invocation is unchanged.
The ordinary runner passes `--test-timeout`; the failure-stop runner passes the
corresponding `timeout` option to [Node's test runner](https://nodejs.org/docs/latest-v24.x/api/test.html#runoptions).
A timeout is a failure, never a passing incomplete result. The outer watchdog
still handles blocked event loops and leaked handles. Callers must dispose of
failure-stop sandboxes before reuse.

Choose deadlines in the experiment protocol and validate passing controls.
Changing a deadline changes the acceptance policy; do not alter one during a
frozen trial or infer quality or latency improvements from this helper alone.
