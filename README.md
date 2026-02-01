<p align="center">
  <img src="docs/assets/mermkit-logo.svg" alt="mermkit logo" width="140" />
</p>

# mermkit

Mermaid rendering for terminals, chats, and CI — with agent-friendly tooling.

![CI](https://github.com/MermaidKit/mermkit/actions/workflows/ci.yml/badge.svg)
![npm version](https://img.shields.io/npm/v/@mermkit/cli.svg)
![License](https://img.shields.io/github/license/MermaidKit/mermkit.svg)

## What is mermkit?

mermkit orchestrates Mermaid rendering engines — turning their output into the right artifact for wherever you need it: SVG files for docs, inline images for terminals, base64 for chat APIs, PNGs for CI. It wraps engines like `mermaid.js` and the Mermaid CLI rather than reimplementing them.

## Why use it?

Mermaid is a powerful diagramming syntax, but it only renders natively inside a browser. Outside the browser, every other environment is broken by default:

- **Terminals** — `cat diagram.mmd` shows raw code. No diagram.
- **Chat bots** — A Slack or Discord bot posts `graph TD; A-->B`. Nobody can read it.
- **CI/CD pipelines** — You want a PNG of your architecture diagram as a build artifact. There is no standard way to produce one.
- **AI agents** — An LLM generates a Mermaid diagram in its response. How does it become a viewable image? The agent needs a rendering tool to call.

mermkit bridges this gap. It takes Mermaid source and produces the right artifact for whatever environment you are in — SVG files, base64 PNGs for chat APIs, inline images for terminals, or ASCII for plain-text environments. It does this by orchestrating existing rendering engines, not reimplementing them.

**What you get:**

- See diagrams directly in your terminal — no browser needed
- Post rendered previews to Slack, Discord, or GitHub — not raw code
- Generate diagram images in CI — output is stable unless the source changes
- Give AI agents a rendering tool they can actually call — JSON IPC, batch rendering, tool schemas

## Features

- Render Mermaid to **SVG / PNG / PDF / ASCII** with deterministic, pinned engine versions
- Terminal output via **inline images** (Kitty, iTerm2, WezTerm) with ASCII/Unicode fallback
- **Chat adapters** for Slack, Discord, and GitHub comments
- **Agent-friendly** JSON IPC (`mermkit serve`), batch rendering, and tool schemas
- **Preview server** with live reload and engine / theme / format toggles
- **Language bindings** for Python, Go, and Rust

## Install

```bash
# npm — global install
npm install -g @mermkit/cli

# npx — run without installing
npx @mermkit/cli render --in diagram.mmd --out diagram.svg

# pip — Python wrapper
pip install mermkit

# cargo — Rust wrapper
cargo install mermkit
```

## Quickstart

### CLI

```bash
mermkit render --in diagram.mmd --out diagram.svg
mermkit render --stdin --format png --out out.png
mermkit render --in diagram.mmd --format ascii
```

### Python

```python
from mermkit import MermkitClient

client = MermkitClient()
client.start()
result = client.render("graph TD; A-->B", format="svg")
client.close()
```

### TypeScript

```typescript
import { render } from "@mermkit/render";

const result = await render(
  { id: "my-diagram", source: "graph TD; A-->B" },
  { format: "svg" }
);
// result.bytes — Uint8Array of SVG
```

## CLI reference

```bash
mermkit render --in diagram.mmd --out diagram.svg      # render to file
mermkit render --stdin --format png --out out.png       # render stdin to PNG
mermkit render --in diagram.mmd --format ascii          # render to ASCII
mermkit extract --in README.md --out-dir diagrams/      # extract .mmd blocks from markdown
mermkit term --in diagram.mmd                           # render for your terminal
mermkit preview --in diagram.mmd --port 7070            # live preview server
mermkit doctor                                          # check engines and terminal caps
mermkit serve                                           # JSON IPC mode (long-running)
mermkit mcp                                             # MCP server over stdio
mermkit tool-schema --format openai                     # print tool schema for agents
```

## Rendering engines

mermkit is engine-agnostic. It tries available engines in priority order when `engine` is set to `auto` (the default).

| Engine | What it uses | Formats | Notes |
|--------|-------------|---------|-------|
| `embedded` (default) | `mermaid` + `jsdom`, in-process | SVG, PNG, PDF | Scale option not yet implemented |
| `mmdc` | `@mermaid-js/mermaid-cli` subprocess | SVG, PNG, PDF | Set `MERMKIT_MMDC_PATH` for a custom binary path |
| `ascii` | Custom TypeScript renderer | ASCII text | Flowcharts and sequence diagrams; skipped in `auto` mode |
| `stub` | Placeholder | SVG | Test double only — returns source as text, not a real diagram |

Register a custom engine at runtime:

```typescript
import { registerEngine } from "@mermkit/render";

registerEngine({
  id: "beautiful-mermaid",
  priority: 40,
  render: async (diagram, options) => {
    // return { bytes, mime, warnings }
  }
});
```

## Chat adapters

Format a rendered diagram for Slack, Discord, or GitHub in one call:

```typescript
import { formatSlackMessage } from "@mermkit/adapters";

const payload = formatSlackMessage(diagram, {
  image: { bytes, mime: "image/png", filename: "diagram.png" },
  altText: "Checkout flow"
});
```

`formatForChat` dispatches automatically based on the target platform. Pass the rendered bytes and the adapter handles base64 encoding, MIME types, and platform-specific payload shape.

## Language bindings

Each binding spawns `mermkit serve` under the hood and communicates over JSON IPC.

```bash
# Python
pip install mermkit

# Go
go install github.com/MermaidKit/mermkit/bindings/go@latest

# Rust
cargo install mermkit
```

## AI agent integration

### How it works

`mermkit serve` reads newline-delimited JSON from stdin and writes responses to stdout. An agent wrapper (or an LLM tool-call handler) spawns the process once, then sends render / extract / batch requests as JSON objects. No HTTP server, no shared filesystem — just stdin/stdout.

### Tool schemas

`mermkit tool-schema --format openai` outputs a JSON array describing five tools that an LLM can call:

| Tool | What it does |
|------|-------------|
| `mermkit.render` | Render one diagram → SVG / PNG / PDF / ASCII |
| `mermkit.renderBatch` | Render multiple diagrams in one request |
| `mermkit.extract` | Pull Mermaid blocks out of markdown text |
| `mermkit.term` | Render for terminal display |
| `mermkit.schema` | Return the tool definitions themselves |

**The flow:** paste the JSON output into your LLM's `tools` parameter. When the LLM wants to render a diagram it returns a structured call like:

```json
{
  "name": "mermkit.render",
  "arguments": {
    "diagram": "graph TD; A-->B",
    "options": { "format": "svg" }
  }
}
```

Your code takes those arguments, calls mermkit, and sends the result back. The LLM never needs to know how rendering works.

### MCP compatibility

mermkit ships an MCP server over stdio. Any MCP-compatible host can use it directly.

**MCP host configuration (example):**

```json
{
  "mcpServers": {
    "mermkit": {
      "command": "npx",
      "args": ["-y", "@mermkit/cli@0.2.3", "mcp"]
    }
  }
}
```

Once connected, the host gains access to the same five tools listed above. For hosts that restrict tool names, they are exposed as `mermkit_render`, `mermkit_renderBatch`, `mermkit_extract`, `mermkit_term`, and `mermkit_schema`. The MCP server reuses the same rendering and extraction logic as `serve` — it is a format translation layer (JSON-RPC 2.0) with no additional dependencies.

## Preview server

The preview UI lets you switch format, theme, and engine at runtime and upload a local file to render. It watches the source file for changes and reloads automatically.

```bash
mermkit preview --in diagram.mmd --port 7070
```

## Repo layout

- `packages/core` — parsing / extraction / validation
- `packages/render` — Mermaid to SVG / PNG / PDF rendering
- `packages/adapters` — Slack / Discord / GitHub chat payloads
- `packages/cli` — `mermkit` command
- `bindings/` — Python / Go / Rust wrappers
- `examples/` — demo apps and bots
- `docs/` — usage, screenshots, recipes

## Thanks

ASCII rendering is based on [`mermaid-ascii`](https://github.com/AlexanderGrooff/mermaid-ascii) by Alexander Grooff, ported from Go to TypeScript and extended — thank you, Alexander!

## Contributing

See `CONTRIBUTING.md`.

## License

MIT. See `LICENSE`.
