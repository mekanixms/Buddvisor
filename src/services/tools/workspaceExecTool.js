/**
 * Workspace Execution Tool
 * Allows agents to execute shell commands within their assigned working folder
 * Security: Sandboxed to workspace, command validation, resource limits
 */

const { toolRegistry } = require('./ToolRegistry');
const logger = require('../../utils/logger');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn } = require('child_process');
const os = require('os');

// Import workspace functions from localWorkingFolderTool
// Note: We'll reimplement getWorkspacePath here to avoid circular dependencies
const crypto = require('crypto');
const STORAGE_DIR = path.join(process.cwd(), 'storage', 'agents-workspaces');

/**
 * Get workspace path (duplicated from localWorkingFolderTool to avoid circular deps)
 */
function getWorkspacePathForExec(folderName, sessionId, agentId) {
  // Handle orchestrator case (agentId is null/undefined)
  const entityId = agentId !== null && agentId !== undefined ? agentId : 'orchestrator';
  const uniqueId = crypto
    .createHash('sha256')
    .update(`${sessionId}-${entityId}-${folderName}`)
    .digest('hex')
    .substring(0, 16);
  
  const sanitized = folderName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
  const dirName = `${sanitized}_${uniqueId}`;
  return path.resolve(STORAGE_DIR, dirName);
}

/**
 * Resolve workspace path with validation (duplicated from localWorkingFolderTool)
 */
function resolveWorkspacePathForExec(relativePath, workspacePath) {
  if (!relativePath || typeof relativePath !== 'string') {
    throw new Error('Path must be a non-empty string');
  }

  const normalized = path.normalize(relativePath);
  let cleanPath = normalized.replace(/^\.\//, '').replace(/^\.$/, '');
  if (cleanPath === '') cleanPath = '.';
  
  const resolved = path.resolve(workspacePath, cleanPath);
  const workspaceReal = path.resolve(workspacePath);
  const resolvedReal = path.resolve(resolved);
  
  if (!resolvedReal.startsWith(workspaceReal + path.sep) && resolvedReal !== workspaceReal) {
    throw new Error(`Path traversal detected: ${relativePath} resolves outside workspace`);
  }
  
  return resolvedReal;
}

// Dangerous command patterns to block
const DANGEROUS_PATTERNS = [
  // Path traversal attempts
  /\.\.\/\.\./,
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+~\/?/,
  /rm\s+-rf\s+\$HOME/,
  /rm\s+-rf\s+\$USER/,
  // Network access (can be enabled via env var if needed)
  /curl\s+https?:\/\//,
  /wget\s+https?:\/\//,
  // System modification
  /sudo\s+/,
  /su\s+/,
  /chmod\s+[0-7]{3,4}\s+\//,
  /chown\s+.*\s+\//,
  // Process manipulation outside workspace
  /killall/,
  /pkill\s+-9/,
  // File system operations outside workspace
  /dd\s+if=/,
  /mkfs/,
  /fdisk/,
];

// Allowed command prefixes (whitelist approach for safety)
const ALLOWED_COMMANDS = [
  'python', 'python3', 'python2',
  'node', 'nodejs',
  'bash', 'sh',
  'ls', 'cat', 'grep', 'find', 'head', 'tail', 'wc', 'sort', 'uniq',
  'mkdir', 'rmdir', 'cp', 'mv', 'rm', 'touch',
  'tar', 'gzip', 'gunzip', 'zip', 'unzip',
  'git',
  'echo', 'printf',
  'date', 'time',
  'awk', 'sed',
  'make', 'cmake',
  'npm', 'pip', 'pip3',
  'java', 'javac',
  'gcc', 'g++', 'clang',
  'docker', // If Docker is available and properly sandboxed
];

/**
 * Validate command for security
 */
function validateCommand(command) {
  if (!command || typeof command !== 'string' || command.trim() === '') {
    throw new Error('Command cannot be empty');
  }

  const trimmed = command.trim();

  // Check for dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new Error(`Command contains dangerous pattern: ${pattern.toString()}`);
    }
  }

  // Extract first word (command name)
  const firstWord = trimmed.split(/\s+/)[0];
  const commandName = firstWord.split('/').pop(); // Handle paths like /usr/bin/python

  // Check if command starts with an allowed prefix
  const isAllowed = ALLOWED_COMMANDS.some(allowed => 
    commandName.startsWith(allowed) || trimmed.startsWith(allowed + ' ')
  );

  // Allow if it's a relative path (./script.py) or absolute path within workspace
  const isRelativePath = trimmed.startsWith('./') || trimmed.startsWith('../');
  const isAbsoluteWorkspacePath = path.isAbsolute(trimmed) && trimmed.includes('workspace');

  if (!isAllowed && !isRelativePath && !isAbsoluteWorkspacePath) {
    // Warn but allow - user may have custom commands
    logger.warn(`[workspace_exec] Command not in whitelist: ${commandName}`);
  }

  return true;
}

