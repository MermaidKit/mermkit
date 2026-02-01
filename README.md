<p align="center">
  <img src="docs/assets/mermkit-logo.svg" alt="mermkit logo" width="140" />
</p>

# mermkit

Mermaid rendering for terminals, chats, and CI — with agent-friendly tooling.

![CI](https://github.com/MermaidKit/mermkit/actions/workflows/ci.yml/badge.svg)

## Why

Mermaid is great in docs, but it’s painful in:

- terminals (no browser, no SVG rendering)
- chat UIs (bots often return raw Mermaid code without previews)
- CI logs (you want deterministic SVG/PNG artifacts)

`mermkit` turns Mermaid into reliable artifacts and chat-ready payloads across environments.

## Features

- Render Mermaid to **SVG/PNG/PDF/ASCII** (deterministic, pinned versions)
- Terminal output via **inline images** (Kitty/iTerm2/WezTerm) with ASCII/Unicode fallback
- **Chat adapters** for Slack, Discord, GitHub comments
- **Agent-friendly** JSON IPC (`mermkit serve`), batch rendering, tool schemas
- **Preview server** with live reload and engine/theme/format toggles
- **Language bindings**: Python, Go, Rust

## Quickstart

### CLI (from source)

```
# install deps and build
npm install
npm run build

# render to svg
node packages/cli/dist/cli.js render --in examples/basic/diagram.mmd --out diagram.svg

# extract all Mermaid blocks from markdown
node packages/cli/dist/cli.js extract --in examples/basic/diagram.md --out-dir diagrams/

# preview server
node packages/cli/dist/cli.js preview --in examples/basic/diagram.mmd --port 7070
```

### CLI (installed package)

```
# npm (once published)
npm install -g mermkit
mermkit render --in diagram.mmd --out diagram.svg

# npx (once published)
npx mermkit render --in diagram.mmd --out diagram.svg
```

### Python wrapper (preferred in Python)

```
from mermkit import MermkitClient

client = MermkitClient()
client.start()
result = client.render("graph TD; A-->B", format="svg", engine="stub")
client.close()
```

### Agent tool schema

```
node packages/cli/dist/cli.js tool-schema --format openai
```

## CLI usage

```
# installed package
mermkit render --in diagram.mmd --out diagram.svg
mermkit render --stdin --format png --out out.png
mermkit render --in diagram.mmd --format ascii
mermkit extract --in README.md --out-dir diagrams/
mermkit term --in diagram.mmd
mermkit preview --in diagram.mmd --port 7070

# from source
node packages/cli/dist/cli.js render --in examples/basic/diagram.mmd --out diagram.svg
```

## Adapters (Slack/Discord/GitHub)

```
import { formatSlackMessage } from "@mermkit/adapters";

const payload = formatSlackMessage(diagram, {
  image: { bytes, mime: "image/png", filename: "diagram.png" },
  altText: "Checkout flow"
});
```

## Preview server

The preview UI lets you switch **format/theme/engine** at runtime and upload a local file to render.

```
mermkit preview --in diagram.mmd --port 7070
```

## Rendering engines

`mermkit` is engine-agnostic. Built-ins:

- **embedded** (default): `mermaid` + `jsdom`
- **mmdc**: Mermaid CLI (`@mermaid-js/mermaid-cli`)
- **stub**: placeholder SVG (integration/testing)

You can register custom engines at runtime:

```
import { registerEngine } from "@mermkit/render";

registerEngine({
  id: "beautiful-mermaid",
  priority: 40,
  render: async (diagram, options) => {
    // return { bytes, mime, warnings }
  }
});
```

## Agent-friendly workflows

- `mermkit serve` (JSON IPC) for long-running processes
- `renderBatch` to process multiple diagrams in one request
- `tool-schema` for function-calling frameworks
- `--out-manifest` for deterministic artifacts and caching

See `docs/agents.md` for SDK snippets.

## Thanks

ASCII rendering is based on `mermaid-ascii` by Alexander Grooff, ported from Go to TypeScript and extended—thank you, Alexander!

## Repo layout

- `packages/core` — parsing/extraction/validation
- `packages/render` — Mermaid to SVG/PNG/PDF rendering
- `packages/adapters` — Slack/Discord/GitHub chat payloads
- `packages/cli` — `mermkit` command
- `bindings/` — Python/Go/Rust wrappers
- `examples/` — demo apps and bots
- `docs/` — usage, screenshots, recipes


## Contributing

See `CONTRIBUTING.md`.

## License

MIT. See `LICENSE`.
