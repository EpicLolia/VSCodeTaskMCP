import * as vscode from 'vscode';
import * as cp from 'node:child_process';
import type { TaskInfo, TaskExecutionResult } from './types';

export class TaskManager {
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  /**
   * Discover all tasks available in the current workspace.
   */
  async listTasks(): Promise<TaskInfo[]> {
    const tasks = await vscode.tasks.fetchTasks();

    return tasks.map((task) => ({
      label: task.name,
      source: task.source,
      type: task.definition.type,
      group: this.getGroupName(task.group),
      detail: task.detail,
      isBackground: task.isBackground,
      executionType: this.getExecutionType(task),
    }));
  }

  /**
   * Execute a task by label.
   *
   * Strategy:
   * 1. Find the task by label
   * 2. If ShellExecution or ProcessExecution AND not background:
   *    - Extract command, args, cwd, env from task.execution
   *    - Run via child_process.spawn() for full output capture
   * 3. If background task: execute via vscode.tasks.executeTask(), return immediately
   * 4. If CustomExecution: execute via vscode.tasks.executeTask(), no output capture
   */
  async executeTask(label: string, params?: string[]): Promise<TaskExecutionResult> {
    const tasks = await vscode.tasks.fetchTasks();
    const task = tasks.find((t) => t.name === label);

    if (!task) {
      const available = tasks.map((t) => t.name).join(', ');
      throw new Error(`Task "${label}" not found. Available tasks: ${available}`);
    }

    const execution = task.execution;

    // Background tasks or CustomExecution → delegate to VS Code
    if (task.isBackground || !execution || this.getExecutionType(task) === 'custom') {
      this.log(`Executing task "${label}" via VS Code API (background/custom)`);
      await vscode.tasks.executeTask(task);
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        executedViaVSCode: true,
      };
    }

    // ShellExecution or ProcessExecution → extract command and spawn
    const { command, args, cwd, env } = this.extractExecutionDetails(task, params);
    this.log(`Executing task "${label}": ${command} ${args.join(' ')} (cwd: ${cwd})`);

    return this.spawnAndCapture(command, args, cwd, env);
  }

  /**
   * Extract command, args, cwd, env from a task's execution definition.
   */
  private extractExecutionDetails(
    task: vscode.Task,
    extraParams?: string[],
  ): {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  } {
    const execution = task.execution!;
    let command: string;
    let args: string[] = [];
    let cwd: string | undefined;
    let env: Record<string, string> = {};

    if (execution instanceof vscode.ShellExecution) {
      if (execution.commandLine) {
        // Single command line string
        command = execution.commandLine;
        args = [];
      } else if (execution.command) {
        // Structured command + args
        command = typeof execution.command === 'string' ? execution.command : execution.command.value;
        args = (execution.args ?? []).map((a: string | vscode.ShellQuotedString) =>
          typeof a === 'string' ? a : a.value,
        );
      } else {
        throw new Error('Shell execution has no command defined');
      }
      const opts = execution.options;
      cwd = opts?.cwd;
      env = (opts?.env as Record<string, string>) ?? {};
    } else if (execution instanceof vscode.ProcessExecution) {
      command = execution.process;
      args = execution.args ?? [];
      const opts = execution.options;
      cwd = opts?.cwd;
      env = (opts?.env as Record<string, string>) ?? {};
    } else {
      throw new Error('Unsupported execution type');
    }

    // Append extra params
    if (extraParams && extraParams.length > 0) {
      args = [...args, ...extraParams];
    }

    // Resolve cwd — fall back to first workspace folder
    const resolvedCwd = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    return { command, args, cwd: resolvedCwd, env };
  }

  /**
   * Spawn a process and capture stdout/stderr.
   */
  private spawnAndCapture(
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ): Promise<TaskExecutionResult> {
    return new Promise((resolve) => {
      const child = cp.spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        shell: true,
        windowsHide: true,
      });

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      child.stdout?.on('data', (data: Buffer) => {
        stdoutChunks.push(data.toString());
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderrChunks.push(data.toString());
      });

      // Timeout: 5 minutes max for non-background tasks
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({
          exitCode: null,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join('') + '\n[Task timed out after 5 minutes]',
          executedViaVSCode: false,
        });
      }, 5 * 60 * 1000);

      child.on('close', (code: number | null) => {
        clearTimeout(timeout);
        resolve({
          exitCode: code,
          stdout: stdoutChunks.join(''),
          stderr: stderrChunks.join(''),
          executedViaVSCode: false,
        });
      });

      child.on('error', (err: Error) => {
        clearTimeout(timeout);
        resolve({
          exitCode: 1,
          stdout: '',
          stderr: err.message,
          executedViaVSCode: false,
        });
      });
    });
  }

  private getGroupName(group: vscode.TaskGroup | undefined): string | undefined {
    if (!group) return undefined;
    if (group === vscode.TaskGroup.Build) return 'build';
    if (group === vscode.TaskGroup.Test) return 'test';
    if (group === vscode.TaskGroup.Clean) return 'clean';
    if (group === vscode.TaskGroup.Rebuild) return 'rebuild';
    return undefined;
  }

  private getExecutionType(task: vscode.Task): 'shell' | 'process' | 'custom' {
    if (task.execution instanceof vscode.ShellExecution) return 'shell';
    if (task.execution instanceof vscode.ProcessExecution) return 'process';
    return 'custom';
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }
}
