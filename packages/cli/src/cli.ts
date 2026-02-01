#!/usr/bin/env node

import { readFileSync, watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
import { stdin, stdout, stderr, exit, env } from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { extractDiagrams, normalizeDiagram } from "@mermkit/core";
import { render, renderForTerminal } from "@mermkit/render";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

type Flags = Record<string, string | boolean>;

const [command, ...rest] = process.argv.slice(2);
const { flags } = parseArgs(rest);

if (!command || isHelp(command, flags)) {
  printHelp();
  exit(0);
}

main().catch((error) => {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
});

async function main(): Promise<void> {
  switch (command) {
    case "render":
      await cmdRender(flags);
      return;
    case "extract":
      await cmdExtract(flags);
      return;
    case "term":
      await cmdTerm(flags);
      return;
    case "doctor":
      await cmdDoctor(flags);
      return;
    case "serve":
      await cmdServe(flags);
      return;
    case "preview":
      await cmdPreview(flags);
      return;
    case "tool-schema":
      await cmdToolSchema(flags);
      return;
    case "mcp":
      await cmdMcp();
      return;
    default:
      stderr.write(`unknown command: ${command}\n`);
      printHelp();
      exit(1);
  }
}

async function cmdRender(flags: Flags): Promise<void> {
  const format = getFlag(flags, "format") ?? "svg";
  if (format === "term") {
    await cmdTerm(flags);
    return;
  }

  const input = await readInput(flags);
  const outPath = getFlag(flags, "out");
  const outDir = getFlag(flags, "out-dir") ?? getFlag(flags, "outDir");
  const quiet = Boolean(flags.quiet);
  const asJson = Boolean(flags.json);
  const manifestPath = getFlag(flags, "out-manifest");

  const diagrams = extractDiagrams(input);
  const list = diagrams.length > 0 ? diagrams : [selectDiagram(input)];

  if (list.length > 1 && !outDir) {
    throw new Error("multiple diagrams detected; use --out-dir to render all");
  }

  if (outDir) {
    await ensureDir(outDir);
    const outputs: string[] = [];
    const manifestEntries: ManifestEntry[] = [];
    for (const diagram of list) {
      const result = await renderDiagram(diagram, format, flags);
      const filename = `${diagram.id}.${format}`;
      const fullPath = join(outDir, filename);
      await writeFile(fullPath, result.bytes);
      outputs.push(fullPath);
      manifestEntries.push({
        id: diagram.id,
        inputHash: hashDiagram(diagram.source),
        output: fullPath,
        format,
        mime: result.mime,
        warnings: result.warnings
      });
      if (!quiet && result.warnings.length > 0) {
        stderr.write(result.warnings.map((warning) => `warning: ${warning}`).join("\n") + "\n");
      }
    }
    if (asJson) {
      stdout.write(`${JSON.stringify({ format, files: outputs })}\n`);
    } else if (!quiet) {
      stdout.write(outputs.map((file) => `${file}\n`).join(""));
    }
    if (manifestPath) {
      await writeManifest(manifestPath, manifestEntries);
    }
    return;
  }

  const diagram = list[0];
  const result = await renderDiagram(diagram, format, flags);

  if (outPath) {
    await ensureDir(dirname(outPath));
    await writeFile(outPath, result.bytes);
    if (manifestPath) {
      await writeManifest(manifestPath, [
        {
          id: diagram.id,
          inputHash: hashDiagram(diagram.source),
          output: outPath,
          format,
          mime: result.mime,
          warnings: result.warnings
        }
      ]);
    }
  } else if (!asJson) {
    stdout.write(Buffer.from(result.bytes));
  }

  if (!quiet && result.warnings.length > 0) {
    stderr.write(result.warnings.map((warning) => `warning: ${warning}`).join("\n") + "\n");
  }

  if (asJson) {
    const payload = {
      format,
      out: outPath,
      bytes: outPath ? undefined : Buffer.from(result.bytes).toString("base64"),
      mime: result.mime,
      warnings: result.warnings
    };
    stdout.write(`${JSON.stringify(payload)}\n`);
  }

  if (!outPath && !outDir && manifestPath) {
    await writeManifest(manifestPath, [
      {
        id: diagram.id,
        inputHash: hashDiagram(diagram.source),
        output: "<stdout>",
        format,
        mime: result.mime,
        warnings: result.warnings
      }
    ]);
  }
}

async function cmdExtract(flags: Flags): Promise<void> {
  const input = await readInput(flags);
  const diagrams = extractDiagrams(input);
  const outDir = getFlag(flags, "out-dir") ?? getFlag(flags, "outDir");
  const quiet = Boolean(flags.quiet);

  if (!outDir) {
    throw new Error("extract requires --out-dir");
  }

  await ensureDir(outDir);
  const outputs: string[] = [];

  for (const diagram of diagrams) {
    const filename = `${diagram.id}.mmd`;
    const fullPath = join(outDir, filename);
    await writeFile(fullPath, diagram.source, "utf8");
    outputs.push(fullPath);
  }

  if (flags.json) {
    stdout.write(`${JSON.stringify({ count: outputs.length, files: outputs })}\n`);
    return;
  }

  if (!quiet) {
    stdout.write(outputs.map((file) => `${file}\n`).join(""));
    if (outputs.length === 0) stdout.write("no diagrams found\n");
  }
}

async function cmdToolSchema(flags: Flags): Promise<void> {
  const format = getFlag(flags, "format") ?? "generic";
  const schema = buildToolSchema(format);
  stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
}

async function cmdTerm(flags: Flags): Promise<void> {
  const input = await readInput(flags);
  const diagram = selectDiagram(input);
  const result = await renderForTerminal(diagram, detectCapabilities(), {
    preferAscii: Boolean(flags.ascii)
  });

  if (result.text) stdout.write(`${result.text}\n`);
  if (!flags.quiet && result.warnings.length > 0) {
    stderr.write(result.warnings.map((warning) => `warning: ${warning}`).join("\n") + "\n");
  }
}

async function cmdDoctor(flags: Flags): Promise<void> {
  const embedded = await checkEmbedded();
  const mmdc = await checkMmdc();
  const sharp = await hasModule("sharp");
  const terminal = detectCapabilities();

  const payload = {
    engines: {
      embedded,
      mmdc,
      sharp: { ok: sharp }
    },
    terminal,
    node: process.version,
    platform: process.platform
  };

  if (flags.json) {
    stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  stdout.write("mermkit doctor\n\n");
  stdout.write(`node: ${payload.node}\n`);
  stdout.write(`platform: ${payload.platform}\n\n`);
  stdout.write("engines:\n");
  stdout.write(`  embedded: ${embedded.ok ? "ok" : "missing"} (mermaid=${embedded.mermaid}, jsdom=${embedded.jsdom}, dompurify=${embedded.dompurify})\n`);
  stdout.write(`  mmdc: ${mmdc.ok ? `ok (${mmdc.path})` : "missing"}\n`);
  stdout.write(`  sharp: ${sharp ? "ok" : "missing"}\n\n`);
  stdout.write("terminal:\n");
  stdout.write(`  kitty: ${terminal.kitty ? "yes" : "no"}\n`);
  stdout.write(`  iterm2: ${terminal.iterm2 ? "yes" : "no"}\n`);
  stdout.write(`  wezterm: ${terminal.wezterm ? "yes" : "no"}\n`);
  stdout.write(`  unicode: ${terminal.unicode ? "yes" : "no"}\n`);
}

async function cmdPreview(flags: Flags): Promise<void> {
  const inputPath = getFlag(flags, "in");
  const useStdin = Boolean(flags.stdin);
  if (!inputPath && !useStdin) {
    throw new Error("preview requires --in <file> or --stdin");
  }

  const initialSource = useStdin ? await readStdin() : await readFile(inputPath!, "utf8");
  let fileSource = initialSource;
  let source = initialSource;
  let sourceMode: "file" | "manual" = useStdin ? "manual" : "file";
  let lastError: string | null = null;
  let lastUpdated = Date.now();

  if (inputPath) {
    const watcher = watch(inputPath, { persistent: true }, async () => {
      try {
        fileSource = await readFile(inputPath, "utf8");
        if (sourceMode === "file") {
          source = fileSource;
          lastError = null;
          lastUpdated = Date.now();
        }
      } catch (error) {
        lastError = errorMessage(error);
      }
    });
    process.on("exit", () => watcher.close());
  }

  const defaultFormat = (getFlag(flags, "format") ?? "svg") as "svg" | "png";
  if (defaultFormat !== "svg" && defaultFormat !== "png") {
    throw new Error("preview supports only svg or png output");
  }

  const host = getFlag(flags, "host") ?? "127.0.0.1";
  const port = parseNumber(getFlag(flags, "port")) ?? 7070;
  const defaultTheme = (getFlag(flags, "theme") as "light" | "dark" | "custom" | undefined) ?? undefined;
  const scale = parseNumber(getFlag(flags, "scale"));
  const background = getFlag(flags, "background") ?? "transparent";
  const defaultEngine = getFlag(flags, "engine") ?? undefined;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>mermkit preview</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #111; color: #f2f2f2; }
      header { padding: 12px 16px; font-size: 14px; background: #1a1a1a; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
      header strong { font-weight: 600; }
      #status { opacity: 0.7; }
      label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: #b5b5b5; }
      select { background: #121212; color: #f2f2f2; border: 1px solid #333; border-radius: 6px; padding: 4px 8px; font-size: 13px; }
      button { background: #202020; color: #f2f2f2; border: 1px solid #333; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
      button:disabled { opacity: 0.4; cursor: default; }
      input[type="file"] { color: #b5b5b5; font-size: 12px; }
      main { padding: 16px; }
      img { max-width: 100%; height: auto; display: block; border: 1px solid #333; background: #fff; }
      .error { color: #ff9b9b; }
    </style>
  </head>
  <body>
    <header>
      <strong>mermkit preview</strong>
      <label>format
        <select id="format">
          <option value="svg">svg</option>
          <option value="png">png</option>
        </select>
      </label>
      <label>theme
        <select id="theme">
          <option value="">default</option>
          <option value="light">light</option>
          <option value="dark">dark</option>
          <option value="custom">custom</option>
        </select>
      </label>
      <label>engine
        <select id="engine">
          <option value="">auto</option>
          <option value="embedded">embedded</option>
          <option value="mmdc">mmdc</option>
          <option value="ascii">ascii</option>
          <option value="stub">stub</option>
        </select>
      </label>
      <label>preset
        <select id="preset">
          <option value="">custom</option>
          <option value="light">light</option>
          <option value="dark">dark</option>
        </select>
      </label>
      <label>file
        <input id="file" type="file" accept=".mmd,.md,.mdx,.markdown,.txt" />
      </label>
      <button id="reset" type="button">use watched file</button>
      <div id="status">loading…</div>
    </header>
    <main>
      <img id="diagram" alt="diagram preview" />
    </main>
    <script>
      const img = document.getElementById("diagram");
      const statusEl = document.getElementById("status");
      const formatEl = document.getElementById("format");
      const themeEl = document.getElementById("theme");
      const engineEl = document.getElementById("engine");
      const presetEl = document.getElementById("preset");
      const fileEl = document.getElementById("file");
      const resetEl = document.getElementById("reset");
      const canReset = ${JSON.stringify(Boolean(inputPath))};
      const state = {
        format: ${JSON.stringify(defaultFormat)},
        theme: ${JSON.stringify(defaultTheme ?? "")},
        engine: ${JSON.stringify(defaultEngine ?? "")}
      };

      formatEl.value = state.format;
      themeEl.value = state.theme;
      engineEl.value = state.engine;
      resetEl.disabled = !canReset;

      function buildParams() {
        const params = new URLSearchParams();
        if (state.format) params.set("format", state.format);
        if (state.theme) params.set("theme", state.theme);
        if (state.engine) params.set("engine", state.engine);
        return params;
      }

      function onChange() {
        state.format = formatEl.value;
        state.theme = themeEl.value;
        state.engine = engineEl.value;
        refresh();
      }

      formatEl.addEventListener("change", onChange);
      themeEl.addEventListener("change", onChange);
      engineEl.addEventListener("change", onChange);
      presetEl.addEventListener("change", () => {
        const value = presetEl.value;
        if (value === "light" || value === "dark") {
          themeEl.value = value;
        } else {
          themeEl.value = "";
        }
        onChange();
      });

      fileEl.addEventListener("change", async () => {
        const file = fileEl.files && fileEl.files[0];
        if (!file) return;
        const text = await file.text();
        await fetch("/source", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: text })
        });
        refresh();
      });

      resetEl.addEventListener("click", async () => {
        if (!canReset) return;
        await fetch("/reset", { method: "POST" });
        refresh();
      });

      async function refresh() {
        const params = buildParams();
        params.set("ts", Date.now());
        img.src = "/diagram?" + params.toString();
        try {
          const res = await fetch("/status");
          const data = await res.json();
          if (data.ok) {
            const mode = data.mode ? " (" + data.mode + ")" : "";
            statusEl.textContent = "updated " + new Date(data.updatedAt).toLocaleTimeString() + mode;
            statusEl.className = "";
          } else {
            statusEl.textContent = data.error || "render error";
            statusEl.className = "error";
          }
        } catch (err) {
          statusEl.textContent = "preview server error";
          statusEl.className = "error";
        }
      }
      setInterval(refresh, 1000);
      refresh();
    </script>
  </body>
</html>`;

  const server = createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end("missing url");
      return;
    }
    const url = new URL(req.url, `http://${host}:${port}`);
    if (url.pathname === "/diagram") {
      res.setHeader("Cache-Control", "no-store");
      if (lastError) {
        res.statusCode = 500;
        res.end(lastError);
        return;
      }
      try {
        const formatParam = url.searchParams.get("format") ?? defaultFormat;
        const themeParam = url.searchParams.get("theme") ?? defaultTheme ?? "";
        const engineParam = url.searchParams.get("engine");
        const format = formatParam === "png" ? "png" : "svg";
        const theme =
          themeParam === "light" || themeParam === "dark" || themeParam === "custom"
            ? themeParam
            : undefined;
        const engine = (engineParam ?? defaultEngine) || undefined;
        const diagram = selectDiagram(source);
        const result = await render(diagram, { format, theme, scale, background, engine });
        res.statusCode = 200;
        res.setHeader("Content-Type", result.mime);
        res.end(Buffer.from(result.bytes));
        lastError = null;
        return;
      } catch (error) {
        lastError = errorMessage(error);
        res.statusCode = 500;
        res.end(lastError);
        return;
      }
    }

    if (url.pathname === "/source" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf8");
          let nextSource: string | null = null;
          try {
            const payload = JSON.parse(body) as { source?: string };
            if (payload.source) nextSource = payload.source;
          } catch {
            nextSource = body;
          }
          if (!nextSource) {
            res.statusCode = 400;
            res.end("missing source");
            return;
          }
          source = nextSource;
          sourceMode = "manual";
          lastError = null;
          lastUpdated = Date.now();
          res.statusCode = 200;
          res.end("ok");
        } catch (error) {
          res.statusCode = 400;
          res.end(errorMessage(error));
        }
      });
      return;
    }

    if (url.pathname === "/reset" && req.method === "POST") {
      if (!inputPath) {
        res.statusCode = 400;
        res.end("no watched file");
        return;
      }
      source = fileSource;
      sourceMode = "file";
      lastError = null;
      lastUpdated = Date.now();
      res.statusCode = 200;
      res.end("ok");
      return;
    }

    if (url.pathname === "/status") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          ok: !lastError,
          error: lastError,
          updatedAt: lastUpdated,
          mode: sourceMode
        })
      );
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  });

  server.listen(port, host, () => {
    stdout.write(`preview: http://${host}:${port}\n`);
    if (inputPath) stdout.write(`watching: ${inputPath}\n`);
  });
}

