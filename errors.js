'use strict';

/** An error whose message is safe to show to API clients. */
class ValidationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.status = status;
  }
}

module.exports = { ValidationError };
