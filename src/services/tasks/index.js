/**
 * Tasks Services Index
 */

const { TaskService } = require('./TaskService');
const { TaskExecutor, taskExecutor } = require('./TaskExecutor');

module.exports = {
  TaskService,
  TaskExecutor,
  taskExecutor,
};