type ServeRequest =
  | {
      id?: string;
      action: "render";
      diagram: string;
      options?: {
        format?: "svg" | "png" | "pdf";
        theme?: "light" | "dark" | "custom";
        scale?: number;
        background?: "transparent" | string;
        engine?: string;
      };
    }
  | {
      id?: string;
      action: "renderBatch";
      diagrams: Array<{ id?: string; source: string }>;
      options?: {
        format?: "svg" | "png" | "pdf";
        theme?: "light" | "dark" | "custom";
        scale?: number;
        background?: "transparent" | string;
        engine?: string;
      };
    }
  | {
      id?: string;
      action: "extract";
      markdown: string;
    }
  | {
      id?: string;
      action: "term";
      diagram: string;
    }
  | {
      id?: string;
      action: "schema";
      format?: string;
    };

type ServeResponse = {
  id?: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

async function cmdServe(_flags: Flags): Promise<void> {
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let request: ServeRequest;
    try {
      request = JSON.parse(trimmed) as ServeRequest;
    } catch (error) {
      writeServeResponse({ ok: false, error: `invalid JSON: ${errorMessage(error)}` });
      continue;
    }

    const id = request.id;
    try {
      if (request.action === "render") {
        const options = request.options ?? {};
        const diagram = { id: id ?? "diagram-1", source: normalizeDiagram(request.diagram) };
        const result = await render(diagram, {
          format: options.format ?? "svg",
          theme: options.theme,
          scale: options.scale,
          background: options.background ?? "transparent",
          engine: options.engine
        });
        writeServeResponse({
          id,
          ok: true,
          result: {
            mime: result.mime,
            warnings: result.warnings,
            bytes: Buffer.from(result.bytes).toString("base64")
          }
        });
        continue;
      }

      if (request.action === "renderBatch") {
        const options = request.options ?? {};
        const results: Array<{ id: string; ok: boolean; result?: { mime: string; warnings: string[]; bytes: string }; error?: string }> = [];
        for (const item of request.diagrams) {
          const diagramId = item.id ?? `diagram-${results.length + 1}`;
          try {
            const diagram = { id: diagramId, source: normalizeDiagram(item.source) };
            const result = await render(diagram, {
              format: options.format ?? "svg",
              theme: options.theme,
              scale: options.scale,
              background: options.background ?? "transparent",
              engine: options.engine
            });
            results.push({
              id: diagramId,
              ok: true,
              result: {
                mime: result.mime,
                warnings: result.warnings,
                bytes: Buffer.from(result.bytes).toString("base64")
              }
            });
          } catch (error) {
            results.push({
              id: diagramId,
              ok: false,
              error: errorMessage(error)
            });
          }
        }
        writeServeResponse({
          id,
          ok: true,
          result: {
            results
          }
        });
        continue;
      }

      if (request.action === "extract") {
        const diagrams = extractDiagrams(request.markdown);
        writeServeResponse({
          id,
          ok: true,
          result: {
            diagrams
          }
        });
        continue;
      }

      if (request.action === "term") {
        const diagram = { id: id ?? "diagram-1", source: normalizeDiagram(request.diagram) };
        const result = await renderForTerminal(diagram, detectCapabilities());
        writeServeResponse({
          id,
          ok: true,
          result: {
            text: result.text,
            mime: result.mime,
            warnings: result.warnings,
            bytes: result.imageBytes ? Buffer.from(result.imageBytes).toString("base64") : undefined
          }
        });
        continue;
      }

      if (request.action === "schema") {
        const schema = buildToolSchema(request.format ?? "generic");
        writeServeResponse({
          id,
          ok: true,
          result: schema
        });
        continue;
      }

      writeServeResponse({ id, ok: false, error: "unknown action" });
    } catch (error) {
      writeServeResponse({ id, ok: false, error: errorMessage(error) });
    }
  }
}

