#!/bin/sh
# Pre-existing hook script referenced from .claude/settings.json.
exec npx prettier --write "$CLAUDE_FILE_PATH" >/dev/null 2>&1 || true
