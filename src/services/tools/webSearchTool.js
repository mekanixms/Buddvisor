/**
 * Web Search Tool using Brave Search API
 * Provides web search capabilities for agents
 */

const { toolRegistry } = require('./ToolRegistry');
const logger = require('../../utils/logger');

// Supported country codes by Brave Search API
const BRAVE_SUPPORTED_COUNTRIES = [
  'AR', 'AU', 'AT', 'BE', 'BR', 'CA', 'CL', 'DK', 'FI', 'FR', 'DE', 'GR', 
  'HK', 'IN', 'ID', 'IT', 'JP', 'KR', 'MY', 'MX', 'NL', 'NZ', 'NO', 'CN', 
  'PL', 'PT', 'PH', 'RU', 'SA', 'ZA', 'ES', 'SE', 'CH', 'TW', 'TR', 'GB', 'US', 'ALL'
];

/**
 * Register web search tool
 */
function registerWebSearchTool() {
  toolRegistry.register({
    name: 'web_search',
    description: 'Search the web using Brave Search API. Returns relevant web results including titles, descriptions, and URLs. Use this to find current information, facts, news, or any information not in your knowledge base.',
    category: 'utility',
    parameters: {
      query: {
        type: 'string',
        description: 'The search query string. Be specific and use relevant keywords.',
        required: true,
        minLength: 1,
        maxLength: 400,
      },
      count: {
        type: 'number',
        description: 'Number of search results to return (1-20). Default is 5.',
        required: false,
        minimum: 1,
        maximum: 20,
      },
      freshness: {
        type: 'string',
        description: 'Time range for results: "24h" (past day), "week" (past week), "month" (past month), "year" (past year)',
        required: false,
        enum: ['24h', 'week', 'month', 'year'],
      },
      country: {
        type: 'string',
        description: 'Country code for localized results. Supported: AR, AU, AT, BE, BR, CA, CL, DK, FI, FR, DE, GR, HK, IN, ID, IT, JP, KR, MY, MX, NL, NZ, NO, CN, PL, PT, PH, RU, SA, ZA, ES, SE, CH, TW, TR, GB, US, or ALL. Default is "ALL" for global results. Invalid values are treated as ALL.',
        required: false,
        // No enum here: invalid values are normalized to "ALL" in the handler to avoid failing on wrong LLM output.
      },
      search_lang: {
        type: 'string',
        description: 'Language code for search (e.g., "en", "es", "fr"). Default is "en".',
        required: false,
      },
    },
    handler: async (params) => {
      const { query, count = 5, freshness, search_lang = 'en' } = params;
      
      // Validate and fallback country code
      let country = params.country || 'ALL';
      if (!BRAVE_SUPPORTED_COUNTRIES.includes(country.toUpperCase())) {
        logger.warn(`Unsupported country code "${country}", falling back to "ALL"`);
        country = 'ALL';
      } else {
        country = country.toUpperCase();
      }

      const apiKey = process.env.BRAVE_SEARCH_API_KEY;

      if (!apiKey) {
        logger.error('BRAVE_SEARCH_API_KEY not found in environment variables');
        return {
          error: 'Web search is not configured. Please set BRAVE_SEARCH_API_KEY in environment variables.',
          results: [],
        };
      }

      try {
        // Build search URL with parameters
        const searchParams = new URLSearchParams({
          q: query,
          count: count.toString(),
          country: country,
          search_lang: search_lang,
        });

        if (freshness) {
          searchParams.append('freshness', freshness);
        }

        const url = `https://api.search.brave.com/res/v1/web/search?${searchParams.toString()}`;

        logger.info(`Brave Search request: query="${query}", count=${count}, country=${country}`);

        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': apiKey,
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.error(`Brave Search API error: ${response.status} ${response.statusText} - ${errorText}`);

          return {
            error: `Search API error: ${response.status} ${response.statusText}`,
            results: [],
            query: query,
          };
        }

        const data = await response.json();

        // Extract web results
        const webResults = data.web?.results || [];

        // Format results for the agent
        const formattedResults = webResults.map((result, index) => ({
          position: index + 1,
          title: result.title,
          url: result.url,
          description: result.description || '',
          age: result.age || null, // How old the page is
          language: result.language || null,
        }));

        logger.info(`Brave Search returned ${formattedResults.length} results for: "${query}"`);

        return {
          query: query,
          result_count: formattedResults.length,
          results: formattedResults,
          // Include search metadata if available
          ...(data.query && {
            original_query: data.query.original,
            altered_query: data.query.altered,
          }),
        };
      } catch (error) {
        logger.error('Error in web_search tool:', error);

        return {
          error: `Failed to perform web search: ${error.message}`,
          results: [],
          query: query,
        };
      }
    },
    examples: [
      {
        description: 'Search for current news about AI',
        parameters: {
          query: 'latest artificial intelligence news',
          count: 5,
          freshness: '24h',
        },
      },
      {
        description: 'Find information about a company',
        parameters: {
          query: 'Microsoft Corporation revenue 2024',
          count: 3,
        },
      },
      {
        description: 'Search for technical documentation',
        parameters: {
          query: 'React hooks tutorial',
          count: 5,
        },
      },
    ],
    requiresAuth: false,
  });

  logger.info('Web search tool registered (Brave Search)');
}

module.exports = { registerWebSearchTool };
