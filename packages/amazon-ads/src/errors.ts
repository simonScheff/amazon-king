/**
 * Typed errors for the Amazon gateway. Error messages and details must never
 * contain tokens, client secrets, authorization codes, or pre-signed URLs.
 */

/** Amazon OAuth/LWA error codes that mean the grant is dead and the user must reconnect. */
const UNRECOVERABLE_AUTH_CODES = new Set([
  "invalid_grant",
  "revoked",
  "unauthorized_client",
]);

export class AmazonAuthError extends Error {
  override readonly name = "AmazonAuthError";
  /** Amazon's `error` code (e.g. "invalid_grant"). */
  readonly code: string;
  /** Amazon's human-readable `error_description`, if any. */
  readonly description?: string;
  /** True when retrying cannot help and the connection needs re-authorization. */
  readonly unrecoverable: boolean;
  readonly status?: number;

  constructor(
    code: string,
    description?: string,
    options: { unrecoverable?: boolean; status?: number } = {},
  ) {
    super(
      description
        ? `Amazon OAuth error ${code}: ${description}`
        : `Amazon OAuth error ${code}`,
    );
    this.code = code;
    this.description = description;
    this.status = options.status;
    this.unrecoverable =
      options.unrecoverable ?? UNRECOVERABLE_AUTH_CODES.has(code);
  }
}

export class AmazonApiError extends Error {
  override readonly name = "AmazonApiError";
  readonly status: number;
  /** Amazon's x-amzn-requestid (or equivalent), for support traces. */
  readonly requestId: string | null;
  readonly retryable: boolean;
  /** Sanitized (secret-redacted) response details. */
  readonly details?: unknown;

  constructor(
    message: string,
    options: {
      status: number;
      requestId?: string | null;
      retryable?: boolean;
      details?: unknown;
    },
  ) {
    super(message);
    this.status = options.status;
    this.requestId = options.requestId ?? null;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/** Network-level failure (DNS, socket, timeout) before any HTTP status arrived. */
export class AmazonNetworkError extends Error {
  override readonly name = "AmazonNetworkError";
  readonly retryable = true;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/** An Amazon payload did not match the adapter's schema (missing/wrong-typed required fields). */
export class AdapterValidationError extends Error {
  override readonly name = "AdapterValidationError";
  readonly context: string;
  readonly issues: ValidationIssue[];

  constructor(context: string, issues: ValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.path || "(root)"}: ${issue.message}`)
      .join("; ");
    super(`${context}: Amazon payload failed validation — ${summary}`);
    this.context = context;
    this.issues = issues;
  }
}
