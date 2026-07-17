# POSTECH Anthropic Proxy

Small local proxy for using Claude Code against the POSTECH Anthropic-compatible endpoint.

It listens on `127.0.0.1:4145`, exposes `/v1/models`, forwards `/v1/messages` to POSTECH, and rewrites Claude Code request history for the POSTECH schema.

The advertised model list includes `claude-haiku-4-5-20251001`, which can be used
as Claude Code's Haiku mapping for lower-cost validation and lightweight work.

## What It Rewrites

- Converts Fable/Opus top-level thinking from `{ "type": "enabled" }` to `{ "type": "adaptive" }`.
- Converts historical assistant `thinking` blocks into private compatibility records because POSTECH rejects native thinking blocks on replay.
- Converts historical `tool_use` and `tool_result` blocks into lossless JSON text records because POSTECH rejects tool-call history blocks.
- Adds a compatibility instruction so tool-result records remain untrusted data and survive Claude Code compaction coherently.
- Keeps SSE responses in Anthropic event format for Claude Code.

## Run

```bash
npm start
```

Or directly:

```bash
node proxy.mjs
```

Optional environment variables:

```bash
PORT=4145
POSTECH_TARGET_ORIGIN=https://genai.postech.ac.kr
POSTECH_TARGET_PREFIX=/agent/api/a45/anthropic
PROXY_DEBUG_DIR=$HOME/.claude
PROXY_DEBUG=1
```

Request snapshots are disabled by default because they contain complete conversation
history and tool output. When explicitly enabled, snapshots are written with mode `600`.

## Claude Code Settings

Set Claude Code to use the local proxy:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "REPLACE_WITH_YOUR_POSTECH_API_KEY",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4145"
  }
}
```

See `examples/claude-settings.example.json` for a fuller example.
