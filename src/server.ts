import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { TaskManager } from './task-manager';
import type { TaskInfo } from './types';

export class McpHttpServer {
  private httpServer: http.Server | null = null;
  private transports: Map<string, StreamableHTTPServerTransport> = new Map();
  private taskManager: TaskManager;
  private outputChannel: vscode.OutputChannel;
  private statusBarItem: vscode.StatusBarItem;
  private port: number;

  constructor(
    outputChannel: vscode.OutputChannel,
    statusBarItem: vscode.StatusBarItem,
  ) {
    this.outputChannel = outputChannel;
    this.statusBarItem = statusBarItem;
    this.taskManager = new TaskManager(outputChannel);
    this.port = vscode.workspace.getConfiguration('vscodeTaskMcp').get<number>('port', 6189);
  }

  async start(): Promise<void> {
    if (this.httpServer) {
      this.log('Server already running');
      return;
    }

    this.httpServer = http.createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve, reject) => {
      this.httpServer!.listen(this.port, '127.0.0.1', () => {
        this.log(`MCP server listening on http://127.0.0.1:${this.port}/mcp`);
        this.updateStatusBar(true);
        resolve();
      });
      this.httpServer!.on('error', (err) => {
        this.log(`Failed to start server: ${err.message}`);
        this.updateStatusBar(false);
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    // Close all active transports
    for (const [sessionId, transport] of this.transports) {
      try {
        await transport.close();
      } catch (e) {
        this.log(`Error closing transport ${sessionId}: ${e}`);
      }
    }
    this.transports.clear();

    // Close HTTP server
    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer!.close(() => {
          this.httpServer = null;
          this.log('MCP server stopped');
          this.updateStatusBar(false);
          resolve();
        });
      });
    }
  }

  async restart(): Promise<void> {
    await this.stop();
    // Re-read port in case it changed
    this.port = vscode.workspace.getConfiguration('vscodeTaskMcp').get<number>('port', 6189);
    await this.start();
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);

    // Only handle /mcp endpoint
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Route by HTTP method
    switch (req.method) {
      case 'POST':
        await this.handlePost(req, res);
        break;
      case 'GET':
        await this.handleGet(req, res);
        break;
      case 'DELETE':
        await this.handleDelete(req, res);
        break;
      default:
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
  }

  private async handlePost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Parse the request body
    const body = await this.readBody(req);
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && this.transports.has(sessionId)) {
        // Reuse existing transport
        transport = this.transports.get(sessionId)!;
      } else if (!sessionId && isInitializeRequest(parsedBody)) {
        // New initialization request — create server + transport
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            this.transports.set(newSessionId, transport);
            this.log(`Session initialized: ${newSessionId}`);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            this.transports.delete(sid);
            this.log(`Session closed: ${sid}`);
          }
        };

        const server = this.createMcpServer();
        await server.connect(transport);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null,
          }),
        );
        return;
      }

      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      this.log(`Error handling POST: ${error}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }),
        );
      }
    }
  }

  private async handleGet(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !this.transports.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid or missing session ID');
      return;
    }
    const transport = this.transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  }

  private async handleDelete(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !this.transports.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid or missing session ID');
      return;
    }
    const transport = this.transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  }

  private createMcpServer(): McpServer {
    const server = new McpServer(
      { name: 'vscode-task-mcp', version: '0.1.0' },
      { instructions: 'MCP server that exposes VS Code task definitions to AI agents for execution.' },
    );

    // --- list_tasks tool ---
    server.registerTool(
      'list_tasks',
      {
        title: 'List VS Code Tasks',
        description:
          'Lists all available VS Code tasks in the current workspace. ' +
          'Returns task labels, types, groups, and execution details. ' +
          'Use this to discover tasks before executing them.',
        inputSchema: {},
      },
      async () => {
        try {
          const tasks: TaskInfo[] = await this.taskManager.listTasks();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(tasks, null, 2) }],
          };
        } catch (error) {
          return {
            content: [
              { type: 'text' as const, text: `Error listing tasks: ${error instanceof Error ? error.message : String(error)}` },
            ],
            isError: true,
          };
        }
      },
    );

    // --- execute_task tool ---
    server.registerTool(
      'execute_task',
      {
        title: 'Execute VS Code Task',
        description:
          'Executes a VS Code task by its label. ' +
          'For shell/process tasks, captures stdout and stderr. ' +
          'For background tasks, starts execution and returns immediately. ' +
          'Use list_tasks first to see available task labels.',
        inputSchema: {
          label: z.string().describe('The exact label of the task to execute (case-sensitive).'),
          params: z.array(z.string()).optional().describe('Optional parameters to append to the task command.'),
        },
      },
      async ({ label, params }: { label: string; params?: string[] }) => {
        try {
          const result = await this.taskManager.executeTask(label, params);

          if (result.executedViaVSCode) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Task "${label}" started via VS Code (no output capture available for this task type).`,
                },
              ],
            };
          }

          const parts: string[] = [];
          if (result.stdout) parts.push(`--- stdout ---\n${result.stdout}`);
          if (result.stderr) parts.push(`--- stderr ---\n${result.stderr}`);
          parts.push(`--- exit code: ${result.exitCode} ---`);

          return {
            content: [{ type: 'text' as const, text: parts.join('\n') }],
            isError: result.exitCode !== 0,
          };
        } catch (error) {
          return {
            content: [
              { type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` },
            ],
            isError: true,
          };
        }
      },
    );

    return server;
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }

  private updateStatusBar(running: boolean): void {
    if (running) {
      this.statusBarItem.text = `$(plug) MCP :${this.port}`;
      this.statusBarItem.tooltip = `Task MCP Server running on port ${this.port}`;
      this.statusBarItem.backgroundColor = undefined;
    } else {
      this.statusBarItem.text = `$(debug-disconnect) MCP Off`;
      this.statusBarItem.tooltip = 'Task MCP Server is stopped';
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    this.statusBarItem.show();
  }
}