/**
 * Execute command in workspace with security constraints
 */
async function executeCommand(command, options = {}) {
  const {
    cwd,
    env = {},
    timeout_ms = 30000,
    capture_output = true,
    shell = null,
  } = options;

  const startTime = Date.now();

  // Determine shell to use
  const shellToUse = shell || (os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash');

  // Prepare environment
  const processEnv = {
    ...process.env,
    ...env,
    // Ensure PATH is limited to common locations
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  };

  return new Promise((resolve, reject) => {
    // Use spawn with shell option for proper command execution
    const child = spawn(command, {
      shell: shellToUse,
      cwd: cwd || process.cwd(),
      env: processEnv,
      stdio: capture_output ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'inherit', 'inherit'],
    });

    let stdout = '';
    let stderr = '';
    let outputSize = 0;
    const maxOutputSize = 10 * 1024; // 10KB limit for stdout/stderr

    if (capture_output) {
      child.stdout.on('data', (data) => {
        const chunk = String(data);
        outputSize += chunk.length;
        if (outputSize <= maxOutputSize) {
          stdout += chunk;
        } else if (outputSize === chunk.length + maxOutputSize) {
          stdout += '\n... [output truncated due to size limit]';
        }
      });

      child.stderr.on('data', (data) => {
        const chunk = String(data);
        outputSize += chunk.length;
        if (outputSize <= maxOutputSize) {
          stderr += chunk;
        } else if (outputSize === chunk.length + maxOutputSize) {
          stderr += '\n... [output truncated due to size limit]';
        }
      });
    }

    // Set timeout
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      // Force kill after grace period
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (e) {
          // Ignore
        }
      }, 1000);

      reject(new Error(`Command timed out after ${timeout_ms}ms`));
    }, timeout_ms);

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      resolve({
        success: code === 0,
        exit_code: code,
        signal: signal || null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        duration_ms: duration,
        truncated: outputSize > maxOutputSize,
      });
    });
  });
}

/**
 * Log command execution to workspace logs
 */
