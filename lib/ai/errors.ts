/** Thrown when the provider call succeeds but the response can't be used. Safe message shown in UI. */
export class AnalysisError extends Error {
  readonly isAnalysisError = true;
  constructor(message: string) {
    super(message);
    this.name = "AnalysisError";
  }
}

/** Thrown when the provider returns 429. Carries the Retry-After seconds if provided. */
export class RateLimitError extends Error {
  readonly isRateLimitError = true;
  readonly retryAfterSeconds?: number;
  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
