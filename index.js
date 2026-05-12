const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const z = require('zod/v4');

const server = new McpServer(
  {
    version: '1.0.0',
    name: 'vscode-task-mcp',
    title: 'VSCode Task MCP Server',
  },
  {
    instructions: 'MCP server that exposes VS Code task definitions to AI agents for execution.',
  },
);

server.registerTool(
  'execute_task',
  {
    title: '',
    description: '',
    inputSchema: { label: z.string().describe(''), isBackground: z.boolean().describe(''), params: z.array(z.string()).describe('') },
  },
  async ({ label, isBackground, params }) => {
    return { content: [{ type: 'text', text: `${label} ${isBackground} ${params.join(' ')}` }] };
  },
);

const transport = new StdioServerTransport();
server.connect(transport);
