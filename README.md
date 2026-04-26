# Badvisor

Badvisor is a self-hosted, session-based multi-agent workspace for business planning and decision-making. Create work sessions, configure an orchestrator plus specialist agents, assign tools and documents per agent, and interact via chat or formal tasks.

Key capabilities include:

- **AI brainstorming mode**: optional “conversation mode” for structured team-style ideation.
- **Work sessions**: session import/export and share links for collaboration.
- **Custom agents**: local (Ollama) or cloud providers, assigned per session.
- **Per-agent tools**: enable tools per agent (e.g. file workspace, SQLite, media processing).
- **Document archive + embeddings**: upload documents and search/ground responses with local embeddings.
- **Scheduled jobs**: run session tasks on a schedule.
- **Webhooks**: let external systems post into a session.

## Quick start

Clone the repo and install dependencies (see **Installation**). Access the app in your browser at the IP address and port you configured (for a better experince make sure you have access over SSH or a terminal to the computer running the app).
Save changes after configuring each section below.

- Define a few agents.
- Create a session, select it, then open **Configure session** (gear icon).
- Configure the **Orchestrator** provider/model.
- Assign **Agents** to the session.
- Assign **Tools** per agent.
- Set **Orchestrator Initial Context** (you can load the default prompt).
- Set each agent’s initial prompt (comment button next to the agent).

Then go to **Chat** and start. “AI Brainstorming” (conversation mode) is off by default—enable it in the chat view or in session configuration.

**User responsibility disclaimer:** You are responsible for protecting any credentials, API keys, and other sensitive information you provide to the app. The project maintainers/developer are not responsible for how the application is used, nor for any data loss, damages, or other consequences that may result from its operation.

## Quick tips

- type @ in the main chat textbox to get the list of agents to address directly
- long click / press on the colored boxes on topf of the main chat to extend and show additional info; there are also 2 buttons available, info and edit, for each agent
- If you get an error Too many requests, increase the value for RATE_LIMIT_MAX_REQUESTS in .env

## Features

- **Persistent Work Sessions**: Create named projects (e.g., "Q4 Tax Planning") with auto-save
- **Multi-Agent System**: User-defined specialized agents (legal, accounting, marketing, sales, etc.)
- **Adaptive Orchestration**: Intelligent task routing with sequential or parallel execution
- **Document Management**: Upload and manage documents with local embeddings (Transformers.js + FAISS)
- **Chat & Task Modes**: Casual conversation or formal task submission
- **MCP Tool Integration**: File system operations, web search, email
- **Multimodal Media Tool**: Process images/audio/video/PDF assigned to an agent via `process_media` (optional: ffmpeg for video, Poppler for PDF page vision)
- **Local SQLite Database Tool**: Agents can create and manage isolated SQLite databases via `sqlite_local_db`
- **Local Working Folder Tool**: Agents can manage files and directories in isolated workspaces via `local_working_folder`
- **Workspace Execution Tool**: Agents can execute shell commands within their workspace via `workspace_exec`
- **State Persistence Tool**: Fast in-memory key-value storage for session variables via `state_persist`
- **Archived Conversation History Tool**: Read and export conversation history with filtering, chunking, and export capabilities via `archived_conversation_history`
- **Interactive HTML/JS Artifacts**: Agents can create visualizations, charts, and interactive content rendered in iframes
- **Multiple LLM Providers**: Claude, OpenAI, Gemini, DeepSeek, Qwen, Granite (cloud) + Ollama (local)
- **Multi-User Support**: Basic authentication with user isolation
- **Superuser Management**: Admin user management with password reset and user deletion capabilities

## Tech Stack

- **Backend**: Node.js + Express.js REST API
- **Frontend**: Vanilla HTML, Bootstrap 5, JavaScript
- **Database**: SQLite
- **Embeddings**: Transformers.js + FAISS (local, no cloud dependencies)
- **Authentication**: JWT

## Prerequisites

- Node.js >= 18.0.0
- npm or yarn

## Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd Badvisor
```

2. Copy the example environment file:

```bash
cp .env.example .env
```

3. Edit `.env` and configure your settings:
   - Generate a strong `JWT_SECRET`
   - Generate a 32-character `ENCRYPTION_KEY` for API key encryption
   - Set `SUPERUSER_NAME` to the username that should have admin privileges (optional)
   - Configure LLM provider API keys (optional, can be set per agent)
   - Configure SMTP settings for email tool (optional)

   **Generating `JWT_SECRET` and `ENCRYPTION_KEY`:** you can generate both values using Node.js:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   Use the output as `JWT_SECRET`, and for `ENCRYPTION_KEY` (it will be > 32 characters).

4. Install dependencies:

```bash
npm install
```

5. Run database migrations:

```bash
npm run migrate
```

6. **Optional — system dependencies for `process_media`** (image/audio/video/PDF):
   - **Video** (frame extraction): install [ffmpeg](https://ffmpeg.org/) (e.g. `apt install ffmpeg`, `brew install ffmpeg`).
   - **PDF** (vision per page): install [Poppler](https://poppler.freedesktop.org/) so `pdftoppm` is on `PATH` (e.g. `apt install poppler-utils`, `brew install poppler`). Without it, PDFs still return extracted text via pdf-parse, but page-by-page vision is skipped.
   - **Audio/video transcription**: requires `OPENAI_API_KEY` (Whisper).
   - **PDF timeouts**: if large PDFs report timeouts, set `PDF_PARSE_TIMEOUT_MS` (default 90s), `PDFTOPPM_TIMEOUT_MS` (default 2 min), and/or `PDF_VISION_TIMEOUT_MS` (default 5 min total for all page vision calls) in `.env`.

## Docker (Docker Compose)

1. Install Docker and the Docker Compose plugin.
2. Create your environment file:
   ```bash
   cp .env.example .env
   ```

   Note: **do not commit** `.env` to GitHub. Keep all secrets only in your local `.env`.

3. Start Badvisor:
   ```bash
   docker compose up -d --build
   ```

4. Open the app in your browser at: `http://localhost:3000`

5. First-time superuser activation (recommended workflow)
   - Register an account in the frontend using the exact username from `SUPERUSER_NAME` (new users are created inactive by default).
   - Activate it inside the running container:
     ```bash
     docker compose exec badvisor npm activate_superuser
     ```
   - Log in as that user.

Data persistence:
- SQLite database + uploaded documents/embeddings are stored in the Docker volume `badvisor-storage`.
- To reset all stored data: `docker compose down -v`.

## Usage

### Development Mode

```bash
npm run dev
```
or

### Production Mode

```bash
npm start
```

Register in the frontend that exact username as `SUPERUSER_NAME` as set in .env (it will be created inactive)
Run:
```bash
npm activate_superuser
```
Log in as superuser and go to top right settings, user management to manage users

The application will be available at `http://localhost:3000` (or the port specified in `.env`).

## Project Structure

```
Badvisor/
├── server.js                          # Express entry point
├── config/                            # Configuration files
├── src/
│   ├── middleware/                    # Express middleware
│   ├── routes/                        # API routes
│   ├── services/                      # Business logic
│   │   ├── sessions/                  # Session management
│   │   ├── orchestrator/              # Task orchestration
│   │   ├── agents/                    # Agent management
│   │   ├── documents/                 # Document processing
│   │   ├── mcp/                       # MCP tools
│   │   └── auth/                      # Authentication
│   ├── providers/                     # LLM provider adapters
│   ├── models/                        # Database models
│   ├── utils/                         # Utility functions
│   └── db/                            # Database and migrations
├── storage/                           # Data storage
│   ├── documents/                     # Uploaded documents
│   ├── embeddings/                    # FAISS indices
│   ├── agents-dbs/                    # Agent-specific SQLite databases
│   ├── agents-workspaces/             # Agent-specific working folders
│   └── database.sqlite                # SQLite database
└── public/                            # Frontend files
    ├── css/                           # Stylesheets
    └── js/                            # JavaScript files
```

## API Documentation

### Authentication

- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login and get JWT
- `POST /api/auth/logout` - Invalidate JWT
- `GET /api/auth/me` - Get current user (includes `isSuperuser` flag)
- `PUT /api/auth/password` - Change own password
- `GET /api/auth/sessions` - Get active sessions for current user

### User Management (Superuser Only)

- `GET /api/auth/users` - List all users
- `DELETE /api/auth/users/:id` - Delete a user
- `PUT /api/auth/users/:id/reset-password` - Reset a user's password

### n8n / Automation Integration (HTTP Requests)

You can trigger the chat pipeline from automation tools like **n8n**.

#### LAN connectivity / firewall note

If n8n runs on another machine in your LAN, make sure it can reach this server:

- Use the server’s LAN IP in URLs (not `localhost`), e.g. `http://<server-lan-ip>:3000/health`
- If you use UFW on the server machine, allow inbound traffic on port 3000:

```bash
sudo ufw allow 3000/tcp
```

#### Option A (available now): Call chat API using JWT

This uses the existing authenticated endpoint and works immediately.

1. **Login node (get JWT)**
   - **Method**: `POST`
   - **URL**: `http://<host>:3000/api/auth/login`
   - **Send Body**: `JSON`
   - **Body**:
     - `username`
     - `password`

2. **HTTP Request node (send chat message)**
   - **Method**: `POST`
   - **URL**: `http://<host>:3000/api/chat/<sessionId>`
   - **Headers**:
     - `Authorization: Bearer <JWT>`
     - `Content-Type: application/json`
   - **Send Body**: `JSON`
   - **Body**:

