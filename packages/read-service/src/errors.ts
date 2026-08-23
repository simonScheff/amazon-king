/**
 * API error shape: every non-2xx response carries
 * `{ error: { code, message, details? } }`, which the web client's
 * `apiFetch` normalizes into an ApiError.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown): ApiError {
  return new ApiError(400, "BAD_REQUEST", message, details);
}

export function validationError(issues: unknown): ApiError {
  return new ApiError(400, "VALIDATION_ERROR", "Request failed validation", {
    issues,
  });
}

export function unauthorized(
  code: "UNAUTHENTICATED" | "REAUTH_REQUIRED" = "UNAUTHENTICATED",
  message = "Sign-in required",
): ApiError {
  return new ApiError(401, code, message);
}

export function forbidden(code: string, message: string): ApiError {
  return new ApiError(403, code, message);
}

export function notFound(message = "Not found"): ApiError {
  return new ApiError(404, "NOT_FOUND", message);
}

export function conflict(code: string, message: string, details?: unknown) {
  return new ApiError(409, code, message, details);
}
