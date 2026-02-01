# Rendering engines

The render package is engine-agnostic. It ships with built-in engines, and you can register custom engines at runtime.

## Embedded (default)
Uses the `mermaid` package in-process with a `jsdom` DOM shim. This provides deterministic rendering without spawning external processes.

Optional dependencies:
- `mermaid`
- `jsdom`
- `dompurify` (sanitizer)

Current pinned version:
- `mermaid@10.9.5`

## Mermaid CLI (mmdc)
Uses the Mermaid CLI (`@mermaid-js/mermaid-cli`) via subprocess. This is useful if you already use `mmdc` in CI.

Set `MERMKIT_MMDC_PATH` to point to a custom binary.

## Stub
Produces a placeholder SVG with the Mermaid source as text. Useful for early integration.

## ASCII
A pure-TypeScript ASCII/Unicode renderer. Supports flowcharts (LR and TD directions) and sequence diagrams. Outputs box-drawing characters by default; pass `--ascii` on the CLI for plain ASCII (`+`, `-`, `|`) mode.

This engine is skipped in `auto` mode. Request it explicitly:
- CLI: `--engine ascii` or `--format ascii`
- API: `{ engine: "ascii" }` or `{ format: "ascii" }`

## Custom engines

Register your own engine:

```ts
import { registerEngine, render } from "@mermkit/render";

registerEngine({
  id: "beautiful-mermaid",
  priority: 40,
  render: async (diagram, options) => {
    // return { bytes, mime, warnings }
  }
});

await render(diagram, { format: "svg", engine: "beautiful-mermaid" });
```

`engine: "auto"` will try engines in priority order (highest first).
