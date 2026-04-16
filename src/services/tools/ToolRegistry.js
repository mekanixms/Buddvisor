/**
 * Tool Registry
 * Manages registration and discovery of MCP-compatible tools
 */

const logger = require('../../utils/logger');

class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.categories = new Map();
  }

  /**
   * Register a tool
   * @param {object} toolDefinition - Tool definition object
   */
  register(toolDefinition) {
    const {
      name,
      description,
      category = 'general',
      parameters = {},
      handler,
      examples = [],
      requiresAuth = false,
      executionTimeout,
    } = toolDefinition;

    if (!name || !handler) {
      throw new Error('Tool must have a name and handler');
    }

    if (this.tools.has(name)) {
      logger.warn(`Tool ${name} is being overwritten`);
    }

    const tool = {
      name,
      description,
      category,
      parameters,
      handler,
      examples,
      requiresAuth,
      executionTimeout,
      registeredAt: new Date().toISOString(),
    };

    this.tools.set(name, tool);

    // Update category index
    if (!this.categories.has(category)) {
      this.categories.set(category, new Set());
    }
    this.categories.get(category).add(name);

    logger.info(`Tool registered: ${name} (${category})`);
  }

  /**
   * Unregister a tool
   */
  unregister(name) {
    const tool = this.tools.get(name);
    if (tool) {
      this.tools.delete(name);
      this.categories.get(tool.category)?.delete(name);
      logger.info(`Tool unregistered: ${name}`);
    }
  }

  /**
   * Get a tool by name
   */
  get(name) {
    return this.tools.get(name);
  }

  /**
   * Check if a tool exists
   */
  has(name) {
    return this.tools.has(name);
  }

  /**
   * Get all tools
   */
  getAll() {
    return Array.from(this.tools.values());
  }

  /**
   * Get tools by category
   */
  getByCategory(category) {
    const toolNames = this.categories.get(category);
    if (!toolNames) return [];
    return Array.from(toolNames).map(name => this.tools.get(name));
  }

  /**
   * Get all categories
   */
  getCategories() {
    return Array.from(this.categories.keys());
  }

  /**
   * Clean a property schema by removing 'required' field and processing nested structures
   * All LLM APIs expect 'required' only as a top-level array, not on each property
   */
  cleanPropertySchema(propSchema) {
    // Remove 'required' and other non-standard fields from the property
    const { required, ...cleanedSchema } = propSchema;

    // Handle nested objects recursively
    if (cleanedSchema.type === 'object' && cleanedSchema.properties) {
      const cleanedProps = {};
      for (const [key, value] of Object.entries(cleanedSchema.properties)) {
        cleanedProps[key] = this.cleanPropertySchema(value);
      }
      cleanedSchema.properties = cleanedProps;
    }

    // Handle array items recursively
    if (cleanedSchema.type === 'array' && cleanedSchema.items) {
      cleanedSchema.items = this.cleanPropertySchema(cleanedSchema.items);
    }

    return cleanedSchema;
  }

  /**
   * Get tool definitions formatted for LLM
   * This format is compatible with Claude's tool use and other providers
   * Properties are cleaned to remove 'required' booleans (required is only at top level)
   */
  getToolDefinitionsForLLM(toolNames = null) {
    const tools = toolNames
      ? toolNames.map(name => this.tools.get(name)).filter(Boolean)
      : this.getAll();

    return tools.map(tool => {
      // Clean properties by removing 'required' from each property
      const cleanedProperties = {};
      for (const [propName, propSchema] of Object.entries(tool.parameters)) {
        cleanedProperties[propName] = this.cleanPropertySchema(propSchema);
      }

      return {
        name: tool.name,
        description: tool.description,
        input_schema: {
          type: 'object',
          properties: cleanedProperties,
          required: Object.entries(tool.parameters)
            .filter(([_, schema]) => schema.required)
            .map(([name]) => name),
        },
      };
    });
  }

  /**
   * Get tool definitions formatted for OpenAI function calling
   */
  getToolDefinitionsForOpenAI(toolNames = null) {
    const tools = toolNames
      ? toolNames.map(name => this.tools.get(name)).filter(Boolean)
      : this.getAll();

    return tools.map(tool => {
      // Clean properties by removing 'required' from each property
      const cleanedProperties = {};
      for (const [propName, propSchema] of Object.entries(tool.parameters)) {
        cleanedProperties[propName] = this.cleanPropertySchema(propSchema);
      }

      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: 'object',
            properties: cleanedProperties,
            required: Object.entries(tool.parameters)
              .filter(([_, schema]) => schema.required)
              .map(([name]) => name),
          },
        },
      };
    });
  }

  /**
   * Search tools by query
   */
  search(query) {
    const lowerQuery = query.toLowerCase();
    return this.getAll().filter(tool =>
      tool.name.toLowerCase().includes(lowerQuery) ||
      tool.description.toLowerCase().includes(lowerQuery) ||
      tool.category.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * Get tool count
   */
  get count() {
    return this.tools.size;
  }

  /**
   * Get registry summary
   */
  getSummary() {
    const categories = {};
    for (const [category, toolNames] of this.categories) {
      categories[category] = toolNames.size;
    }

    return {
      totalTools: this.tools.size,
      categories,
    };
  }
}

// Create singleton instance
const toolRegistry = new ToolRegistry();

module.exports = { ToolRegistry, toolRegistry };