```json
{ "message": "Your message here" }
```

**Context-only mode (no agent processing):**

- Add `"context": true` to the body to add the message to conversation history without processing through agents (saves tokens):

```json
{ "message": "sensor data", "context": true }
```

**Posting on behalf of another user (alias):**

- When using context-only mode, you can post on behalf of another user by including the `alias` key with the user ID:

```json
{ "message": "sensor data", "context": true, "alias": 4 }
```

**Requirements for alias posting:**

- The alias user must exist and be activated
- The logged-in user (JWT owner) must own the session
- Only works with context-only mode (`context: true`)

#### Option B (planned): Call a shared-secret webhook (no JWT)

This is the intended integration for inbound webhooks (e.g. n8n) where the caller is not a logged-in user.

- **How the secret is set**: in **Configure Session** (UI) you’ll enable inbound webhooks and set a per-session secret.
- **How n8n sends the secret**: recommended via header `X-Session-Webhook-Secret`.
- **DB support**: session stores only a hash of the secret:
  - `work_sessions.inbound_webhook_enabled`
  - `work_sessions.inbound_webhook_secret_hash`

Recommended n8n node settings:

- **Method**: `POST`
- **URL**: `http://<host>:3000/api/webhooks/n8n`
- **Headers**:
  - `Content-Type: application/json`
  - `X-Session-Webhook-Secret: <your secret>`
- **Send Body**: `JSON`
- **Body**:

```json
{
  "sessionId": 12,
  "data": {
    "event": "invoice.paid",
    "invoiceId": "INV-10023",
    "amount": 149.95,
    "customer": "Acme Ltd"
  }
}
```

### Work Sessions

- `GET /api/sessions` - List user's sessions
- `POST /api/sessions` - Create new session
- `GET /api/sessions/:id` - Get session details
- `PUT /api/sessions/:id` - Update session
- `DELETE /api/sessions/:id` - Delete session

### Chat

- `POST /api/chat/:sessionId` - Send message to main agent
  - Body: `{ "message": "..." }`
  - Context-only: `{ "message": "...", "context": true }` - Adds to history without agent processing
  - Alias posting: `{ "message": "...", "context": true, "alias": <userId> }` - Post on behalf of another user (requires session ownership)
- `POST /api/chat/:sessionId/stream` - Stream response (SSE)

### Agents

- `GET /api/agents` - List user's agents
- `POST /api/agents` - Create agent
- `GET /api/agents/:id` - Get agent details
- `PUT /api/agents/:id` - Update agent
- `DELETE /api/agents/:id` - Delete agent

### Documents

- `GET /api/documents` - List user's documents
- `POST /api/documents` - Upload document
- `GET /api/documents/:id` - Get document metadata
- `DELETE /api/documents/:id` - Delete document

### Tasks

- `GET /api/tasks` - List tasks
- `POST /api/tasks` - Submit new task
- `GET /api/tasks/:id` - Get task details
- `GET /api/tasks/:id/results` - Get task results

## User Flow

1. **Register/Login**: Create account and authenticate
2. **Create Session**: Start a new project (e.g., "Q4 Tax Planning")
3. **Configure Session**:
   - Create specialized agents (legal, accounting, marketing)
   - Upload relevant documents (tax forms, contracts, business data)
   - Assign agents and documents to session
4. **Interact**:
   - **Chat Mode**: Ask questions, get advice, delegate to specialists
   - **Task Mode**: Submit formal tasks for structured analysis
5. **Session Persistence**: All interactions auto-saved, reload anytime

## Configuration

### LLM Providers

Each agent can use a different LLM provider. Configure when creating an agent:

- **Claude** (Anthropic): Requires `ANTHROPIC_API_KEY`
- **OpenAI** (GPT): Requires `OPENAI_API_KEY`
- **Gemini** (Google): Requires `GOOGLE_API_KEY`
- **DeepSeek**: Requires `DEEPSEEK_API_KEY`
- **Qwen**: Requires API key
- **Granite**: Requires API key
- **Ollama** (Local): Requires Ollama running locally. To use an Ollama server on another machine (e.g. on your LAN):
  - **Option A (all sessions):** set `OLLAMA_BASE_URL=http://<host>:11434` in `.env` (e.g. `http://192.168.1.10:11434`).
  - **Option B (per session):** in **Configure Session → Orchestrator**, choose Ollama, then set **Ollama Address** to the hostname or IP (e.g. `192.168.1.10`) and **Ollama Port** to `11434` (or paste a full URL like `http://192.168.1.10:11434` into the address field).
  - On the machine running Ollama: ensure Ollama listens on all interfaces (e.g. `OLLAMA_HOST=0.0.0.0`) and that the firewall allows inbound TCP on port 11434. From the machine running this app, verify with: `curl http://<host>:11434/api/tags`.

