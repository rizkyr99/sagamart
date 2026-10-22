import 'reflect-metadata';
import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigError, createLogger } from '@sagamart/node-common';
import { Logger } from 'nestjs-pino';
import { AppModule, configureApp } from './app.module.js';
import { loadGatewayConfig } from './config.js';
import { telemetry } from './instrument.js';

async function bootstrap(): Promise<void> {
  let config;
  try {
    config = loadGatewayConfig();
  } catch (err) {
    // Before the app logger exists: still one JSON line, then exit (conventions §10: fail fast).
    const log = createLogger({
      service: 'gateway',
      env: process.env.GATEWAY_ENV ?? 'unknown',
      version: 'dev',
    });
    log.fatal(
      { problems: err instanceof ConfigError ? err.problems : [String(err)] },
      'invalid configuration',
    );
    process.exit(1);
  }

  const app = await NestFactory.create(
    AppModule.forRoot({
      config,
      metricsHandler: (request, response) => {
        telemetry.metricsHandler(request, response);
      },
      onShutdown: () => telemetry.shutdown(),
    }),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  configureApp(app, config); // includes enableShutdownHooks: SIGTERM closes the server, connections, then telemetry
  await app.listen(config.httpPort, '0.0.0.0');
  new NestLogger('Bootstrap').log({ port: config.httpPort }, 'gateway listening');
}

await bootstrap();
