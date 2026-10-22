import { Catch, HttpException, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import { ProblemError, problem } from '@sagamart/node-common';
import type { Problem } from '@sagamart/node-common';
import type { Request, Response } from 'express';

const CODES: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

/** Renders every error as RFC 9457 Problem Details (conventions §4). Unknown errors are logged, never echoed. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger('ProblemFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    let body: Problem;
    if (exception instanceof ProblemError) {
      body = exception.problem;
    } else if (exception instanceof HttpException && exception.getStatus() < 500) {
      const status = exception.getStatus();
      body = problem({ status, code: CODES[status] ?? `HTTP_${String(status)}`, detail: exception.message });
    } else {
      this.log.error({ err: exception, path: request.originalUrl }, 'unhandled error');
      body = problem({ status: 500, code: 'INTERNAL_ERROR', detail: 'Something went wrong on our side.' });
    }

    const span = trace.getSpanContext(context.active());
    const rendered: Problem = {
      ...body,
      instance: body.instance ?? request.originalUrl,
      ...(span && isSpanContextValid(span) ? { traceId: span.traceId } : {}),
    };
    // Unavailable means "retry": say when (contracts: Unavailable carries Retry-After).
    if (rendered.status === 503) response.setHeader('Retry-After', '1');
    response
      .status(rendered.status)
      .setHeader('content-type', 'application/problem+json; charset=utf-8')
      .send(JSON.stringify(rendered));
  }
}
