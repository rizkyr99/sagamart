// Run by telemetry-logs.test.ts in a plain node process: require hooks (and so pino instrumentation) only apply there,
// not inside Vitest. Prints every request an OTLP endpoint received while a service logged.
// Usage: node otlp-log-leak.cjs <path to the built package>
const http = require('node:http');
const { PassThrough } = require('node:stream');
const dist = process.argv[2];
const received = [];
const server = http.createServer((req, res) => {
  received.push(`${req.method} ${req.url}`);
  req.resume();
  res.end();
});
server.listen(0, '127.0.0.1', async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  const { startTelemetry } = require(`${dist}/telemetry`);
  const telemetry = startTelemetry({ service: 'leak-check', version: '0', env: 'test' });
  const { createLogger } = require(dist); // loaded after telemetry, as in a service
  const log = createLogger({
    service: 'leak-check',
    env: 'test',
    version: '0',
    destination: new PassThrough(),
  });
  for (let i = 0; i < 5; i++) log.info({ i }, 'should stay local');
  await telemetry.shutdown();
  console.log(JSON.stringify(received));
  server.close();
});