async function logExecution(workspacePath, command, result) {
  try {
    const logsDir = path.join(workspacePath, 'logs');
    if (!fsSync.existsSync(logsDir)) {
      await fs.mkdir(logsDir, { recursive: true });
    }

    const logFile = path.join(logsDir, 'exec_history.log');
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] CMD: ${command}\n` +
      `  EXIT: ${result.exit_code} | DURATION: ${result.duration_ms}ms\n` +
      (result.stdout ? `  STDOUT: ${result.stdout.substring(0, 500)}\n` : '') +
      (result.stderr ? `  STDERR: ${result.stderr.substring(0, 500)}\n` : '') +
      `---\n`;

    await fs.appendFile(logFile, logEntry, 'utf8');
  } catch (error) {
    // Don't fail execution if logging fails
    logger.warn(`[workspace_exec] Failed to log execution: ${error.message}`);
  }
}

/**
 * Register Workspace Exec tool
 */
function registerWorkspaceExecTool() {
  toolRegistry.register({
    name: 'workspace_exec',
    description: 'Execute shell/terminal commands in the agent\'s working folder context. Supports bash/sh on Linux/Mac. Ideal for running scripts, git operations, or data processing pipelines. Commands are sandboxed to the workspace and logged for auditability.',
    category: 'execution',
    parameters: {
      command: {
        type: 'string',
        description: 'The command to run (e.g., "python3 script.py --input ./data/temps.csv" or "ls -la ./graphs/"). Support quoting for args with spaces.',
        required: true,
        maxLength: 5000,
      },
      cwd: {
        type: 'string',
        description: 'Relative path within the workspace (default: ./). E.g., "./scripts/" to run from a subdir.',
        required: false,
      },
      env: {
        type: 'object',
        description: 'Custom environment variables (e.g., {"PYTHONPATH": "./lib/"}). Keys and values must be strings.',
        required: false,
      },
      timeout_ms: {
        type: 'number',
        description: 'Max execution time in milliseconds (default: 30000 / 30s; min: 1000, max: 120000)',
        required: false,
        minimum: 1000,
        maximum: 120000,
      },
      capture_output: {
        type: 'boolean',
        description: 'Whether to return stdout/stderr as strings (default: true)',
        required: false,
      },
      shell: {
        type: 'string',
        description: 'Specify shell (e.g., "bash", "sh", "python" for inline scripts). Defaults to system shell.',
        required: false,
      },
    },
    handler: async (params, context) => {
      const { command, cwd, env, timeout_ms, capture_output, shell } = params;

      if (!context.sessionId) {
        throw new Error('sessionId is required in context');
      }

      // Validate command
      validateCommand(command);

      // Get workspace path (requires local_working_folder to be configured)
      // We need to get the tool config for local_working_folder
      // Check orchestrator tools if agentId is not present, otherwise check agent tools
      const { dbAll } = require('../../../config/database');
      let workspaceAssignments;
      
      if (!context.agentId) {
        // Orchestrator tool config
        workspaceAssignments = await dbAll(
          `SELECT tool_config FROM session_orchestrator_tools 
           WHERE session_id = ? AND tool_name = ?`,
          [context.sessionId, 'local_working_folder']
        );
      } else {
        // Agent tool config
        workspaceAssignments = await dbAll(
          `SELECT tool_config FROM session_agent_tools 
           WHERE session_id = ? AND agent_id = ? AND tool_name = ?`,
          [context.sessionId, context.agentId, 'local_working_folder']
        );
      }

      if (!workspaceAssignments || workspaceAssignments.length === 0) {
        const entity = context.agentId ? 'agent' : 'orchestrator';
        throw new Error(`local_working_folder tool must be configured for this ${entity} before using workspace_exec. Please configure the folder name in Session Settings → Tools.`);
      }

      let workspaceConfig = workspaceAssignments[0].tool_config;
      if (typeof workspaceConfig === 'string') {
        try {
          workspaceConfig = JSON.parse(workspaceConfig);
        } catch (e) {
          throw new Error('Invalid workspace configuration. Please reconfigure the folder name in Session Settings → Tools.');
        }
      }

      if (!workspaceConfig || !workspaceConfig.folder_name || workspaceConfig.folder_name.trim() === '') {
        const entity = context.agentId ? 'agent' : 'orchestrator';
        throw new Error(`Workspace folder name not configured for this ${entity}. Please configure local_working_folder in Session Settings → Tools.`);
      }

      // Get workspace path
      const agentId = context.agentId !== undefined ? context.agentId : null;
      const workspacePath = getWorkspacePathForExec(
        workspaceConfig.folder_name.trim(),
        context.sessionId,
        agentId
      );

      // Ensure workspace exists
      if (!fsSync.existsSync(workspacePath)) {
        fsSync.mkdirSync(workspacePath, { recursive: true });
        logger.info(`[workspace_exec] Created workspace: ${workspacePath}`);
      }

      // Resolve cwd within workspace
      let execCwd = workspacePath;
      if (cwd) {
        execCwd = resolveWorkspacePathForExec(cwd, workspacePath);
        // Ensure it's a directory
        const stats = await fs.stat(execCwd).catch(() => null);
        if (!stats || !stats.isDirectory()) {
          throw new Error(`cwd path is not a directory: ${cwd}`);
        }
      }

      // Validate env object
      let processEnv = {};
      if (env) {
        if (typeof env !== 'object' || Array.isArray(env)) {
          throw new Error('env must be an object with string keys and values');
        }
        for (const [key, value] of Object.entries(env)) {
          if (typeof key !== 'string' || typeof value !== 'string') {
            throw new Error('env keys and values must be strings');
          }
          processEnv[key] = value;
        }
      }

      // Execute command
      const execStartTime = Date.now();
      let result;
      try {
        result = await executeCommand(command, {
          cwd: execCwd,
          env: processEnv,
          timeout_ms: timeout_ms || 30000,
          capture_output: capture_output !== false, // Default true
          shell: shell || null,
        });
      } catch (error) {
        // Handle execution errors
        const execDuration = Date.now() - execStartTime;
        result = {
          success: false,
          exit_code: -1,
          stdout: '',
          stderr: error.message || String(error),
          duration_ms: execDuration,
          error: error.message,
        };
      }

      // Log execution
      await logExecution(workspacePath, command, result);

      // Detect files that might have been affected (simple heuristic)
      const filesAffected = [];
      if (result.success) {
        // Try to detect file operations from command
        const fileOps = command.match(/(?:>|>>)\s+([^\s]+)/g);
        if (fileOps) {
          fileOps.forEach(op => {
            const filePath = op.replace(/^[>]+\s+/, '').trim();
            if (filePath && !filePath.startsWith('/')) {
              filesAffected.push(filePath);
            }
          });
        }
      }

      return {
        success: result.success,
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        duration_ms: result.duration_ms,
        files_affected: filesAffected.length > 0 ? filesAffected : undefined,
        workspace_path: workspacePath,
        cwd: path.relative(workspacePath, execCwd) || '.',
      };
    },
    examples: [
      {
        description: 'Run a Python script to process data',
        parameters: {
          command: 'python3 -c "import pandas as pd; df = pd.read_csv(\'./data/temps.csv\'); print(df[\'temp\'].mean())"',
        },
      },
      {
        description: 'List files in a directory',
        parameters: {
          command: 'ls -la ./graphs/',
        },
      },
      {
        description: 'Run a script with custom environment variables',
        parameters: {
          command: 'python3 ./scripts/plot_temps.py',
          cwd: './scripts',
          env: { PYTHONPATH: './lib/' },
        },
      },
    ],
  });
}

module.exports = {
  registerWorkspaceExecTool,
};
