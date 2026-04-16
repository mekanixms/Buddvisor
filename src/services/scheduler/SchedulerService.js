/**
 * Scheduler Service
 * Runs due session_scheduled_jobs: prompt injection or script execution, then updates next_run_at.
 */

const cronParser = require('cron-parser');
const SessionScheduledJob = require('../../models/SessionScheduledJob');
const WorkSession = require('../../models/WorkSession');
const Message = require('../../models/Message');
const { ChatService } = require('../chat/ChatService');
const { toolExecutor } = require('../tools/ToolExecutor');
const logger = require('../../utils/logger');

/**
 * Compute next run time from job schedule
 * @param {object} job - Parsed SessionScheduledJob
 * @param {string} [afterIso] - After this time (default: now)
 * @returns {string} - ISO datetime for next_run_at
 */
function computeNextRunAt(job, afterIso = null) {
  const after = afterIso ? new Date(afterIso) : new Date();

  if (job.schedule_type === 'interval') {
    const seconds = parseInt(job.schedule_value, 10) || 60;
    const from = job.last_run_at ? new Date(job.last_run_at) : (job.created_at ? new Date(job.created_at) : after);
    const next = new Date(from.getTime() + seconds * 1000);
    return next.toISOString();
  }

  if (job.schedule_type === 'cron') {
    try {
      const interval = cronParser.parseExpression(job.schedule_value, { currentDate: after });
      const next = interval.next().toDate();
      return next.toISOString();
    } catch (err) {
      logger.warn(`SchedulerService: invalid cron "${job.schedule_value}" for job ${job.id}, defaulting to 1h`);
      const next = new Date(after.getTime() + 60 * 60 * 1000);
      return next.toISOString();
    }
  }

  const next = new Date(after.getTime() + 60 * 60 * 1000);
  return next.toISOString();
}

/**
 * Build shell command from script_path and script_args (safe quoting)
 */
