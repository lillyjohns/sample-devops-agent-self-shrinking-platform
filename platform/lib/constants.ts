/**
 * The name under which the Gateway is registered with DevOps Agent as an MCP server.
 * Keep it short: DevOps Agent enforces len(serverName + '_' + toolName) <= 64,
 * and Gateway tool names are already prefixed as `<targetName>___<toolName>`.
 */
export const MCP_SERVER_NAME = 'gov-gw';

/** DevOps Agent hard limit on combined `<serverName>_<toolName>` length. */
export const MAX_COMBINED_TOOL_NAME = 64;

/** Built-in Gateway semantic search tool — allowlisted so the agent can discover new capabilities. */
export const GATEWAY_SEARCH_TOOL = 'x_amz_bedrock_agentcore_search';
