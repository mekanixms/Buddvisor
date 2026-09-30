# Changelog

## Unreleased

### Added
- `terminal` agent tool: persistent, named interactive shell sessions (Linux/macOS) confined to the agent's workspace, with a filesystem jail (OS-level via `bwrap` / `sandbox-exec` when available, soft jail otherwise) and a separate `logs/terminal.log`.

### Changed
- Display agent model information from Hugging Face links and OpenRouter for the `x-ai/grok-4.1-fast` model.
- Show agent model info from Hugging Face model links (e.g. `moonshotai/Kimi-K2.5`).
- In session configuration (Tools), improve `local_working_folder` handling: randomize workspace or use the provided folder name.
- Switch `OllamaProvider` to use `ollama-js` instead of Axios.
