/**
 * In-process event bus for chat messages.
 * Message.create emits 'created' with the stored message row, so channels such as
 * Telegram can follow a session without every caller knowing about them.
 */

const { EventEmitter } = require('events');

const messageEvents = new EventEmitter();
messageEvents.setMaxListeners(20);

module.exports = messageEvents;
