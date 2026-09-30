/**
 * Agent Documents Tool (orchestrator only)
 * Lets the orchestrator assign documents to, or remove them from, the session's agents,
 * exactly like Configure Session → Documents does. Documents can be given as names or
 * wildcard patterns (e.g. "report.*", "*.pdf"); agents by name (with or without "@") or id.
 */

const { toolRegistry } = require('./ToolRegistry');
const WorkSession = require('../../models/WorkSession');
const Document = require('../../models/Document');
const logger = require('../../utils/logger');

const MAX_LIST_LIBRARY = 100;

function stripDecorations(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

function hasWildcard(pattern) {
  return /[*?]/.test(pattern);
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

function stripExtension(filename) {
  const idx = filename.lastIndexOf('.');
  return idx > 0 ? filename.slice(0, idx) : filename;
}

/**
 * Resolve one user-supplied document reference against a list of candidate documents.
 * Wildcards match every document; plain names match exact filename, then filename without
 * extension, then a substring (the last two only when unambiguous).
 * @returns {{matches: object[], ambiguous: boolean}}
 */
function matchDocuments(rawPattern, docs) {
  const pattern = stripDecorations(rawPattern);
  if (!pattern) return { matches: [], ambiguous: false };

  if (hasWildcard(pattern)) {
    const re = globToRegExp(pattern);
    return { matches: docs.filter((d) => re.test(d.filename || '')), ambiguous: false };
  }

  const lower = pattern.toLowerCase();
  const exact = docs.filter((d) => String(d.filename || '').toLowerCase() === lower);
  if (exact.length > 0) return { matches: exact, ambiguous: false };

  const byStem = docs.filter((d) => stripExtension(String(d.filename || '')).toLowerCase() === lower);
  if (byStem.length === 1) return { matches: byStem, ambiguous: false };
  if (byStem.length > 1) return { matches: byStem, ambiguous: true };

  const contains = docs.filter((d) => String(d.filename || '').toLowerCase().includes(lower));
  if (contains.length === 1) return { matches: contains, ambiguous: false };
  return { matches: contains, ambiguous: contains.length > 1 };
}

function normalizeAgentName(value) {
  return stripDecorations(value).replace(/^@+/, '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

/**
 * Resolve an agent reference ("@Tax Advisor", "tax advisor", "12") against the session agents.
 * @returns {{agent: object|null, ambiguous: object[]}}
 */
function resolveAgent(rawRef, agents) {
  const ref = stripDecorations(rawRef).replace(/^@+/, '').trim();
  if (!ref) return { agent: null, ambiguous: [] };

  const name = normalizeAgentName(ref);
  const exact = agents.filter((a) => normalizeAgentName(a.name) === name);
  if (exact.length === 1) return { agent: exact[0], ambiguous: [] };
  if (exact.length > 1) return { agent: null, ambiguous: exact };

  if (/^\d+$/.test(ref)) {
    const byId = agents.find((a) => a.id === parseInt(ref, 10));
    if (byId) return { agent: byId, ambiguous: [] };
  }

  const partial = agents.filter((a) => normalizeAgentName(a.name).includes(name));
  if (partial.length === 1) return { agent: partial[0], ambiguous: [] };
  return { agent: null, ambiguous: partial };
}

function docSummary(doc) {
  return { id: doc.id, filename: doc.filename };
}

function toStringList(value) {
  if (Array.isArray(value)) return value.map((v) => stripDecorations(v)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [stripDecorations(value)];
  return [];
}

async function refreshWorkspaces(sessionId, agentIds) {
  try {
    const { syncAssignedDocumentsToWorkspace } = require('./localWorkingFolderTool');
    for (const agentId of agentIds) {
      await syncAssignedDocumentsToWorkspace(sessionId, agentId);
    }
  } catch (err) {
    logger.warn(`agent_documents: could not refresh assigned_documents links: ${err.message}`);
  }
}

async function runList({ sessionId, userId, agents, documents }) {
  const assignmentsByAgent = new Map();
  for (const agent of agents) {
    const docs = await Document.getBySessionAndAgent(sessionId, agent.id);
    assignmentsByAgent.set(agent.id, docs);
  }

  const library = await Document.findByUserId(userId, { orderBy: 'filename', order: 'ASC' });
  let filtered = library;
  if (documents.length > 0) {
    const seen = new Set();
    filtered = [];
    for (const pattern of documents) {
      for (const doc of matchDocuments(pattern, library).matches) {
        if (!seen.has(doc.id)) {
          seen.add(doc.id);
          filtered.push(doc);
        }
      }
    }
  }

  const sessionDocIds = new Set((await Document.getBySession(sessionId)).map((d) => d.id));
  const agentNamesByDoc = new Map();
  for (const agent of agents) {
    for (const doc of assignmentsByAgent.get(agent.id) || []) {
      if (!agentNamesByDoc.has(doc.id)) agentNamesByDoc.set(doc.id, []);
      agentNamesByDoc.get(doc.id).push(agent.name);
    }
  }

  return {
    success: true,
    action: 'list',
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      documents: (assignmentsByAgent.get(a.id) || []).map(docSummary),
    })),
    library_total: filtered.length,
    library: filtered.slice(0, MAX_LIST_LIBRARY).map((d) => ({
      id: d.id,
      filename: d.filename,
      file_type: d.file_type,
      in_session: sessionDocIds.has(d.id),
      assigned_to: agentNamesByDoc.get(d.id) || [],
    })),
    truncated: filtered.length > MAX_LIST_LIBRARY,
  };
}

async function runChange({ action, sessionId, userId, agents, documents, documentIds, agentRefs }) {
  const isAssign = action === 'assign';

  if (agentRefs.length === 0) {
    return { success: false, error: 'At least one agent is required (name or id).' };
  }
  if (documents.length === 0 && documentIds.length === 0) {
    return { success: false, error: 'At least one document name/pattern (documents) or document id (document_ids) is required.' };
  }

  const targetAgents = [];
  const unmatchedAgents = [];
  const ambiguousAgents = [];
  for (const ref of agentRefs) {
    const { agent, ambiguous } = resolveAgent(ref, agents);
    if (agent) {
      if (!targetAgents.some((a) => a.id === agent.id)) targetAgents.push(agent);
    } else if (ambiguous.length > 0) {
      ambiguousAgents.push({ agent: ref, candidates: ambiguous.map((a) => `${a.name} (id ${a.id})`) });
    } else {
      unmatchedAgents.push(ref);
    }
  }

  const availableAgents = agents.map((a) => `${a.name} (id ${a.id})`);
  if (targetAgents.length === 0) {
    return {
      success: false,
      error: 'No matching agent in this session.',
      unmatched_agents: unmatchedAgents,
      ambiguous_agents: ambiguousAgents,
      available_agents: availableAgents,
    };
  }

  const hadPerAgentAssignments = await Document.hasAgentAssignments(sessionId);

  // Assign: search the user's whole library. Remove: search what each agent currently has.
  const library = isAssign ? await Document.findByUserId(userId) : null;
  const perAgentDocs = new Map();
  if (!isAssign) {
    for (const agent of targetAgents) {
      perAgentDocs.set(agent.id, await Document.getBySessionAndAgent(sessionId, agent.id));
    }
  }

  const ambiguousDocuments = [];
  const perAgentResults = [];
  // A reference only counts as unmatched when it matched nothing for any target agent
  let unmatchedEverywhere = null;

  const resolveFor = (candidates) => {
    const resolved = new Map();
    const unmatched = new Set();
    for (const pattern of documents) {
      const { matches, ambiguous } = matchDocuments(pattern, candidates);
      if (matches.length === 0) {
        unmatched.add(pattern);
      } else if (ambiguous) {
        if (!ambiguousDocuments.some((a) => a.document === pattern)) {
          ambiguousDocuments.push({ document: pattern, candidates: matches.map((d) => d.filename) });
        }
      } else {
        matches.forEach((d) => resolved.set(d.id, d));
      }
    }
    for (const id of documentIds) {
      const doc = candidates.find((d) => d.id === id);
      if (doc) resolved.set(doc.id, doc);
      else unmatched.add(`id ${id}`);
    }
    unmatchedEverywhere = unmatchedEverywhere === null
      ? unmatched
      : new Set([...unmatchedEverywhere].filter((p) => unmatched.has(p)));
    return resolved;
  };

  const libraryResolved = isAssign ? resolveFor(library) : null;

  for (const agent of targetAgents) {
    const resolved = isAssign ? libraryResolved : resolveFor(perAgentDocs.get(agent.id) || []);
    const changed = [];
    const unchanged = [];

    for (const doc of resolved.values()) {
      if (isAssign) {
        const created = await WorkSession.addDocumentAgentAssignment(sessionId, agent.id, doc.id);
        // Agent documents must also belong to the session, as when saving Configure Session → Documents
        await WorkSession.assignDocument(sessionId, doc.id);
        (created ? changed : unchanged).push(docSummary(doc));
      } else {
        const removed = await WorkSession.removeDocumentAgentAssignment(sessionId, agent.id, doc.id);
        (removed ? changed : unchanged).push(docSummary(doc));
      }
    }

    perAgentResults.push({
      agent_id: agent.id,
      agent_name: agent.name,
      [isAssign ? 'assigned' : 'removed']: changed,
      [isAssign ? 'already_assigned' : 'not_assigned']: unchanged,
    });
  }

  const unmatchedDocuments = unmatchedEverywhere || new Set();
  const totalChanged = perAgentResults.reduce(
    (n, r) => n + (isAssign ? r.assigned.length : r.removed.length), 0
  );
  const totalUnchanged = perAgentResults.reduce(
    (n, r) => n + (isAssign ? r.already_assigned.length : r.not_assigned.length), 0
  );

  if (totalChanged > 0) {
    await refreshWorkspaces(sessionId, targetAgents.map((a) => a.id));
  }

  const notes = [];
  if (totalChanged > 0) {
    const hasPerAgentNow = await Document.hasAgentAssignments(sessionId);
    if (isAssign && !hadPerAgentAssignments && hasPerAgentNow) {
      notes.push('This session previously had no per-agent document assignments, so every agent could see all session documents. From now on each agent only sees the documents explicitly assigned to it.');
    }
    if (!isAssign && hadPerAgentAssignments && !hasPerAgentNow) {
      notes.push('No per-agent document assignments remain, so every agent falls back to seeing all session documents.');
    }
    if (!isAssign) {
      notes.push('Removed documents stay in the session (the orchestrator can still see them); only the agent access was removed.');
    }
  }

  const problems = unmatchedDocuments.size > 0 || ambiguousDocuments.length > 0
    || unmatchedAgents.length > 0 || ambiguousAgents.length > 0;

  const result = {
    success: totalChanged > 0 || (totalUnchanged > 0 && !problems),
    action,
    results: perAgentResults,
    total_changed: totalChanged,
  };
  if (unmatchedDocuments.size > 0) result.unmatched_documents = [...unmatchedDocuments];
  if (ambiguousDocuments.length > 0) result.ambiguous_documents = ambiguousDocuments;
  if (unmatchedAgents.length > 0) result.unmatched_agents = unmatchedAgents;
  if (ambiguousAgents.length > 0) result.ambiguous_agents = ambiguousAgents;
  if (unmatchedDocuments.size > 0 || unmatchedAgents.length > 0) result.available_agents = availableAgents;
  if (notes.length > 0) result.notes = notes;
  if (!result.success) {
    result.error = totalUnchanged === 0 && totalChanged === 0 && unmatchedDocuments.size > 0
      ? (isAssign
        ? 'No matching document found in the user\'s document library.'
        : 'No matching document is currently assigned to that agent.')
      : 'Nothing was changed; see unmatched/ambiguous entries.';
  }

  logger.info(
    `agent_documents ${action}: session=${sessionId} agents=[${targetAgents.map((a) => a.name).join(', ')}] changed=${totalChanged}`
  );
  return result;
}

function registerAgentDocumentsTool() {
  toolRegistry.register({
    name: 'manage_agent_documents',
    description:
      'Orchestrator only. Assign documents to, or remove documents from, the session\'s agents (same effect as Configure Session → Documents). ' +
      'Use it when the user says things like "assign report.* to @Tax Advisor" or "remove invoice.pdf from @Accountant". ' +
      'Documents are matched by filename (case-insensitive); wildcards * and ? are supported (e.g. "report.*", "*.pdf"). ' +
      'Agents can be given by name (leading @ is fine) or numeric id. ' +
      'Actions: "assign" (searches the user\'s whole document library), "remove" (only the documents the agent currently has), ' +
      '"list" (shows each agent\'s documents and the library; optional "documents" filter). Call it once per request and report the outcome to the user.',
    category: 'session',
    parameters: {
      action: {
        type: 'string',
        enum: ['assign', 'remove', 'list'],
        description: 'assign: give agent(s) access to documents; remove: take documents away from agent(s); list: show assignments and library.',
        required: true,
      },
      documents: {
        type: 'array',
        description: 'Document filenames or wildcard patterns, e.g. ["report.*"] or ["Invoice 01.pdf", "*.xlsx"]. For list, an optional filter.',
        required: false,
        items: { type: 'string' },
      },
      document_ids: {
        type: 'array',
        description: 'Optional numeric document ids (from a previous list call) instead of, or in addition to, names.',
        required: false,
        items: { type: 'integer' },
      },
      agents: {
        type: 'array',
        description: 'Target agents by name (with or without a leading @) or numeric id, e.g. ["Tax Advisor"]. Required for assign and remove.',
        required: false,
        items: { type: 'string' },
      },
    },
    handler: async (params, context = {}) => {
      const { action } = params || {};

      if (!context.sessionId || !context.userId) {
        throw new Error('sessionId and userId are required in context');
      }
      if (context.agentId != null) {
        return { success: false, error: 'manage_agent_documents can only be used by the orchestrator, not by session agents.' };
      }

      const sessionId = context.sessionId;
      const userId = context.userId;

      const agents = (await WorkSession.getAgents(sessionId)) || [];
      const documents = toStringList(params.documents);
      const documentIds = (Array.isArray(params.document_ids) ? params.document_ids : [])
        .map((v) => parseInt(v, 10))
        .filter(Number.isFinite);
      const agentRefs = toStringList(params.agents);

      if (action === 'list') {
        return runList({ sessionId, userId, agents, documents });
      }
      if (action === 'assign' || action === 'remove') {
        if (agents.length === 0) {
          return { success: false, error: 'This session has no agents.' };
        }
        return runChange({ action, sessionId, userId, agents, documents, documentIds, agentRefs });
      }
      return { success: false, error: `Unknown action: ${action}` };
    },
    examples: [
      { description: 'Assign all "report" files to an agent', parameters: { action: 'assign', documents: ['report.*'], agents: ['Tax Advisor'] } },
      { description: 'Remove a document from an agent', parameters: { action: 'remove', documents: ['Invoice 01.pdf'], agents: ['Accountant'] } },
      { description: 'Show current assignments', parameters: { action: 'list' } },
    ],
  });

  logger.info('manage_agent_documents tool registered');
}

module.exports = {
  registerAgentDocumentsTool,
  matchDocuments,
  resolveAgent,
  globToRegExp,
};