### System-Enabled Tools

You can restrict which tools appear in the **Tools view** (`nav-tools`) and **Configure Session → Tools** using the `ENABLED_TOOLS` environment variable. This is useful when running multiple instances of the app—each instance can expose only the tools relevant to its use case.

**Configuration in `.env`:**

```env
# Comma-separated list of tool names. Only these tools are shown in the UI.
# If empty or not set, all registered tools are shown.
ENABLED_TOOLS=web_search,webhook_request,process_media,sqlite_local_db,local_working_folder,workspace_exec,state_persist,session_pool,ef_api,archived_conversation_history,conversation_rounds,session_schedule,calculate_depreciation,categorize_business_expense,calculate_business_ratios,convert_currency
```

- **Empty or unset:** All registered tools are shown (default behavior).
- **Set:** Only tools listed appear in the Tools view and Configure Session → Tools.
- **Filter is display-only:** Tools remain registered on the backend; existing assignments continue to work. Users simply cannot see or assign tools that are not in the list.

### MCP Tools

Configure in `.env`:

- **File System**: Sandboxed operations in user directories
- **Web Search**: Requires search API key (optional)
- **Email**: Requires SMTP configuration

### Agent Tool: `webhook_request` (Outbound Webhooks / n8n)

Agents can call remote webhook endpoints (e.g. your n8n instance) using the built-in tool **`webhook_request`**.

**Parameters:**

- **`url`** _(required)_: absolute `http(s)` URL
- **`method`** _(optional)_: `GET|POST|PUT|PATCH|DELETE` (default: `POST`)
- **`headers`** _(optional)_: object of header key/value pairs
- **`query`** _(optional)_: object appended as query params
- **`body`** _(optional)_: JSON body for `POST/PUT/PATCH`
- **`timeout_ms`** _(optional)_: request timeout (default: `30000`)
- **`max_response_chars`** _(optional)_: truncates large responses (default: `20000`)

**Recommended safety setting (restrict outbound destinations):**

```env
# Comma-separated URL prefixes allowed for webhook_request
WEBHOOK_REQUEST_ALLOWLIST=http://192.168.88.50:5678/webhook/,https://n8n.mycompany.com/webhook/
```

### Agent Tool: `process_media` (Images / Audio / Video / PDF)

`process_media` is a tool intended for multimodal models. It processes **one document by filename** (as shown in **Configure Session → Documents**) and enforces that:

- the tool is enabled for the agent (Configure Session → **Tools**), and
- the document is assigned to that same agent (Configure Session → **Documents**).

**Example prompt:**

`process the file Screenshot from 2026-01-11 13-48-58.png using process_media`

**What it returns:**

- **Images**: description + extracted text (vision-based)
- **Audio**: transcript
- **Video**: transcript + sampled frame descriptions
- **PDF**: extracted text (pdf-parse) + vision description of each page (when Poppler is installed)

**Requirements:**

- **Ollama vision models (e.g. `qwen3-vl`)**: supported for image/frame understanding when the agent provider is `ollama` and the model is a VL/vision model.
  - Set `OLLAMA_BASE_URL` (or configure the agent provider base URL).
  - Ensure the model is pulled and runnable by Ollama.
