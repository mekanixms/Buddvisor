/**
 * Session Schedule Tool
 * Lets agents add, edit, remove, or list scheduled jobs (cron) for the current session.
 * Jobs can run a prompt (injected into chat) or a script via workspace_exec; output goes to session chat.
 * Overlap control: task_key is unique per session; adding with an existing task_key returns an error (use edit or remove first).
 */

const { toolRegistry } = require('./ToolRegistry');
const SessionScheduledJob = require('../../models/SessionScheduledJob');
const WorkSession = require('../../models/WorkSession');
const { computeNextRunAt } = require('../scheduler/SchedulerService');
const logger = require('../../utils/logger');

function registerSessionScheduleTool() {
  toolRegistry.register({
    name: 'session_schedule',
    description: 'Add, edit, remove, or list scheduled jobs for this session. Jobs run on a cron expression or fixed interval. Two types: "prompt" (inject a message and run the chat pipeline for one or all agents) or "script" (run a command in the agent\'s workspace via workspace_exec; agents must have workspace_exec and local_working_folder). Use task_key to identify a logical job and avoid duplicates: only one job per session can have a given task_key; add with existing task_key returns an error.',
    category: 'scheduling',
    parameters: {
      action: {
        type: 'string',
        enum: ['add', 'edit', 'remove', 'list'],
        description: 'Action: add (create), edit (update by job_id or task_key), remove (delete by job_id or task_key), list (show jobs for this session)',
        required: true,
      },
      job_id: {
        type: 'integer',
        description: 'Job ID (for edit or remove when not using task_key)',
        required: false,
      },
      task_key: {
        type: 'string',
        description: 'Logical key for overlap control. For add: optional; if provided and a job with this key already exists, returns error. For edit/remove: identify job by this key instead of job_id.',
        required: false,
      },
      schedule_type: {
        type: 'string',
        enum: ['cron', 'interval'],
        description: 'Schedule type: "cron" (e.g. "0 9 * * *" for daily 9am) or "interval" (seconds between runs)',
        required: false,
      },
      schedule_value: {
        type: 'string',
        description: 'Cron expression (e.g. "0 9 * * *") or interval in seconds as string (e.g. "3600")',
        required: false,
      },
      task_type: {
        type: 'string',
        enum: ['prompt', 'script'],
        description: 'Job type: "prompt" (inject message to chat) or "script" (run command in workspace)',
        required: false,
      },
      prompt_text: {
        type: 'string',
        description: 'Message to inject as user prompt (for task_type prompt)',
        required: false,
      },
      script_path: {
        type: 'string',
        description: 'Command or path to run (e.g. "python3 ./scripts/daily.py" or "./scripts/daily.py")',
        required: false,
      },
      script_args: {
        type: 'array',
        description: 'Optional arguments for script (for task_type script). Array of strings.',
        required: false,
        items: { type: 'string' },
      },
      target_agent_ids: {
        type: 'array',
        description: 'Agent IDs to run the job for; omit or null for all agents in the session',
        required: false,
        items: { type: 'integer' },
      },
      enabled: {
        type: 'boolean',
        description: 'Whether the job is enabled (for add default true, for edit can toggle)',
        required: false,
      },
      enabled_only: {
        type: 'boolean',
        description: 'For list: if true, only return enabled jobs (default true)',
        required: false,
      },
    },
    handler: async (params, context) => {
      const {
        action,
        job_id,
        task_key,
        schedule_type,
        schedule_value,
        task_type,
        prompt_text,
        script_path,
        script_args,
        target_agent_ids,
        enabled,
        enabled_only = true,
      } = params || {};

      if (!context.sessionId) {
        throw new Error('sessionId is required in context');
      }
      if (!context.agentId) {
        throw new Error('session_schedule can only be used by an agent in a session (agentId required)');
      }

      const sessionId = context.sessionId;
      const agentId = context.agentId;

      const agents = await WorkSession.getAgents(sessionId);
      const agentIds = (agents || []).map((a) => a.id);
      if (!agentIds.includes(agentId)) {
        return { success: false, error: 'Calling agent is not in this session' };
      }

      const now = new Date().toISOString();

      switch (action) {
        case 'list': {
          const jobs = await SessionScheduledJob.findBySessionId(sessionId, !!enabled_only);
          return {
            success: true,
            jobs: jobs.map((j) => ({
              id: j.id,
              task_key: j.task_key,
              schedule_type: j.schedule_type,
              schedule_value: j.schedule_value,
              task_type: j.task_type,
              next_run_at: j.next_run_at,
              last_run_at: j.last_run_at,
              enabled: !!j.enabled,
              target_agent_ids: j.target_agent_ids,
            })),
            count: jobs.length,
          };
        }

        case 'remove': {
          const toRemove = job_id != null
            ? await SessionScheduledJob.findById(job_id)
            : (task_key ? await SessionScheduledJob.findBySessionAndTaskKey(sessionId, task_key) : null);
          if (!toRemove || toRemove.session_id !== sessionId) {
            return { success: false, error: 'Job not found (invalid job_id or task_key for this session)' };
          }
          await SessionScheduledJob.delete(toRemove.id);
          return { success: true, message: `Job ${toRemove.id} (task_key: ${toRemove.task_key || '—'}) removed` };
        }

        case 'edit': {
          const toEdit = job_id != null
            ? await SessionScheduledJob.findById(job_id)
            : (task_key ? await SessionScheduledJob.findBySessionAndTaskKey(sessionId, task_key) : null);
          if (!toEdit || toEdit.session_id !== sessionId) {
            return { success: false, error: 'Job not found (invalid job_id or task_key for this session)' };
          }
          const updates = {};
          if (schedule_type !== undefined) updates.schedule_type = schedule_type;
          if (schedule_value !== undefined) updates.schedule_value = schedule_value;
          if (task_type !== undefined) updates.task_type = task_type;
          if (prompt_text !== undefined) updates.prompt_text = prompt_text;
          if (script_path !== undefined) updates.script_path = script_path;
          if (script_args !== undefined) updates.script_args = script_args;
          if (target_agent_ids !== undefined) updates.target_agent_ids = target_agent_ids;
          if (enabled !== undefined) updates.enabled = enabled;
          if (Object.keys(updates).length === 0) {
            return { success: true, job_id: toEdit.id, message: 'No fields to update' };
          }
          const scheduleChanged = updates.schedule_type !== undefined || updates.schedule_value !== undefined;
          if (scheduleChanged) {
            updates.next_run_at = computeNextRunAt({ ...toEdit, ...updates }, now);
          }
          await SessionScheduledJob.update(toEdit.id, updates);
          const updated = await SessionScheduledJob.findById(toEdit.id);
          return {
            success: true,
            job_id: updated.id,
            task_key: updated.task_key,
            next_run_at: updated.next_run_at,
            message: `Job ${updated.id} updated`,
          };
        }

        case 'add': {
          if (!schedule_type || !schedule_value || !task_type) {
            return {
              success: false,
              error: 'add requires schedule_type, schedule_value, and task_type',
            };
          }
          if (task_type === 'prompt' && (prompt_text == null || String(prompt_text).trim() === '')) {
            return { success: false, error: 'prompt_text is required for task_type "prompt"' };
          }
          if (task_type === 'script' && (script_path == null || String(script_path).trim() === '')) {
            return { success: false, error: 'script_path is required for task_type "script"' };
          }

          if (task_key && String(task_key).trim() !== '') {
            const existing = await SessionScheduledJob.findBySessionAndTaskKey(sessionId, task_key.trim());
            if (existing) {
              return {
                success: false,
                error: `A job with task_key "${task_key}" already exists in this session (id: ${existing.id}). Use edit or remove first.`,
              };
            }
          }

          let nextRunAt;
          try {
            nextRunAt = computeNextRunAt(
              { schedule_type, schedule_value, last_run_at: null, created_at: null },
              now
            );
          } catch (err) {
            return { success: false, error: `Invalid schedule: ${err.message || String(err)}` };
          }

          const job = await SessionScheduledJob.create({
            session_id: sessionId,
            created_by_agent_id: agentId,
            task_key: task_key && String(task_key).trim() !== '' ? task_key.trim() : null,
            schedule_type,
            schedule_value: String(schedule_value),
            task_type,
            prompt_text: task_type === 'prompt' ? (prompt_text || '').trim() : null,
            script_path: task_type === 'script' ? (script_path || '').trim() : null,
            script_args: task_type === 'script' && Array.isArray(script_args) ? script_args : null,
            target_agent_ids: target_agent_ids && Array.isArray(target_agent_ids) ? target_agent_ids : null,
            enabled: enabled !== false ? 1 : 0,
            next_run_at: nextRunAt,
          });

          return {
            success: true,
            job_id: job.id,
            task_key: job.task_key,
            next_run_at: job.next_run_at,
            message: `Scheduled job ${job.id} created; next run at ${job.next_run_at}`,
          };
        }

        default:
          return { success: false, error: `Unknown action: ${action}` };
      }
    },
  });

  logger.info('Session schedule tool registered');
}

module.exports = { registerSessionScheduleTool };
