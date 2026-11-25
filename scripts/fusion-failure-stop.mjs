// Consume test-runner events, never candidate stdout, to stop known failures.
const program = String.raw`
const { run } = require('node:test');
const { tap } = require('node:test/reporters');
const config = JSON.parse(process.argv[2]);
const controller = new AbortController();
const marked = value => value === true || typeof value === 'string';
const stream = run({
  files: config.paths,
  isolation: 'process',
  execArgv: config.exposeGc ? ['--expose-gc'] : [],
  ...(config.pattern === undefined ? {} : { testNamePatterns: config.pattern }),
  signal: controller.signal,
});
stream.on('test:fail', event => {
  if (marked(event.todo) || marked(event.skip)) return;
  process.exitCode = 1;
  if (!controller.signal.aborted) controller.abort();
});
stream.compose(tap).pipe(process.stdout);
`;

export function failureStopCommand(paths, { exposeGc, pattern }) {
  return { args: ['node', '-', JSON.stringify({ paths, exposeGc, pattern })], input: program };
}
