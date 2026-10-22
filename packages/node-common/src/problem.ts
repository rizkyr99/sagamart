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

/** Builds a Problem. `type` is https://sagamart.dev/errors/<code in kebab case>; `title` defaults from the status. */
export function problem(_init: ProblemInit): Problem {
  throw new Error('not implemented');
}

/** An error that carries a Problem, for services to throw and their error filter to render. */
export class ProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ProblemError';
  }
}