- **Video**: requires `ffmpeg` available on the server (see [Installation](#installation)).
- **PDF page vision**: requires **Poppler** (`pdftoppm` on `PATH`), e.g. `apt install poppler-utils` or `brew install poppler`. Without it, PDFs still return extracted text only.
- **Audio/video transcription**: uses OpenAI Whisper and requires `OPENAI_API_KEY`.

### Agent Tool: `sqlite_local_db` (Local SQLite Database)

Agents can interact with a local SQLite database assigned per agent using the built-in tool **`sqlite_local_db`**. Each agent gets an isolated database file stored in `storage/agents-dbs/`.

**Configuration:**

- In **Configure Session → Tools**, assign `sqlite_local_db` to agents
- Instead of a checkbox, you'll see a text input field
- Enter a database name (e.g., "customer_data", "inventory") to enable the tool for that agent
- Leave empty to disable the tool
- Each agent's database is isolated and stored with a unique filename based on session ID, agent ID, and database name

**Operations:**

- **`create_table`**: Create tables with custom schemas
  - Parameters: `table_name`, `schema` (e.g., "id INTEGER PRIMARY KEY, name TEXT NOT NULL")
- **`list_tables`**: List all tables in the database
- **`describe_table`** / **`get_table_info`**: Get table schema, columns, indexes, and row count
- **`alter_table`**: Add columns to existing tables (SQLite limitations apply)
  - Parameters: `table_name`, `columns` (array with `action: "add"`, `column`, `type`)
- **`insert`**: Insert data into a table
  - Parameters: `table_name`, `data` (object with column names as keys)
- **`update`**: Update rows in a table
  - Parameters: `table_name`, `data` (object), `where` (optional WHERE clause)
- **`delete`**: Delete rows from a table
  - Parameters: `table_name`, `where` (required - prevents accidental deletion of all rows)
- **`select`**: Query data with filtering, ordering, and limits
  - Parameters: `table_name`, `where` (optional), `order_by` (optional), `limit` (optional)
- **`execute_sql`**: Execute custom SQL statements (with safety checks)
  - Parameters: `sql` (SQL statement)
  - Allowed operations: SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, PRAGMA
- **`drop_table`**: Drop a table
  - Parameters: `table_name`

**Example usage:**

```
Create a table for storing customer information:
- operation: create_table
- table_name: customers
- schema: id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP

Insert a customer:
- operation: insert
- table_name: customers
- data: { name: "John Doe", email: "john@example.com" }

Query customers:
- operation: select
- table_name: customers
- where: email = ?
- limit: 10
```

**Database location:**

- Database files are stored in `storage/agents-dbs/`
- Each database file has a unique name combining the user-provided name with a hash of session ID, agent ID, and database name
- Databases persist across sessions and can be accessed by the same agent in the same session

**Security:**

- Input sanitization prevents SQL injection
- Each agent has isolated database access
- DELETE operations require a WHERE clause to prevent accidental data loss
- Only safe SQL operations are allowed in `execute_sql`

### Agent Tool: `local_working_folder` (Local Working Folder)

Agents can manage files and directories in an isolated working folder assigned per agent per session using the built-in tool **`local_working_folder`**. Each agent gets a unique workspace directory stored in `storage/agents-workspaces/`.

**Configuration:**

- In **Configure Session → Tools**, assign `local_working_folder` to agents
- Instead of a checkbox, you'll see a text input field
- Enter a folder name (e.g., "data_analysis", "scripts") to enable the tool for that agent
- Leave empty to disable the tool
- Each agent's workspace is isolated and stored with a unique directory name based on session ID, agent ID, and folder name

**Operations:**

- **`create_file`**: Create files with content
  - Parameters: `path` (relative to workspace), `content` (string), `overwrite` (optional, default: false), `mode` (optional, default: "644")
  - Example: `{operation: "create_file", path: "./data/temps.csv", content: "timestamp,temp\n2024-01-01,25.5"}`
- **`edit_file`**: Modify existing files
  - Parameters: `path`, `content`, `edit_mode` ("append"|"overwrite"|"insert"), `offset` (for insert mode)
  - Example: `{operation: "edit_file", path: "./logs/app.log", content: "New entry\n", edit_mode: "append"}`
- **`delete_file`**: Remove files or directories
  - Parameters: `path`, `recursive` (optional, for directories), `dry_run` (optional, preview what would be deleted)
- **`chmod`**: Set file permissions
  - Parameters: `path`, `mode` (e.g., "755", "644")
- **`list_dir`**: List directory contents
  - Parameters: `path` (optional, default: "."), `details` ("basic"|"full")
  - Returns: Array of entries with name, type, size, permissions, modified time (if details="full")
- **`mkdir`**: Create directories
  - Parameters: `path`, `mode` (optional, default: "755")
- **`read_file`**: Read file content
  - Parameters: `path`, `max_size` (optional, default: 1024 bytes, max: 10485760)
- **`pwd`**: Get current workspace path
- **`cd`**: Validate and return new path (stateless, for reference)
- **`exists`**: Check if file/directory exists
  - Parameters: `path`
  - Returns: exists, is_file, is_directory, size, mode, modified_time

**Example usage:**

```
Create a CSV file:
- operation: create_file
- path: ./data/temps.csv
- content: timestamp,temperature\n2024-01-01,25.5\n2024-01-02,26.0

List files in directory:
- operation: list_dir
- path: ./data
- details: full

Read a file:
- operation: read_file
- path: ./data/temps.csv
- max_size: 2048
```

**Workspace location:**

- Workspace directories are stored in `storage/agents-workspaces/`
- Each workspace has a unique name combining the user-provided folder name with a hash of session ID, agent ID, and folder name
- Workspaces persist across sessions and can be accessed by the same agent in the same session

**Security:**

- Path validation prevents directory traversal (all paths must stay within workspace)
- Relative paths are normalized and validated against workspace root
- No access to files outside the assigned workspace

### Agent Tool: `workspace_exec` (Workspace Command Execution)

Agents can execute shell commands within their assigned working folder using the built-in tool **`workspace_exec`**. This tool provides command execution capabilities with security constraints and resource limits.

**Requirements:**

- **`local_working_folder` must be configured first**: The agent must have `local_working_folder` assigned with a folder name before using `workspace_exec`
- In **Configure Session → Tools**, assign `workspace_exec` to agents via checkbox

**Parameters:**

- **`command`** _(required)_: Shell command to execute (e.g., "python3 script.py", "ls -la ./data/")
- **`cwd`** _(optional)_: Relative path within workspace (default: `./`)
- **`env`** _(optional)_: Custom environment variables (object with string keys/values, e.g., `{"PYTHONPATH": "./lib/"}`)
- **`timeout_ms`** _(optional)_: Execution timeout in milliseconds (default: 30000, min: 1000, max: 120000)
- **`capture_output`** _(optional)_: Whether to capture stdout/stderr (default: true)
- **`shell`** _(optional)_: Shell to use (defaults to system shell: bash on Linux/Mac, cmd.exe on Windows)

**Return value:**

```javascript
{
  success: boolean,
  exit_code: number,
  stdout: string,
  stderr: string,
  duration_ms: number,
  files_affected: string[] (optional),
  workspace_path: string,
  cwd: string
}
```

**Security measures:**

- Command validation against dangerous patterns (e.g., `rm -rf /`, `sudo`, network commands)
- Whitelist of allowed commands (python, node, git, tar, ls, cat, etc.)
- Path validation prevents escaping workspace
- Timeout protection (default 30s, max 120s)
- Output size limits (10KB for stdout/stderr)
- Automatic logging to `./logs/exec_history.log` in workspace

**Example usage:**

```
Run a Python script:
- command: python3 -c "import pandas as pd; df = pd.read_csv('./data/temps.csv'); print(df['temp'].mean())"

List files:
- command: ls -la ./graphs/

Run script with custom environment:
- command: python3 ./scripts/plot_temps.py
- cwd: ./scripts
- env: {"PYTHONPATH": "./lib/"}
```

**Use cases:**

- Data processing: Run Python scripts to analyze CSV files
- Script automation: Execute scripts created via `local_working_folder`
- File operations: Use `tar`, `git`, or other command-line tools
- Testing/iteration: Quick command execution for testing

**Logging:**

- All commands are automatically logged to `./logs/exec_history.log` in the workspace
- Logs include timestamp, command, exit code, duration, and output snippets

### Agent Tool: `state_persist` (In-Memory Key-Value Storage)

Agents can store and retrieve session-specific variables in fast in-memory storage using the built-in tool **`state_persist`**. This provides low-latency access without file I/O or database queries.

**Configuration:**

- In **Configure Session → Tools**, assign `state_persist` to agents via checkbox
- No additional configuration needed

**Operations:**

- **`set`**: Store a value with optional expiration
  - Parameters: `key` (string), `value` (string/number/boolean/object), `ttl_ms` (optional, time-to-live in milliseconds)
  - Example: `{operation: "set", key: "session_start_time", value: "2026-01-25 08:00:00"}`
  - Example with TTL: `{operation: "set", key: "temp_threshold", value: 25.5, ttl_ms: 3600000}` (expires in 1 hour)
- **`get`**: Retrieve a value instantly
  - Parameters: `key` (string)
  - Returns: value, expiration time, size, updated timestamp
- **`delete`**: Remove a key
  - Parameters: `key` (string)
- **`list`**: List all keys in the session
  - Returns: array of keys, count, total size
- **`clear`**: Clear all keys for the session
  - Returns: number of cleared keys

**Data types supported:**

- Strings, numbers, booleans
- JSON objects (automatically parsed if string looks like JSON)

**Limits:**

- Max 100 keys per session
- Max 10KB total size per session
- Max 1KB per value

**TTL (Time-To-Live) support:**

- Optional expiration time for keys (range: 1 second to 7 days)
- Automatic cleanup of expired keys every 5 minutes
- Expired keys are automatically removed on get operations

**Example usage:**

```
Set a session variable:
- operation: set
- key: session_start_time
- value: 2026-01-25 08:00:00

Set with expiration (1 hour):
- operation: set
- key: temp_threshold
- value: 25.5
- ttl_ms: 3600000

Get a value:
- operation: get
- key: session_start_time

List all keys:
- operation: list

Delete a key:
- operation: delete
- key: old_counter
```

**Use cases:**

- Session variables: `session_start_time`, `current_step`
- Counters: `update_count`, `iteration_number`
- Configuration: `temp_threshold`, `processing_mode`
- Transient state: `last_result`, `current_batch_id`

**Implementation details:**

- Data is isolated per session-agent pair (`sessionId:agentId`)
- In-memory storage using Map structure for fast access
- Background cleanup interval runs every 5 minutes
- Data persists across tool calls but resets on new sessions
- Graceful cleanup on server shutdown

### Agent Tool: `archived_conversation_history` (Conversation History Reader)

Agents can read archived chat history from their session with advanced filtering, chunked responses, and export capabilities using the built-in tool **`archived_conversation_history`**. This tool allows agents to review past conversations, summarize long discussions, or check what users asked.

**Configuration:**

- In **Configure Session → Tools**, assign `archived_conversation_history` to agents via checkbox
- No additional configuration needed
- Works immediately when assigned

**Core operations:**

- **Read messages**: Retrieve messages with pagination (from/to indices)
- **Filter by role**: Get only user or assistant messages
- **Filter by date**: Get messages from specific date ranges
- **Search by keywords**: Find messages containing specific keywords
- **Chunked responses**: Automatically handles large histories (thousands of messages) by breaking into chunks
- **Export options**: Export as JSON/CSV string or save to file

**Parameters:**

- **`from`** _(optional, default: 0)_: Starting index (0-based) of messages to retrieve
- **`to`** _(optional)_: Ending index (exclusive, 0-based). If omitted, uses default limit or auto-chunks
- **`orderedAsc`** _(optional, default: true)_: Order messages chronologically (true) or reverse-chronologically (false)
- **`role`** _(optional)_: Filter by message role - "user" or "assistant"
- **`date_from`** _(optional)_: Filter messages from this date onwards (ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)
- **`date_to`** _(optional)_: Filter messages up to this date (ISO format)
- **`keywords`** _(optional)_: Filter messages containing keywords (array or string, case-insensitive, all keywords must match)
- **`chunk_size`** _(optional, default: 100)_: Size of each chunk when retrieving large histories (10-100 messages)
- **`auto_chunk`** _(optional, default: true)_: Automatically chunk large requests to prevent timeouts
- **`format`** _(optional)_: Export format - "json" or "csv" to return formatted string
- **`export_to_file`** _(optional)_: Export to file in agent's working folder (requires `local_working_folder` to be configured)

**Chunked responses:**
For super-long histories (thousands of messages), the tool automatically breaks responses into bite-sized chunks (default 100 messages per chunk) to prevent timeouts and overloads. Each chunked response includes:

- Current chunk number and total chunks
- Number of messages in current chunk
- Remaining messages count
- Suggestion for fetching the next chunk

**Export functionality:**

- **Format as string**: Use `format: "json"` or `format: "csv"` to get formatted data in the `exported_data` field
- **Export to file**: Use `export_to_file` with a relative path (e.g., "exports/history.json", "./data/conversation.csv")
- **File export requirements**: Requires `local_working_folder` tool to be configured first
- **Path validation**: File path must be within the agent's working folder (prevents directory traversal)
- **Auto-format**: If `format` is not specified with `export_to_file`, defaults to JSON

**Example usage:**

```
Get first 10 messages:
- from: 0
- to: 10
- orderedAsc: true

Get all user messages from last week:
- role: user
- date_from: 2026-01-17
- orderedAsc: false

Search for messages containing keywords:
- keywords: ["artifact", "T:"]
- orderedAsc: true

Get messages in date range:
- role: assistant
- date_from: 2026-01-20T00:00:00
- date_to: 2026-01-24T23:59:59

Export as JSON string:
- from: 0
- to: 100
- format: json

Export to CSV file:
- from: 0
- to: 100
- export_to_file: exports/conversation.csv
- format: csv

Get all messages (auto-chunked):
- from: 0
- auto_chunk: true
```

**Response format:**

```javascript
{
  success: true,
  messages: [...],              // Message objects
  exported_data: "...",         // Formatted string (if format specified)
  total_count: 500,             // Total messages in session
  filtered_count: 500,          // Total after filters
  from: 0,
  to: 100,
  returned_count: 100,
  ordered_asc: true,
  filters_applied: {...},       // Applied filters
  has_more: true,
  max_per_request: 100,
  message: "Retrieved 100 message(s)...",
  chunk: {                      // Present when chunked
    is_chunked: true,
    chunk_size: 100,
    current_chunk: 1,
    total_chunks: 5,
    messages_in_chunk: 100,
    remaining_messages: 400,
    next_chunk: {
      from: 100,
      to: 200,
      suggestion: "To get the next chunk, call again with from=100..."
    }
  },
  export: {                     // Present when exported to file
    file_path: "exports/history.json",
    absolute_path: "/path/to/workspace/exports/history.json",
    format: "json",
    messages_exported: 100,
    file_size_bytes: 12345
  }
}
```

**Use cases:**

- **Summarize conversations**: Read all messages and provide a summary
- **Check user requests**: Search for specific keywords or topics mentioned by users
- **Review history**: Get messages from specific date ranges for context
- **Export data**: Save conversation history as JSON or CSV for analysis
- **Context understanding**: Review past interactions before responding to current questions

**Security:**

- Path validation ensures file exports stay within agent's working folder
- Maximum 100 messages per request prevents overloads
- Parameterized SQL queries prevent SQL injection
- File path validation prevents directory traversal attacks

**Location:**

- Tool handler: `src/services/tools/conversationHistoryTool.js`
- Messages stored in `messages` table in SQLite database
- Exported files saved in agent's workspace: `storage/agents-workspaces/`

### Interactive HTML/JS Artifacts

Agents can create interactive HTML/JavaScript content that renders as sandboxed iframes in the chat interface. This enables agents to create visualizations, charts, interactive calculators, diagrams, and other dynamic content.

**How it works:**

- Agents output code blocks with ` ```html ` or ` ```iframe ` language tags
- The system automatically detects and renders these as interactive iframes
- Content runs in a sandboxed iframe for security
- Users can reload, toggle height, and view source code

**Format:**

````
```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <canvas id="myChart"></canvas>
  <script>
    // Your JavaScript code here
  </script>
</body>
</html>
````

```

**Use cases:**
- Data visualizations (charts, graphs, dashboards)
- Interactive calculators or tools
- Visual diagrams or flowcharts
- Interactive forms or demos
- Any HTML/JS content that enhances responses

**Instructing agents to use this feature:**

**Option 1: Add to Agent Initial Context**
When creating or editing an agent, add this to the "Initial Context" field:

```

You have the ability to create interactive HTML/JavaScript artifacts that will be rendered in the chat interface. When you need to create visualizations, charts, graphs, interactive demos, or any visual content, use the following format:

```html
<!DOCTYPE html>
<html>
  <head>
    <!-- Include any CSS or external libraries here -->
  </head>
  <body>
    <!-- Your HTML content here -->
    <script>
      // Your JavaScript code here
    </script>
  </body>
</html>
```

The code block must start with `html or `iframe. The system will automatically render this as an interactive iframe that users can interact with.

Examples of what you can create:

- Data visualizations (charts, graphs, dashboards)
- Interactive calculators or tools
- Diagrams or flowcharts
- Interactive forms or demos
- Any HTML/JS content that helps illustrate your response

When appropriate, use this feature to make your responses more visual and interactive.

```

**Option 2: Add to Session Orchestrator Context**
In the "Orchestrator Initial Context" (Session Configuration → General tab), add:

```

Agents in this session can create interactive HTML/JavaScript artifacts by outputting code blocks with `html or `iframe. These will be rendered as interactive iframes in the chat interface, allowing for visualizations, charts, interactive tools, and other dynamic content.

````

**Security:**
- Artifacts run in sandboxed iframes with restricted permissions
- Content is properly escaped to prevent XSS attacks
- Only assistant messages can create artifacts (not user messages)

## User Management & Superuser

The application supports a superuser role for administrative tasks. The superuser is determined by the `SUPERUSER_NAME` environment variable.

### Setting Up a Superuser

1. Add to your `.env` file:
   ```env
   SUPERUSER_NAME=admin
```

Replace `admin` with your desired superuser username.

2. Register a user account in the frontend using the exact username from `SUPERUSER_NAME`.

   Note: newly registered accounts are created inactive by default and cannot log in until they are activated.

3. Activate the account:

   ```bash
   npm activate_superuser
   ```

After activation, the configured `SUPERUSER_NAME` user will have superuser privileges.

### Superuser Features

Superusers have access to a **User Management** tab in the Settings dialog where they can:

- **View all users**: See a list of all registered users with their IDs, usernames, and creation dates
- **Reset passwords**: Reset any user's password (the user will need to log in again)
- **Delete users**: Remove users from the system (cannot delete own account)

### Security

- Superuser status is checked server-side on all admin routes
- Users cannot delete their own account
- Password resets invalidate all existing tokens for that user
- All admin operations are logged

## Security

- JWT authentication with 24-hour expiration
- API keys encrypted with AES-256-GCM before storage
- Multi-user isolation (all queries filtered by user_id)
- Sandboxed file system operations
- Input validation on all endpoints
- Rate limiting to prevent abuse
- Superuser middleware protects admin routes

## Development

### Running Tests

```bash
npm test
```

### Database Migrations

Create a new migration:

```bash
# Manually create file in src/db/migrations/
# Format: NNN_description.sql
```

Run migrations:

```bash
npm run migrate
```

## Troubleshooting

### Common Issues

1. **"Cannot find module" errors**: Run `npm install`
2. **Database errors**: Delete `storage/database.sqlite` and run `npm run migrate`
3. **Port already in use**: Change `PORT` in `.env`
4. **LLM API errors**: Verify API keys in `.env` or agent configuration

## Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT

## Support

For issues and questions, please open an issue on GitHub.
