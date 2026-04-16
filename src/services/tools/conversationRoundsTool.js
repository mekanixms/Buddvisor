/**
 * Conversation Rounds Tool
 * Allows agents in conversation mode to get and modify round numbers and max rounds
 */

const { toolRegistry } = require('./ToolRegistry');
const conversationModeService = require('../chat/ConversationModeService');
const logger = require('../../utils/logger');

function registerConversationRoundsTool() {
  toolRegistry.register({
    name: 'conversation_rounds',
    description: 'Get or modify conversation mode round numbers. Use this to check current round, max rounds, or adjust them during the conversation. Only works when conversation mode is active.',
    category: 'conversation',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['get', 'set_current', 'set_max'],
          description: 'Operation to perform: "get" to retrieve current state, "set_current" to change current round number, "set_max" to change max rounds',
        },
        current_round: {
          type: 'integer',
          description: 'New current round number (for set_current operation). Must be >= 0. Use this to jump forward or backward in rounds.',
        },
        max_rounds: {
          type: 'integer',
          description: 'New max rounds value (for set_max operation). Must be between 1 and 100. Use this to extend or reduce the conversation length.',
        },
      },
      required: ['operation'],
    },
    handler: async (params, context) => {
      const { operation, current_round, max_rounds } = params;

      if (!context.sessionId) {
        throw new Error('sessionId is required in context');
      }

      // Get conversation state
      const state = conversationModeService.getConversationState(context.sessionId);

      if (!state) {
        return {
          success: false,
          error: 'Conversation mode is not active for this session. This tool only works during active conversation mode sessions.',
        };
      }

      try {
        switch (operation) {
          case 'get': {
            return {
              success: true,
              current_round: state.currentRound,
              max_rounds: state.maxRounds,
              status: state.status,
              message: `Current round: ${state.currentRound}/${state.maxRounds}. Status: ${state.status}`,
            };
          }

          case 'set_current': {
            if (current_round === undefined || current_round === null) {
              return {
                success: false,
                error: 'current_round parameter is required for set_current operation',
              };
            }

            if (!Number.isInteger(current_round) || current_round < 0) {
              return {
                success: false,
                error: 'current_round must be a non-negative integer',
              };
            }

            const oldRound = state.currentRound;
            state.currentRound = current_round;

            logger.info(`[conversation_rounds] Agent ${context.agentId} changed current round from ${oldRound} to ${current_round} in session ${context.sessionId}`);

            return {
              success: true,
              previous_round: oldRound,
              current_round: state.currentRound,
              max_rounds: state.maxRounds,
              message: `Current round changed from ${oldRound} to ${current_round}. Progress: ${state.currentRound}/${state.maxRounds}`,
            };
          }

          case 'set_max': {
            if (max_rounds === undefined || max_rounds === null) {
              return {
                success: false,
                error: 'max_rounds parameter is required for set_max operation',
              };
            }

            if (!Number.isInteger(max_rounds) || max_rounds < 1 || max_rounds > 100) {
              return {
                success: false,
                error: 'max_rounds must be an integer between 1 and 100',
              };
            }

            const oldMax = state.maxRounds;
            state.maxRounds = max_rounds;

            logger.info(`[conversation_rounds] Agent ${context.agentId} changed max rounds from ${oldMax} to ${max_rounds} in session ${context.sessionId}`);

            return {
              success: true,
              previous_max_rounds: oldMax,
              current_round: state.currentRound,
              max_rounds: state.maxRounds,
              message: `Max rounds changed from ${oldMax} to ${max_rounds}. Progress: ${state.currentRound}/${state.maxRounds}`,
            };
          }

          default:
            return {
              success: false,
              error: `Unknown operation: ${operation}. Valid operations are: get, set_current, set_max`,
            };
        }
      } catch (error) {
        logger.error('[conversation_rounds] Error:', error);
        return {
          success: false,
          error: error.message || 'Unknown error occurred',
        };
      }
    },
    examples: [
      {
        description: 'Get current round and max rounds',
        input: { operation: 'get' },
      },
      {
        description: 'Jump to round 5',
        input: { operation: 'set_current', current_round: 5 },
      },
      {
        description: 'Extend conversation to 20 rounds',
        input: { operation: 'set_max', max_rounds: 20 },
      },
    ],
  });
}

module.exports = { registerConversationRoundsTool };
