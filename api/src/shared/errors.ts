export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly fieldErrors?: Record<string, string[]>;

  constructor(params: {
    statusCode: number;
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]>;
  }) {
    super(params.message);
    this.name = new.target.name;
    this.statusCode = params.statusCode;
    this.code = params.code;
    this.fieldErrors = params.fieldErrors;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', fieldErrors?: Record<string, string[]>) {
    super({ statusCode: 400, code: 'VALIDATION_ERROR', message, fieldErrors });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super({ statusCode: 401, code: 'UNAUTHORIZED', message });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions', code = 'FORBIDDEN') {
    super({ statusCode: 403, code, message });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super({ statusCode: 404, code: 'NOT_FOUND', message });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict with current resource state', code = 'CONFLICT') {
    super({ statusCode: 409, code, message });
  }
}

export class UnprocessableError extends AppError {
  constructor(message = 'Business rule violation', code = 'BUSINESS_RULE_VIOLATION') {
    super({ statusCode: 422, code, message });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests. Please try again later.') {
    super({ statusCode: 429, code: 'RATE_LIMITED', message });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Required dependency unavailable') {
    super({ statusCode: 503, code: 'SERVICE_UNAVAILABLE', message });
  }
}
