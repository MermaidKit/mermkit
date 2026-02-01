import type { Diagram } from "@mermkit/core";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderAscii, type AsciiRenderOptions } from "./ascii.js";

export type RenderFormat = "svg" | "png" | "pdf" | "ascii";
export { renderAscii, type AsciiRenderOptions };
export type RenderTheme = "light" | "dark" | "custom";

export type RenderEngineId = "embedded" | "mmdc" | "stub" | "ascii" | (string & { __engineId?: never });
export type RenderEngineSelection = "auto" | RenderEngineId;

export type RenderResult = {
  bytes: Uint8Array;
  mime: string;
  warnings: string[];
};

export type RenderOptions = {
  format: RenderFormat;
  theme?: RenderTheme;
  scale?: number;
  background?: "transparent" | string;
  engine?: RenderEngineSelection;
  ascii?: AsciiRenderOptions;
};

export type RenderEngine = {
  id: RenderEngineId;
  priority?: number;
  render: (diagram: Diagram, options: RenderOptions) => Promise<RenderResult>;
};

type RegisterOptions = {
  override?: boolean;
  silent?: boolean;
};

const engineRegistry = new Map<string, RenderEngine>();
let builtinsRegistered = false;

export function registerEngine(engine: RenderEngine, options: RegisterOptions = {}): void {
  const existing = engineRegistry.get(engine.id);
  if (existing && !options.override) {
    if (options.silent) return;
    throw new Error(`render engine already registered: ${engine.id}`);
  }
  engineRegistry.set(engine.id, engine);
}

export function getEngine(id: RenderEngineId): RenderEngine | undefined {
  return engineRegistry.get(id);
}

