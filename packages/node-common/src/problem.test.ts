import { describe, expect, it } from 'vitest';
import { ProblemError, problem } from './problem';

describe('problem', () => {
  it('derives type and title from code and status', () => {
    expect(
      problem({ status: 422, code: 'CART_LINE_LIMIT', detail: 'A cart holds at most 50 lines.' }),
    ).toEqual({
      type: 'https://sagamart.dev/errors/cart-line-limit',
      title: 'Unprocessable Content',
      status: 422,
      code: 'CART_LINE_LIMIT',
      detail: 'A cart holds at most 50 lines.',
    });
  });

  it('keeps an explicit title and optional members', () => {
    const p = problem({
      status: 400,
      code: 'VALIDATION_FAILED',
      title: 'Validation failed',
      instance: '/v1/products',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      errors: [{ field: 'limit', message: 'too big' }],
    });
    expect(p).toMatchObject({
      title: 'Validation failed',
      instance: '/v1/products',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      errors: [{ field: 'limit', message: 'too big' }],
    });
  });

  it('adds extensions without letting them replace standard members', () => {
    const p = problem({
      status: 409,
      code: 'VERSION_CONFLICT',
      extensions: { currentVersion: 7, status: 200, code: 'OK' },
    });
    expect(p.currentVersion).toBe(7);
    expect(p.status).toBe(409);
    expect(p.code).toBe('VERSION_CONFLICT');
  });

  it('omits absent optional members', () => {
    expect(Object.keys(problem({ status: 404, code: 'NOT_FOUND' })).sort()).toEqual([
      'code',
      'status',
      'title',
      'type',
    ]);
  });

  it('rejects codes that are not UPPER_SNAKE and statuses outside 4xx/5xx', () => {
    expect(() => problem({ status: 404, code: 'not-found' })).toThrow();
    expect(() => problem({ status: 200, code: 'OK' })).toThrow();
  });

  it('wraps into a ProblemError', () => {
    const err = new ProblemError(problem({ status: 404, code: 'NOT_FOUND', detail: 'No such product.' }));
    expect(err.message).toBe('No such product.');
    expect(err.problem.status).toBe(404);
  });
});
