/**
 * Represents a discovered VS Code task for MCP consumers.
 */
export interface TaskInfo {
  /** Human-readable task label (unique within a workspace folder) */
  label: string;
  /** Where the task comes from: "Workspace", extension name, etc. */
  source: string;
  /** Task type: "shell", "process", "npm", "typescript", etc. */
  type: string;
  /** Task group: "build", "test", "clean", "rebuild", or undefined */
  group: string | undefined;
  /** Additional description from task definition */
  detail: string | undefined;
  /** Whether the task runs in the background (watch mode) */
  isBackground: boolean;
  /** Execution kind: "shell", "process", "custom" */
  executionType: 'shell' | 'process' | 'custom';
}

/**
 * Result from executing a task.
 */
export interface TaskExecutionResult {
  /** Exit code (null if the process was killed or for background tasks) */
  exitCode: number | null;
  /** Combined stdout output */
  stdout: string;
  /** Combined stderr output */
  stderr: string;
  /** Whether the task was executed via VS Code API (no output capture) */
  executedViaVSCode: boolean;
}
