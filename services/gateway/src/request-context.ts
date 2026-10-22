import { ANONYMOUS } from './dev-auth.js';
import type { Caller } from './dev-auth.js';
import type { Deadline } from './deadline.js';

const CALLER = Symbol('sagamart:caller');
const DEADLINE = Symbol('sagamart:deadline');

interface WithContext {
  [CALLER]?: Caller;
  [DEADLINE]?: Deadline;
}

export function setCaller(request: unknown, caller: Caller): void {
  (request as WithContext)[CALLER] = caller;
}

export function setDeadline(request: unknown, deadline: Deadline): void {
  (request as WithContext)[DEADLINE] = deadline;
}

/** Who made this request; anonymous until AuthMiddleware has run. */
export const callerOf = (request: unknown): Caller => (request as WithContext)[CALLER] ?? ANONYMOUS;

/** When this request must be answered by; outbound calls are capped by it. */
export const deadlineOf = (request: unknown): Deadline => {
  const deadline = (request as WithContext)[DEADLINE];
  if (!deadline) throw new Error('no deadline on this request; is AuthMiddleware applied to the route?');
  return deadline;
};