function writeServeResponse(response: ServeResponse): void {
  stdout.write(`${JSON.stringify(response)}\n`);
}

async function cmdMcp(): Promise<void> {
  const server = new McpServer({ name: "mermkit", version: PACKAGE_VERSION });

  const renderOptionsSchema = z
    .object({
      format: z.enum(["svg", "png", "pdf", "ascii"]).optional(),
      theme: z.enum(["light", "dark", "custom"]).optional(),
      scale: z.number().optional(),
      background: z.string().optional(),
      engine: z.string().optional(),
      includeDataUri: z.boolean().optional()
    })
    .partial();

  const toolError = (error: unknown): { isError: true; content: ContentBlock[] } => ({
    isError: true,
    content: [{ type: "text", text: `error: ${errorMessage(error)}` }]
  });

  server.registerTool(
    "mermkit_render",
    {
      description: "Render a Mermaid diagram to svg/png/pdf/ascii.",
      inputSchema: {
        diagram: z.string(),
        options: renderOptionsSchema.optional()
      }
    },
    async (input) => {
      try {
        return { content: await executeMcpTool("mermkit.render", input as Record<string, unknown>) };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "mermkit_renderBatch",
    {
      description: "Render multiple Mermaid diagrams in a single request.",
      inputSchema: {
        diagrams: z.array(
          z.object({
            id: z.string().optional(),
            source: z.string()
          })
        ),
        options: renderOptionsSchema.optional()
      }
    },
    async (input) => {
      try {
        return { content: await executeMcpTool("mermkit.renderBatch", input as Record<string, unknown>) };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "mermkit_extract",
    {
      description: "Extract Mermaid blocks from markdown.",
      inputSchema: {
        markdown: z.string()
      }
    },
    async (input) => {
      try {
        return { content: await executeMcpTool("mermkit.extract", input as Record<string, unknown>) };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "mermkit_term",
    {
      description: "Render a Mermaid diagram for terminal display.",
      inputSchema: {
        diagram: z.string()
      }
    },
    async (input) => {
      try {
        return { content: await executeMcpTool("mermkit.term", input as Record<string, unknown>) };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "mermkit_schema",
    {
      description: "Return tool schema for mermkit actions.",
      inputSchema: {
        format: z.enum(["generic", "openai"]).optional()
      }
    },
    async (input) => {
      try {
        return { content: await executeMcpTool("mermkit.schema", input as Record<string, unknown>) };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function executeMcpTool(name: string, input: Record<string, unknown>): Promise<ContentBlock[]> {
  if (name === "mermkit.render") {
    if (typeof input.diagram !== "string") {
      throw new Error("diagram is required and must be a string");
    }
    const source = input.diagram;
    const options = (input.options ?? {}) as Record<string, unknown>;
    const diagram = { id: "diagram-1", source: normalizeDiagram(source) };
    const result = await render(diagram, {
      format: (options.format as "svg" | "png" | "pdf" | "ascii") ?? "svg",
      theme: options.theme as "light" | "dark" | "custom" | undefined,
      scale: options.scale as number | undefined,
      background: (options.background as string) ?? "transparent",
      engine: options.engine as string | undefined
    });
    const format = (options.format as string) ?? "svg";
    if (format === "ascii") {
      return [{ type: "text", text: new TextDecoder().decode(result.bytes) }];
    }
    const mimeType = result.mime ?? "application/octet-stream";
    const data = Buffer.from(result.bytes).toString("base64");
    const content: ContentBlock[] = [{ type: "image", data, mimeType }];
    if (options.includeDataUri === true) {
      content.push({ type: "text", text: `![mermkit diagram](data:${mimeType};base64,${data})` });
    }
    return content;
  }

  if (name === "mermkit.renderBatch") {
    if (!Array.isArray(input.diagrams)) {
      throw new Error("diagrams is required and must be an array");
    }
    const diagrams = input.diagrams as Array<{ id?: string; source?: string }>;
    const options = (input.options ?? {}) as Record<string, unknown>;
    const results: ContentBlock[] = [];
    for (let i = 0; i < diagrams.length; i++) {
      const item = diagrams[i];
      const diagramId = item.id ?? `diagram-${i + 1}`;
      try {
        if (typeof item.source !== "string") {
          throw new Error("diagram source must be a string");
        }
        const diagram = { id: diagramId, source: normalizeDiagram(item.source) };
        const result = await render(diagram, {
          format: (options.format as "svg" | "png" | "pdf" | "ascii") ?? "svg",
          theme: options.theme as "light" | "dark" | "custom" | undefined,
          scale: options.scale as number | undefined,
          background: (options.background as string) ?? "transparent",
          engine: options.engine as string | undefined
        });
        const format = (options.format as string) ?? "svg";
        if (format === "ascii") {
          results.push({ type: "text", text: `[${diagramId}]\n${new TextDecoder().decode(result.bytes)}` });
        } else {
          const mimeType = result.mime ?? "application/octet-stream";
          const data = Buffer.from(result.bytes).toString("base64");
          results.push({ type: "image", data, mimeType });
          if (options.includeDataUri === true) {
            results.push({ type: "text", text: `[${diagramId}] ![mermkit diagram](data:${mimeType};base64,${data})` });
          }
        }
      } catch (error) {
        results.push({ type: "text", text: `[${diagramId}] error: ${errorMessage(error)}` });
      }
    }
    return results;
  }

  if (name === "mermkit.extract") {
    if (typeof input.markdown !== "string") {
      throw new Error("markdown is required and must be a string");
    }
    const markdown = input.markdown;
    const diagrams = extractDiagrams(markdown);
    const text = diagrams.map((d) => `[${d.id}]\n${d.source}`).join("\n\n");
    return [{ type: "text", text: text || "no diagrams found" }];
  }

  if (name === "mermkit.term") {
    if (typeof input.diagram !== "string") {
      throw new Error("diagram is required and must be a string");
    }
    const source = input.diagram;
    const diagram = { id: "diagram-1", source: normalizeDiagram(source) };
    const result = await renderForTerminal(diagram, detectCapabilities());
    return [{ type: "text", text: result.text ?? "unable to render for terminal" }];
  }

  if (name === "mermkit.schema") {
    const format = (input.format as string) ?? "generic";
    const schema = buildToolSchema(format);
    return [{ type: "text", text: JSON.stringify(schema, null, 2) }];
  }

  throw new Error(`unknown tool: ${name}`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function selectDiagram(input: string) {
  const diagrams = extractDiagrams(input);
  if (diagrams.length > 0) return diagrams[0];
  return { id: "diagram-1", source: normalizeDiagram(input) };
}

async function renderDiagram(diagram: { id: string; source: string }, format: string, flags: Flags) {
  const asciiOptions: Record<string, unknown> = {};
  if (flags.ascii) asciiOptions.useAscii = true;
  if (flags.coords) asciiOptions.showCoords = true;
  const paddingX = parseNumber(getFlag(flags, "padding-x"));
  if (paddingX !== undefined) asciiOptions.paddingBetweenX = paddingX;
  const paddingY = parseNumber(getFlag(flags, "padding-y"));
  if (paddingY !== undefined) asciiOptions.paddingBetweenY = paddingY;
  const borderPadding = parseNumber(getFlag(flags, "border-padding"));
  if (borderPadding !== undefined) asciiOptions.boxBorderPadding = borderPadding;

  try {
    return await render(diagram as { id: string; source: string }, {
      format: format as "svg" | "png" | "pdf" | "ascii",
      theme: (getFlag(flags, "theme") as "light" | "dark" | "custom" | undefined) ?? undefined,
      scale: parseNumber(getFlag(flags, "scale")),
      background: getFlag(flags, "background") ?? "transparent",
      engine: getFlag(flags, "engine") ?? undefined,
      ascii: asciiOptions
    });
  } catch (error) {
    if (format === "ascii" || format === "term") throw error;
    const fallback = await render(diagram as { id: string; source: string }, {
      format: "ascii",
      ascii: asciiOptions
    });
    fallback.warnings.unshift(`render failed; falling back to ASCII: ${errorMessage(error)}`);
    return fallback;
  }
}

async function readInput(flags: Flags): Promise<string> {
  const inputPath = getFlag(flags, "in");
  const useStdin = Boolean(flags.stdin);
  if (useStdin) return readStdin();
  if (inputPath) return readFile(inputPath, "utf8");
  throw new Error("input required: pass --in <file> or --stdin");
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      data += chunk;
    });
    stdin.on("end", () => resolve(data));
    stdin.on("error", (err) => reject(err));
  });
}

function buildToolSchema(format: string): unknown {
  const normalized = format === "openai" ? "openai" : "generic";
  const tools = buildToolDefinitions();

  if (normalized === "openai") {
    return tools.map((tool) => ({
      type: "function",
      function: tool
    }));
  }

  return {
    format: "generic",
    tools
  };
}

function buildToolDefinitions(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  const renderOptionsSchema = {
    type: "object",
    properties: {
      format: { type: "string", enum: ["svg", "png", "pdf", "ascii"] },
      theme: { type: "string", enum: ["light", "dark", "custom"] },
      scale: { type: "number" },
      background: { type: "string" },
      engine: { type: "string" },
      includeDataUri: { type: "boolean", description: "Include a data URI text block for chat rendering." }
    }
  };

  return [
    {
      name: "mermkit.render",
      description: "Render a Mermaid diagram to svg/png/pdf/ascii.",
      parameters: {
        type: "object",
        properties: {
          diagram: { type: "string", description: "Mermaid source text" },
          options: renderOptionsSchema
        },
        required: ["diagram"]
      }
    },
    {
      name: "mermkit.renderBatch",
      description: "Render multiple Mermaid diagrams in a single request.",
      parameters: {
        type: "object",
        properties: {
          diagrams: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                source: { type: "string" }
              },
              required: ["source"]
            }
          },
          options: renderOptionsSchema
        },
        required: ["diagrams"]
      }
    },
    {
      name: "mermkit.extract",
      description: "Extract Mermaid blocks from markdown.",
      parameters: {
        type: "object",
        properties: {
          markdown: { type: "string" }
        },
        required: ["markdown"]
      }
    },
    {
      name: "mermkit.term",
      description: "Render a Mermaid diagram for terminal display.",
      parameters: {
        type: "object",
        properties: {
          diagram: { type: "string" }
        },
        required: ["diagram"]
      }
    },
    {
      name: "mermkit.schema",
      description: "Return tool schema for mermkit actions.",
      parameters: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["generic", "openai"] }
        }
      }
    }
  ];
}

type ManifestEntry = {
  id: string;
  inputHash: string;
  output: string;
  format: string;
  mime: string;
  warnings: string[];
};

function hashDiagram(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function writeManifest(path: string, entries: ManifestEntry[]): Promise<void> {
  const payload = {
    count: entries.length,
    entries
  };
  await ensureDir(dirname(path));
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function parseArgs(argv: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const trimmed = arg.slice(2);
      const eq = trimmed.indexOf("=");
      if (eq !== -1) {
        const key = trimmed.slice(0, eq);
        const value = trimmed.slice(eq + 1);
        flags[key] = value;
        continue;
      }

      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags[trimmed] = next;
        i += 1;
      } else {
        flags[trimmed] = true;
      }
      continue;
    }

    if (arg.startsWith("-")) {
      if (arg === "-h") flags.help = true;
      if (arg === "-q") flags.quiet = true;
      continue;
    }

    positional.push(arg);
  }

  return { flags, positional };
}

function getFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined || value === true) return undefined;
  return value as string;
}

function parseNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isHelp(command: string | undefined, flags: Flags): boolean {
  if (!command) return true;
  if (command === "help") return true;
  if (flags.help) return true;
  if (command === "--help") return true;
  return false;
}

async function ensureDir(path: string): Promise<void> {
  if (!path || path === ".") return;
  await mkdir(path, { recursive: true });
}

function detectCapabilities() {
  const termProgram = env.TERM_PROGRAM ?? "";
  const term = env.TERM ?? "";
  const lang = env.LANG ?? "";
  return {
    kitty: Boolean(env.KITTY_WINDOW_ID) || term.includes("xterm-kitty"),
    iterm2: termProgram === "iTerm.app",
    wezterm: termProgram === "WezTerm",
    unicode: lang.toLowerCase().includes("utf-8")
  };
}

async function checkEmbedded(): Promise<{ ok: boolean; mermaid: boolean; jsdom: boolean; dompurify: boolean }> {
  const mermaid = await hasModule("mermaid");
  const jsdom = await hasModule("jsdom");
  const dompurify = await hasModule("dompurify");
  return { ok: mermaid && jsdom, mermaid, jsdom, dompurify };
}

async function hasModule(name: string): Promise<boolean> {
  try {
    await import(name);
    return true;
  } catch {
    return false;
  }
}

async function checkMmdc(): Promise<{ ok: boolean; path?: string }> {
  const envPath = env.MERMKIT_MMDC_PATH;
  const candidates: string[] = [];
  if (envPath) candidates.push(envPath);
  const repoRoot = guessRepoRoot();
  if (repoRoot) candidates.push(join(repoRoot, "node_modules", ".bin", "mmdc"));
  candidates.push(join(process.cwd(), "node_modules", ".bin", "mmdc"));
  candidates.push("mmdc");

  for (const candidate of candidates) {
    const ok = await canRun(candidate, ["-h"]);
    if (ok) return { ok: true, path: candidate };
  }

  return { ok: false };
}

function canRun(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function guessRepoRoot(): string | null {
  const current = fileURLToPath(import.meta.url);
  return join(dirname(current), "..", "..", "..");
}

function printHelp(): void {
  const name = basename(process.argv[1] ?? "mermkit");
  stdout.write(
    `mermkit CLI\n\n` +
      `Usage:\n` +
      `  ${name} render --in diagram.mmd --out diagram.svg\n` +
      `  ${name} render --stdin --format png --out out.png\n` +
      `  ${name} extract --in README.md --out-dir diagrams/\n` +
      `  ${name} term --in diagram.mmd\n\n` +
      `  ${name} preview --in diagram.mmd --port 7070\n\n` +
      `  ${name} tool-schema --format openai\n\n` +
      `  ${name} doctor\n` +
      `  ${name} serve  (JSON over stdin/stdout)\n` +
      `  ${name} mcp    (Model Context Protocol server over stdio)\n\n` +
      `Commands:\n` +
      `  render   Render a diagram to svg/png/pdf/ascii\n` +
      `  extract  Extract fenced mermaid blocks from markdown\n` +
      `  term     Terminal-friendly rendering\n` +
      `  doctor   Report engine and terminal capabilities\n` +
      `  serve    JSON IPC mode for wrappers\n` +
      `  mcp      Model Context Protocol server over stdio\n` +
      `  preview  Local preview server\n\n` +
      `  tool-schema  Print tool schema for agents\n\n` +
      `Flags:\n` +
      `  --in <file>        Input file\n` +
      `  --stdin            Read input from stdin\n` +
      `  --out <file>       Output file (render)\n` +
      `  --out-dir <dir>    Output directory (render/extract)\n` +
      `  --out-manifest <file>  Write manifest JSON (render)\n` +
      `  --format <fmt>     svg|png|pdf|ascii|term\n` +
      `  --theme <theme>    light|dark|custom\n` +
      `  --scale <n>        Scale factor\n` +
      `  --background <bg>  transparent|#hex\n` +
      `  --engine <engine>  auto|embedded|mmdc|stub|ascii|<custom>\n` +
      `  --ascii            Force ASCII characters (vs Unicode)\n` +
      `  --coords           Show debug grid coordinates\n` +
      `  --padding-x <n>    Graph horizontal padding\n` +
      `  --padding-y <n>    Graph vertical padding\n` +
      `  --border-padding <n>  Node border padding\n` +
      `  --host <host>      Preview bind host (preview)\n` +
      `  --port <port>      Preview port (preview)\n` +
      `  --json             Machine-readable output\n` +
      `  --quiet            Suppress warnings\n`
  );
}
