# Changelog

All notable changes to this project are documented here. The package remains
private until the owner explicitly approves an npm publication.

## Unreleased

### Added

- Installation, update, uninstall, and check for a Product Engineering roster on Claude Code.
- Adaptive execution profiles at configuration schema version 2.
- Capability bindings at schema version 3: GitHub, Linear, Figma, generic existing MCP, and manual, limited to Increment 3 read capabilities.
- Machine-driven `init` setup: `--questions`, `--answers`, and `--expect-digest`.
- Cross-platform CI on Ubuntu and macOS (Node 22.12 and 24). Windows stays fail-closed.

### Changed

- Configuration migrations are comment-preserving, one version at a time. A non-empty legacy `providers` map blocks.

### Security

- wrkrs does not write `.mcp.json`, store credentials, or execute provider CLIs. Repository-derived identifiers are rejected before they can reach a projection.
