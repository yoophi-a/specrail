export class SpecRailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends SpecRailError {}

export class ConflictError extends SpecRailError {
  constructor(
    message: string,
    readonly details?: Array<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export class ValidationError extends SpecRailError {}
