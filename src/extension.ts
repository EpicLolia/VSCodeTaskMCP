import * as vscode from 'vscode';
import { McpHttpServer } from './server';

let server: McpHttpServer | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Task MCP');
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(outputChannel, statusBarItem);

  server = new McpHttpServer(outputChannel, statusBarItem);

  // Check if enabled
  const config = vscode.workspace.getConfiguration('vscodeTaskMcp');
  if (config.get<boolean>('enable', true)) {
    try {
      await server.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Task MCP: Failed to start server — ${msg}`);
    }
  }

  // Register MCP Server Definition Provider
  // This allows VS Code (and Claude Code) to auto-discover our MCP server without .mcp.json
  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider('vscode-task-mcp', {
      provideMcpServerDefinitions(_token: vscode.CancellationToken) {
        const port = vscode.workspace.getConfiguration('vscodeTaskMcp').get<number>('port', 6189);
        return [
          new vscode.McpHttpServerDefinition(
            'VS Code Task MCP',
            vscode.Uri.parse(`http://127.0.0.1:${port}/mcp`),
          ),
        ];
      },
    }),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeTaskMcp.restart', async () => {
      try {
        await server?.restart();
        vscode.window.showInformationMessage('Task MCP: Server restarted.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Task MCP: Failed to restart — ${msg}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeTaskMcp.stop', async () => {
      await server?.stop();
      vscode.window.showInformationMessage('Task MCP: Server stopped.');
    }),
  );

  // Watch for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('vscodeTaskMcp')) {
        const newConfig = vscode.workspace.getConfiguration('vscodeTaskMcp');
        const enabled = newConfig.get<boolean>('enable', true);

        if (!enabled) {
          await server?.stop();
        } else {
          await server?.restart();
        }
      }
    }),
  );
}

export async function deactivate(): Promise<void> {
  await server?.stop();
  server = null;
}
