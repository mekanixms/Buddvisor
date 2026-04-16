const { validationResult } = require('express-validator');
const { AppError } = require('./errorHandler');

// Validation result handler
const validate = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(error => ({
      field: error.path || error.param,
      message: error.msg,
    }));

    return next(new AppError(
      'Validation failed',
      400,
      'VALIDATION_ERROR',
      errorMessages
    ));
  }

  next();
};

module.exports = validate;
