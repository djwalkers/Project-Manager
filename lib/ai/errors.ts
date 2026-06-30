/** Thrown when the provider call succeeds but the response can't be used. Safe message shown in UI. */
export class AnalysisError extends Error {
  readonly isAnalysisError = true;
  constructor(message: string) {
    super(message);
    this.name = "AnalysisError";
  }
}
