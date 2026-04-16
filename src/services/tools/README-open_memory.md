# OpenMemory Tool (`open_memory`)

Long-term persistent memory for agents via an [OpenMemory](https://openmemory.cavira.app/docs) server. Agents can store facts, preferences, and outcomes, then recall them by natural language. Data is scoped by session/agent.

**Tool handler:** `src/services/tools/openMemoryTool.js`

---

## Configuration

Configure in **Configure Session → Tools** (per agent or orchestrator):

- **Base URL** (required): OpenMemory server URL, e.g. `http://localhost:8080`
- **API key** (optional): If the server has auth enabled (`Authorization: Bearer <key>`)
- **Session scope**: Limits memories to those stored under this session ID. Default: the current session ID. Leave empty to access memories across all sessions.
- **Agent scope**: Limits memories to those stored under this agent/orchestrator ID. Default: the agent's ID (or `orchestrator`). Leave empty to access memories across all agents.
- **Verify SSL**: Check to validate TLS certificates; uncheck for self-signed/dev

Tool config is stored in `session_agent_tools.tool_config` / `session_orchestrator_tools.tool_config` as JSON, e.g.:

```json
{
  "base_url": "http://localhost:8080",
  "api_key": "optional",
  "session_scope": "69",
  "agent_scope": "42",
  "reject_unauthorized": true
}
```

---

## Operations

| Operation | Description | Main parameters |
|-----------|-------------|-----------------|
| **add** | Store a memory | `content` (required), `tags[]`, `metadata`, `user_id` (optional override) |
| **query** | Semantic recall by natural language | `query` (required), `limit` (default 10), `user_id` (optional) |
| **get** | Get one memory by id | `id` (required) |
| **delete** | Delete a memory by id | `id` (required) |
| **list** | List recent memories (paginated) | `limit` (default 10, max 100), `offset` (default 0), `sector` (optional) |
| **health** | Check server connectivity | — |

---

## Scoping

The `user_id` sent to the OpenMemory backend is built from the **session_scope** and **agent_scope** config fields:

| session_scope | agent_scope | Resulting user_id | Effect |
|---------------|-------------|-------------------|--------|
| `69` | `42` | `session:69:agent:42` | Isolated to one agent in one session |
| `69` | *(empty)* | `session:69` | All agents' memories in session 69 |
| *(empty)* | `42` | `agent:42` | Agent 42's memories across all sessions |
| *(empty)* | *(empty)* | `global` | All memories on the server |

- Defaults are pre-filled in the UI: current session ID and current agent ID (or `orchestrator`).
- The `user_id` parameter on individual operations (add, query, etc.) overrides the config scope.
- The OpenMemory backend may enforce per-user isolation; get/delete/list use this scope where supported.

---

## API mapping (Cavira OpenMemory backend)

| Tool operation | HTTP | Path / body |
|----------------|------|-------------|
| add | POST | `/memory/add` — `{ content, tags?, metadata?, user_id? }` |
| query | POST | `/memory/query` — `{ query, k (limit), user_id? }` → `matches[]` |
| get | GET | `/memory/:id?user_id=...` |
| delete | DELETE | `/memory/:id?user_id=...` |
| list | GET | `/memory/all?user_id=...&l=limit&u=offset&s=sector` → `items[]` |
| health | GET | `/health` |

---

## Response shapes

- **add**: `{ success, id, primary_sector, sectors, ... }`
- **query**: `{ success, memories (or matches), count, ... }`
- **get**: `{ success, memory, id, ... }` or 404/403
- **delete**: `{ success, deleted, id, ... }` or 404/403
- **list**: `{ success, items, count, ... }`
- **health**: `{ success, ok, message, ... }`

---

## Implementation notes

- Uses Node `https`/`http`; supports self-signed certs when `reject_unauthorized: false`.
- Config is loaded from DB on first use per context (`ensureToolConfig`); no in-memory token cache (unlike ef_api).
- Query response normalizes both Cavira `matches` and generic `memories`/`results` for compatibility.
