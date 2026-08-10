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
  /** Free Preview: full features, no durable writes. See guards/persistence. */
  | 'subscription_required_for_persistence'
  | 'not_found'
  | 'conflict'
  | 'password_policy'
  /** An administrator-issued temporary password has passed its expiry. */
  | 'password_expired'
  /** A forced password change is outstanding; nothing else is permitted first. */
  | 'password_change_required'
  /**
   * A step-up check failed on an irreversible action. Distinct from
   * `invalid_credentials`: the caller is already authenticated, so nothing can be
   * enumerated, and the dialog should re-prompt in place rather than sign out.
   */
  | 'reauthentication_failed'
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
  subscription_required_for_persistence: 403,
  not_found: 404,
  conflict: 409,
  password_policy: 400,
  password_expired: 401,
  password_change_required: 403,
  // The caller IS authenticated; the step-up failed. 403, not 401 — a 401 would
  // make the client discard a perfectly good session.
  reauthentication_failed: 403,
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
  /**
   * A Free Preview customer attempted a DURABLE business write. The exact body
   * the lifecycle rule specifies — the client shows it as "explore freely, but
   * this is not saved yet", never as a permission failure.
   */
  persistenceRequiresSubscription: () =>
    new AppError(
      'subscription_required_for_persistence',
      'Activate your subscription to save records permanently.',
    ),
  notFound: (what = 'Resource') => new AppError('not_found', `${what} not found.`),
  /**
   * A step-up check failed. Distinct from `invalid_credentials`: the caller IS
   * authenticated, so nothing can be enumerated, and the client should re-prompt
   * for the password in place rather than bounce to sign-in.
   */
  reauthenticationFailed: () =>
    new AppError('reauthentication_failed', 'That password is not correct. Confirm your password to continue.'),
  conflict: (message: string) => new AppError('conflict', message),
  /**
   * The password was CORRECT but has expired. Safe to say so: reaching this
   * point already required the credential, so it reveals nothing to a guesser.
   */
  passwordExpired: () =>
    new AppError(
      'password_expired',
      'This temporary password has expired. Ask your administrator to issue a new one.',
    ),
  /**
   * The forced-change gate. The client is expected to send the user straight to
   * the change-password screen rather than showing this as a failure.
   */
  passwordChangeRequired: () =>
    new AppError(
      'password_change_required',
      'You must choose a new password before continuing.',
    ),
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