export function listEngines(): RenderEngine[] {
  return Array.from(engineRegistry.values()).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

function ensureBuiltinEngines(): void {
  if (builtinsRegistered) return;
  builtinsRegistered = true;
  registerEngine(
    {
      id: "embedded",
      priority: 30,
      render: (diagram, options) => renderWithEmbedded(diagram, options)
    },
    { silent: true }
  );
  registerEngine(
    {
      id: "mmdc",
      priority: 20,
      render: (diagram, options) => renderWithMmdc(diagram, options)
    },
    { silent: true }
  );
  registerEngine(
    {
      id: "ascii",
      priority: 15,
      render: (diagram, options) => renderWithAscii(diagram, options)
    },
    { silent: true }
  );
  registerEngine(
    {
      id: "stub",
      priority: 0,
      render: (diagram, options) => renderWithStub(diagram, options)
    },
    { silent: true }
  );
}

export async function render(diagram: Diagram, options: RenderOptions): Promise<RenderResult> {
  ensureBuiltinEngines();

  // Handle ASCII format specially
  if (options.format === "ascii") {
    return renderWithAscii(diagram, options);
  }

  const selection = options.engine ?? "auto";

  if (selection !== "auto") {
    const engine = getEngine(selection);
    if (!engine) {
      throw new Error(`render engine not registered: ${selection}`);
    }
    return engine.render(diagram, options);
  }

  const engines = listEngines();
  const failures: string[] = [];
  for (const engine of engines) {
    // Skip ASCII/stub engines in auto mode (they're only used explicitly or via format: "ascii")
    if (engine.id === "ascii" || engine.id === "stub") continue;

    try {
      const result = await engine.render(diagram, options);
      if (failures.length > 0) {
        result.warnings.unshift(...failures);
      }
      return result;
    } catch (error) {
      failures.push(`${engine.id} engine failed: ${errorMessage(error)}`);
    }
  }

  throw new Error("no render engines succeeded");
}

export type TerminalCapabilities = {
  kitty?: boolean;
  iterm2?: boolean;
  wezterm?: boolean;
  unicode?: boolean;
};

export type TerminalRenderResult = {
  text?: string;
  imageBytes?: Uint8Array;
  mime?: string;
  warnings: string[];
};

export type TerminalRenderOptions = {
  preferAscii?: boolean;
};

export async function renderForTerminal(
  diagram: Diagram,
  capabilities: TerminalCapabilities,
  options: TerminalRenderOptions = {}
): Promise<TerminalRenderResult> {
  const warnings: string[] = [];

  // Try inline image first if terminal supports it and ASCII not preferred
  if (!options.preferAscii && (capabilities.kitty || capabilities.wezterm || capabilities.iterm2)) {
    try {
      const result = await render(diagram, { format: "png", engine: "auto" });
      const bytes = result.bytes;
      if (bytes.length > 0) {
        const text = capabilities.iterm2 && !capabilities.kitty && !capabilities.wezterm
          ? encodeIterm2InlinePng(bytes)
          : encodeKittyInlinePng(bytes);
        warnings.push(...result.warnings);
        return {
          text,
          imageBytes: bytes,
          mime: "image/png",
          warnings
        };
      }
    } catch (error) {
      warnings.push(`inline image failed: ${errorMessage(error)}`);
    }
  }

  // Fall back to ASCII rendering
  try {
    const asciiResult = renderAscii(diagram.source, {
      useAscii: !capabilities.unicode
    });
    if (asciiResult) {
      return {
        text: asciiResult,
        mime: "text/plain",
        warnings
      };
    }
  } catch (error) {
    warnings.push(`ASCII rendering failed: ${errorMessage(error)}`);
  }

  warnings.push("terminal does not support inline images and ASCII rendering failed");
  return {
    text: "Unable to render diagram. Use `mermkit render` to generate SVG/PNG artifacts.",
    warnings
  };
}

async function renderWithAscii(diagram: Diagram, options: RenderOptions): Promise<RenderResult> {
  const asciiOptions = options.ascii ?? {};
  const result = renderAscii(diagram.source, asciiOptions);

  if (!result) {
    throw new Error("ASCII rendering failed: unable to parse diagram");
  }

  return {
    bytes: new TextEncoder().encode(result),
    mime: "text/plain",
    warnings: []
  };
}

function renderStubSvg(source: string, options: RenderOptions): string {
  const lines = source.split("\n");
  const fontSize = 14;
  const lineHeight = 18;
  const padding = 16;
  const maxLen = Math.max(1, ...lines.map((line) => line.length));
  const width = padding * 2 + maxLen * 8;
  const height = padding * 2 + lines.length * lineHeight;
  const background = options.background ?? "transparent";

  const textLines = lines
    .map((line, index) => {
      const y = padding + (index + 1) * lineHeight;
      return `<text x="${padding}" y="${y}">${escapeXml(line)}</text>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<style>text{font-family:ui-monospace,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:${fontSize}px;fill:#111}</style>` +
    (background === "transparent" ? "" : `<rect width="100%" height="100%" fill="${escapeXml(background)}"/>`) +
    textLines +
    `</svg>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function renderPngFromSvg(svg: string): Promise<RenderResult> {
  let sharpModule: unknown;
  try {
    sharpModule = await import("sharp");
  } catch (error) {
    throw new Error("PNG rendering requires optional dependency 'sharp'");
  }

  const sharp = (sharpModule as { default?: unknown }).default ?? sharpModule;
  const buffer = await (sharp as (input: Buffer) => { png: () => { toBuffer: () => Promise<Buffer> } })(
    Buffer.from(svg)
  )
    .png()
    .toBuffer();

  return {
    bytes: new Uint8Array(buffer),
    mime: "image/png",
    warnings: []
  };
}

async function renderWithStub(diagram: Diagram, options: RenderOptions): Promise<RenderResult> {
  const warnings = ["stub renderer: this is a test double, not a real renderer"];
  if (options.format === "svg") {
    const svg = renderStubSvg(diagram.source, options);
    return {
      bytes: new TextEncoder().encode(svg),
      mime: "image/svg+xml",
      warnings
    };
  }

  if (options.format === "png") {
    const svg = renderStubSvg(diagram.source, options);
    const result = await renderPngFromSvg(svg);
    result.warnings = warnings;
    return result;
  }

  throw new Error("PDF rendering not implemented yet");
}

async function renderWithMmdc(diagram: Diagram, options: RenderOptions): Promise<RenderResult> {
  const tmpRoot = await mkdtemp(join(tmpdir(), "mermkit-"));
  const inputPath = join(tmpRoot, "diagram.mmd");
  const outputPath = join(tmpRoot, `diagram.${options.format}`);
  const warnings: string[] = [];

  try {
    await writeFile(inputPath, diagram.source, "utf8");

    const args = ["-i", inputPath, "-o", outputPath];
    const theme = resolveMmdcTheme(options.theme, warnings);
    if (theme) args.push("-t", theme);
    if (options.background) args.push("-b", options.background);
    if (options.scale) args.push("-s", String(options.scale));

    const binary = await resolveMmdcBinary();
    await runProcess(binary, args);

    const bytes = await readFile(outputPath);

    return {
      bytes: new Uint8Array(bytes),
      mime: mimeFor(options.format),
      warnings
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function renderWithEmbedded(diagram: Diagram, options: RenderOptions): Promise<RenderResult> {
  const warnings: string[] = [];
  const { mermaid, JSDOM, dompurify } = await resolveEmbeddedDeps();
  const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { pretendToBeVisual: true });
  const restore = setDomGlobals(dom);

  try {
    if (dompurify) {
      const createDOMPurify = dompurify.default ?? dompurify;
      (globalThis as { DOMPurify?: unknown }).DOMPurify = createDOMPurify(dom.window);
    }

    const mermaidApi = mermaid.default ?? mermaid;
    const theme = resolveEmbeddedTheme(options.theme, warnings);
    const config = {
      startOnLoad: false,
      securityLevel: "strict",
      theme,
      deterministicIds: true,
      deterministicSeed: diagram.id,
      flowchart: { useMaxWidth: false }
    } as const;
    mermaidApi.initialize(config as unknown as Record<string, unknown>);

    if (options.scale && options.scale !== 1) {
      warnings.push("embedded renderer: scale is not implemented yet");
    }

    const id = `mermkit-${diagram.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const { svg } = await mermaidApi.render(id, diagram.source);
    let svgOut = svg;

    if (options.background && options.background !== "transparent") {
      svgOut = applyBackground(svgOut, options.background);
    }

    if (options.format === "svg") {
      return {
        bytes: new TextEncoder().encode(svgOut),
        mime: "image/svg+xml",
        warnings
      };
    }

    if (options.format === "png") {
      const result = await renderPngFromSvg(svgOut);
      result.warnings = warnings;
      return result;
    }

    if (options.format === "pdf") {
      const result = await renderPdfFromSvg(svgOut);
      result.warnings = warnings;
      return result;
    }

    throw new Error("unsupported format");
  } finally {
    restore();
  }
}

function resolveMmdcTheme(theme: RenderTheme | undefined, warnings: string[]): string | undefined {
  if (!theme || theme === "light") return "default";
  if (theme === "dark") return "dark";
  warnings.push("custom theme is not supported yet; using default theme");
  return "default";
}

function resolveEmbeddedTheme(theme: RenderTheme | undefined, warnings: string[]): string {
  if (!theme || theme === "light") return "default";
  if (theme === "dark") return "dark";
  warnings.push("custom theme is not supported yet; using default theme");
  return "default";
}

function mimeFor(format: RenderFormat): string {
  switch (format) {
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "pdf":
      return "application/pdf";
    case "ascii":
      return "text/plain";
  }
}

async function resolveMmdcBinary(): Promise<string> {
  const envPath = process.env.MERMKIT_MMDC_PATH;
  if (envPath) return envPath;

  const candidates: string[] = [];
  const repoRoot = guessRepoRoot();
  if (repoRoot) {
    candidates.push(join(repoRoot, "node_modules", ".bin", "mmdc"));
  }
  candidates.push(join(process.cwd(), "node_modules", ".bin", "mmdc"));
  candidates.push("mmdc");

  for (const candidate of candidates) {
    try {
      await runProcess(candidate, ["-h"], { dryRun: true });
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error("mmdc not found. Install @mermaid-js/mermaid-cli or set MERMKIT_MMDC_PATH");
}

function guessRepoRoot(): string | null {
  const current = fileURLToPath(import.meta.url);
  const currentDir = dirname(current);
  const repoRoot = join(currentDir, "..", "..", "..");
  return repoRoot;
}

function runProcess(
  command: string,
  args: string[],
  options: { dryRun?: boolean } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.dryRun ? "ignore" : "pipe" });
    if (options.dryRun) {
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} exited with code ${code}`));
      });
      child.on("error", (error) => reject(error));
      return;
    }

    let stderr = "";
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
    child.on("error", (error) => reject(error));
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function renderPdfFromSvg(svg: string): Promise<RenderResult> {
  let sharpModule: unknown;
  try {
    sharpModule = await import("sharp");
  } catch {
    throw new Error("PDF rendering requires optional dependency 'sharp'");
  }

  const sharp = (sharpModule as { default?: unknown }).default ?? sharpModule;
  const buffer = await (sharp as (input: Buffer) => { pdf: () => { toBuffer: () => Promise<Buffer> } })(
    Buffer.from(svg)
  )
    .pdf()
    .toBuffer();

  return {
    bytes: new Uint8Array(buffer),
    mime: "application/pdf",
    warnings: []
  };
}

function applyBackground(svg: string, background: string): string {
  const svgStart = svg.indexOf("<svg");
  if (svgStart === -1) return svg;
  const tagEnd = svg.indexOf(">", svgStart);
  if (tagEnd === -1) return svg;
  const insert = `<rect width="100%" height="100%" fill="${escapeXml(background)}"/>`;
  return `${svg.slice(0, tagEnd + 1)}${insert}${svg.slice(tagEnd + 1)}`;
}

async function resolveEmbeddedDeps(): Promise<{
  mermaid: typeof import("mermaid");
  JSDOM: typeof import("jsdom").JSDOM;
  dompurify?: typeof import("dompurify");
}> {
  let mermaid: typeof import("mermaid");
  let JSDOM: typeof import("jsdom").JSDOM;
  let dompurify: typeof import("dompurify") | undefined;

  try {
    mermaid = await import("mermaid");
  } catch {
    throw new Error("embedded renderer requires dependency 'mermaid'");
  }

  try {
    const jsdomModule = await import("jsdom");
    JSDOM = jsdomModule.JSDOM;
  } catch {
    throw new Error("embedded renderer requires dependency 'jsdom'");
  }

  try {
    dompurify = await import("dompurify");
  } catch {
    dompurify = undefined;
  }

  return { mermaid, JSDOM, dompurify };
}

function setDomGlobals(dom: import("jsdom").JSDOM): () => void {
  const g = globalThis as Record<string, unknown>;
  const window = dom.window;

  const keys = ["window", "document", "navigator", "DOMParser", "XMLSerializer", "Node", "Element", "SVGElement"];
  const previous = new Map<string, unknown>();
  const assigned = new Set<string>();

  const assignGlobal = (key: string, value: unknown) => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, key);
    previous.set(key, (g as Record<string, unknown>)[key]);
    if (!desc || desc.writable || desc.configurable) {
      try {
        (g as Record<string, unknown>)[key] = value;
        assigned.add(key);
        return;
      } catch {
        // fall through to defineProperty
      }
      try {
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
        assigned.add(key);
        return;
      } catch {
        // ignore assignment failures (e.g., read-only globals)
      }
    }
  };

  assignGlobal("window", window);
  assignGlobal("document", window.document);
  assignGlobal("navigator", window.navigator);
  assignGlobal("DOMParser", window.DOMParser);
  assignGlobal("XMLSerializer", window.XMLSerializer);
  assignGlobal("Node", window.Node);
  assignGlobal("Element", window.Element);
  assignGlobal("SVGElement", window.SVGElement);

  return () => {
    for (const key of keys) {
      if (!assigned.has(key)) continue;
      (g as Record<string, unknown>)[key] = previous.get(key);
    }
    (g as Record<string, unknown>).DOMPurify = previous.get("DOMPurify");
  };
}

function encodeIterm2InlinePng(png: Uint8Array, filename = "diagram.png"): string {
  const base64 = Buffer.from(png).toString("base64");
  const name = Buffer.from(filename).toString("base64");
  return `\u001b]1337;File=name=${name};size=${png.length};inline=1:${base64}\u0007\n`;
}

function encodeKittyInlinePng(png: Uint8Array): string {
  const base64 = Buffer.from(png).toString("base64");
  const chunkSize = 4096;
  let out = "";
  for (let i = 0; i < base64.length; i += chunkSize) {
    const chunk = base64.slice(i, i + chunkSize);
    const more = i + chunkSize < base64.length ? 1 : 0;
    const prefix = i === 0 ? "a=T,f=100,t=d" : "";
    const params = prefix ? `${prefix},m=${more}` : `m=${more}`;
    out += `\u001b_G${params};${chunk}\u001b\\`;
  }
  return `${out}\n`;
}