function buildScriptCommand(scriptPath, scriptArgs) {
  const path = (scriptPath || '').trim() || './script';
  if (!scriptArgs || !Array.isArray(scriptArgs) || scriptArgs.length === 0) {
    return path;
  }
  const args = scriptArgs.map((a) => {
    const s = String(a);
    if (s.includes(' ') || s.includes('"') || s.includes("'")) {
      return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return s;
  });
  return `${path} ${args.join(' ')}`;
}

class SchedulerService {
  constructor() {
    this.isRunning = false;
    this.pollingInterval = null;
    this.pollIntervalMs = 60 * 1000; // 1 minute
    this.running = false; // guard for runDueJobs
  }

  start() {
    if (this.isRunning) {
      logger.warn('SchedulerService already running');
      return;
    }
    this.isRunning = true;
    logger.info('SchedulerService started');

    this.pollingInterval = setInterval(() => {
      this.runDueJobs();
    }, this.pollIntervalMs);

    this.runDueJobs();
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    logger.info('SchedulerService stopped');
  }

  /**
   * Run all due jobs (single-threaded, no re-entrancy)
   */
  async runDueJobs() {
    if (this.running) return;
    this.running = true;
    const now = new Date().toISOString();

    try {
      const jobs = await SessionScheduledJob.findDue(50, now);
      for (const job of jobs) {
        try {
          await this.runJob(job, now);
        } catch (err) {
          logger.error(`SchedulerService job ${job.id} failed:`, err);
          await SessionScheduledJob.update(job.id, {
            last_run_at: now,
            last_run_result: { error: err.message || String(err) },
            next_run_at: computeNextRunAt(job, now),
          });
        }
      }
    } catch (error) {
      logger.error('SchedulerService runDueJobs error:', error);
    } finally {
      this.running = false;
    }
  }

  /**
   * Execute a single job and update next_run_at
   */
  async runJob(job, nowIso) {
    const session = await WorkSession.findById(job.session_id);
    if (!session) {
      logger.warn(`SchedulerService: session ${job.session_id} not found, skipping job ${job.id}`);
      await SessionScheduledJob.update(job.id, { next_run_at: computeNextRunAt(job, nowIso) });
      return;
    }

    const agents = await WorkSession.getAgents(job.session_id);
    if (!agents || agents.length === 0) {
      logger.warn(`SchedulerService: no agents in session ${job.session_id}, skipping job ${job.id}`);
      await SessionScheduledJob.update(job.id, { next_run_at: computeNextRunAt(job, nowIso) });
      return;
    }

    const userId = session.user_id;
    const sessionId = job.session_id;
    let targetAgentIds = job.target_agent_ids;
    if (targetAgentIds != null && !Array.isArray(targetAgentIds)) {
      targetAgentIds = null;
    }
    const targetAgents = targetAgentIds && targetAgentIds.length > 0
      ? agents.filter((a) => targetAgentIds.includes(a.id))
      : agents;

    if (job.task_type === 'prompt') {
      const promptText = job.prompt_text || '[Scheduled prompt]';
      await ChatService.processMessage(sessionId, userId, promptText, {
        stream: false,
        directAgentIds: targetAgents.map((a) => a.id),
      });
      await SessionScheduledJob.update(job.id, {
        last_run_at: nowIso,
        last_run_result: { ok: true, type: 'prompt' },
        next_run_at: computeNextRunAt({ ...job, last_run_at: nowIso }, nowIso),
      });
      return;
    }

    if (job.task_type === 'script') {
      const agentsWithWorkspace = [];
      for (const agent of targetAgents) {
        const names = await WorkSession.getToolNamesBySessionAndAgent(sessionId, agent.id);
        if (names && names.includes('workspace_exec') && names.includes('local_working_folder')) {
          agentsWithWorkspace.push(agent);
        }
      }
      if (agentsWithWorkspace.length === 0) {
        const errMsg = `No target agent has workspace_exec and local_working_folder; cannot run script job ${job.id}`;
        logger.warn(`SchedulerService: ${errMsg}`);
        await SessionScheduledJob.update(job.id, {
          last_run_at: nowIso,
          last_run_result: { error: errMsg },
          next_run_at: computeNextRunAt({ ...job, last_run_at: nowIso }, nowIso),
        });
        return;
      }

      const command = buildScriptCommand(job.script_path, job.script_args);
      const outputs = [];

      for (const agent of agentsWithWorkspace) {
        try {
          const result = await toolExecutor.execute(
            'workspace_exec',
            { command, timeout_ms: 60000, capture_output: true },
            { userId, sessionId, agentId: agent.id }
          );
          const out = result.result || {};
          const line = `**${agent.name}**: exit ${out.exit_code ?? '?'}\n${out.stdout ? `stdout: ${out.stdout}\n` : ''}${out.stderr ? `stderr: ${out.stderr}` : ''}`;
          outputs.push(line);
          await Message.create({
            session_id: sessionId,
            role: 'assistant',
            content: `Scheduled script (${agent.name}):\n${(out.stdout || '').trim() || '(no output)'}${out.stderr ? `\nstderr: ${out.stderr}` : ''}`,
            agent_id: agent.id,
            agent_name: agent.name,
            metadata: { scheduled_job_id: job.id, exit_code: out.exit_code },
          });
        } catch (err) {
          const errLine = `**${agent.name}**: error - ${err.message || String(err)}`;
          outputs.push(errLine);
          await Message.create({
            session_id: sessionId,
            role: 'assistant',
            content: `Scheduled script failed (${agent.name}): ${err.message || String(err)}`,
            agent_id: agent.id,
            agent_name: agent.name,
            metadata: { scheduled_job_id: job.id, error: true },
          });
        }
      }

      await SessionScheduledJob.update(job.id, {
        last_run_at: nowIso,
        last_run_result: { ok: true, type: 'script', outputs },
        next_run_at: computeNextRunAt({ ...job, last_run_at: nowIso }, nowIso),
      });
    }
  }
}

const schedulerService = new SchedulerService();

module.exports = {
  SchedulerService,
  schedulerService,
  computeNextRunAt,
  buildScriptCommand,
};
