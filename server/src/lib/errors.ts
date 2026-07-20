/**
 * Application errors and safe error shaping.
 *
 * Clients receive a stable `code` and a message that is safe to display.
 * Internal detail (stack traces, SQL text, constraint names) never crosses the
 * boundary — those go to the server log only.
 */
export type ErrorCode =
  | 'validation_error'
  | 'invalid_credentials'
  | 'account_locked'
  | 'account_disabled'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'password_policy'
  | 'rate_limited'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'internal_error';

const STATUS: Record<ErrorCode, number> = {
  validation_error: 400,
  invalid_credentials: 401,
  account_locked: 423,
  account_disabled: 403,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  password_policy: 400,
  rate_limited: 429,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal_error: 500,
};

export class AppError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = STATUS[code];
  }
}

export const errors = {
  validation: (message: string, details?: Record<string, unknown>) => new AppError('validation_error', message, details),
  /**
   * Deliberately identical for "no such user" and "wrong password" so the
   * response cannot be used to enumerate registered email addresses.
   */
  invalidCredentials: () => new AppError('invalid_credentials', 'Incorrect email or password.'),
  accountLocked: (until: Date) =>
    new AppError('account_locked', 'Too many failed attempts. Try again later.', { retryAfter: until.toISOString() }),
  accountDisabled: () => new AppError('account_disabled', 'This account has been disabled.'),
  unauthenticated: () => new AppError('unauthenticated', 'Sign in to continue.'),
  forbidden: (message = 'You do not have permission to perform this action.') => new AppError('forbidden', message),
  notFound: (what = 'Resource') => new AppError('not_found', `${what} not found.`),
  conflict: (message: string) => new AppError('conflict', message),
  passwordPolicy: (problems: string[]) => new AppError('password_policy', 'Password does not meet the policy.', { problems }),
};

export interface ErrorResponseBody {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

export function toErrorResponse(error: unknown): { statusCode: number; body: ErrorResponseBody } {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      body: { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } },
    };
  }
  // Anything unrecognised is reported generically — no internals leak out.
  return {
    statusCode: 500,
    body: { error: { code: 'internal_error', message: 'An unexpected error occurred.' } },
  };
}
