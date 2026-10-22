/** RFC 9457 Problem Details, as every Sagamart HTTP API returns errors (conventions §4). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  traceId?: string;
  errors?: FieldError[];
  [extension: string]: unknown;
}

export interface FieldError {
  field: string;
  message: string;
}

export interface ProblemInit {
  status: number;
  code: string;
  title?: string;
  detail?: string;
  instance?: string;
  traceId?: string;
  errors?: FieldError[];
  /** Extra members, such as `currentVersion`. They can't replace the standard ones. */
  extensions?: Record<string, unknown>;
}

const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  422: 'Unprocessable Content',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

const STANDARD_MEMBERS = new Set([
  'type',
  'title',
  'status',
  'code',
  'detail',
  'instance',
  'traceId',
  'errors',
]);

/** Builds a Problem. `type` is https://sagamart.dev/errors/<code in kebab case>; `title` defaults from the status. */
export function problem(init: ProblemInit): Problem {
  if (!Number.isInteger(init.status) || init.status < 400 || init.status > 599) {
    throw new RangeError(`problem status must be 4xx or 5xx, got ${String(init.status)}`);
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(init.code))
    throw new RangeError(`problem code must be UPPER_SNAKE, got ${init.code}`);

  const extensions = Object.fromEntries(
    Object.entries(init.extensions ?? {}).filter(([key]) => !STANDARD_MEMBERS.has(key)),
  );
  return {
    ...extensions,
    type: `https://sagamart.dev/errors/${init.code.toLowerCase().replaceAll('_', '-')}`,
    title: init.title ?? TITLES[init.status] ?? 'Error',
    status: init.status,
    code: init.code,
    ...(init.detail === undefined ? {} : { detail: init.detail }),
    ...(init.instance === undefined ? {} : { instance: init.instance }),
    ...(init.traceId === undefined ? {} : { traceId: init.traceId }),
    ...(init.errors === undefined ? {} : { errors: init.errors }),
  };
}

/** An error that carries a Problem, for services to throw and their error filter to render. */
export class ProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ProblemError';
  }
}
