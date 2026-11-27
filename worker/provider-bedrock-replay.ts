import { bedrockBase64, bedrockJson, bedrockObject, bedrockRecord, requireBedrock, type BedrockObject } from "./provider-bedrock-converse.ts";

export interface BedrockReplayModel {
  id: string;
  provider: string;
  api: string;
  /** Qualified by the frozen provider/model resolver, not inferred from user input. */
  claude: boolean;
  bindsThinkingPrefix?: boolean;
}
export interface BedrockReplayOptions {
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  cachePoint?: { type: "default"; ttl?: "1h" };
  adaptiveThinking?: boolean;
}
const boundary = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";
function clean(value: string): string {
  return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}
function id(value: unknown): string {
  requireBedrock(typeof value === "string" && value.trim().length > 0, "tool_id");
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}
function argumentsObject(value: unknown): BedrockObject {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return {}; } }
  return bedrockRecord(value) && bedrockJson(value) ? value as BedrockObject : {};
}
function textImage(content: unknown, skipEmpty: boolean): BedrockObject[] {
  requireBedrock(Array.isArray(content), "replay_content");
  const result: BedrockObject[] = [];
  for (const value of content) {
    const block = bedrockRecord(value);
    requireBedrock(block, "replay_block");
    if (block.type === "text") {
      requireBedrock(typeof block.text === "string", "replay_text"); result.push({ text: clean(block.text) });
    } else if (block.type === "image") {
      if (skipEmpty && (typeof block.data !== "string" || !block.data.trim())) continue;
      const format = ({ "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" } as Record<string, string>)[block.mimeType as string];
      requireBedrock(format, "image_format");
      // REST JSON uses base64 strings; the SDK's Uint8Array shape is not JSON wire data.
      result.push({ image: { format, source: { bytes: bedrockBase64(block.data) } } });
    }
  }
  return result;
}
function toolContent(message: Record<string, unknown>): BedrockObject[] {
  const content = textImage(message.content, true);
  if (content.length) return content;
  const blocks = message.content as Record<string, unknown>[];
  const audio = blocks.some(block => (typeof block.mimeType === "string" && block.mimeType.startsWith("audio/") || ["audio", "input_audio", "output_audio"].includes(block.type as string)) && typeof block.data === "string" && block.data.length > 0);
  return [{ text: audio ? "(see attached audio)" : "(no output)" }];
}

export function buildBedrockSystemPrompt(prompt: string | undefined, cachePoint?: BedrockReplayOptions["cachePoint"]): BedrockObject[] | undefined {
  if (!prompt) return undefined;
  const split = prompt.indexOf(boundary), stable = split < 0 ? prompt : prompt.slice(0, split), dynamic = split < 0 ? "" : prompt.slice(split + boundary.length);
  const result: BedrockObject[] = [];
  if (stable) result.push({ text: clean(stable.split(boundary).join("")) });
  if (stable && cachePoint) result.push({ cachePoint });
  if (dynamic) result.push({ text: clean(dynamic.split(boundary).join("")) });
  return result.length ? result : undefined;
}

/**
 * Input is Pi context after its shared transcript repair (failed turns, missing/async
 * tool results, non-vision images). This focused codec owns the Bedrock conversion.
 * Runtime-context indexes are supplied by that client classifier, not guessed from prose.
 */
export function prepareBedrockReplay(value: unknown, model: BedrockReplayModel, options: BedrockReplayOptions = {}, volatileUserIndexes: ReadonlySet<number> = new Set()): BedrockObject {
  const context = bedrockObject(value);
  requireBedrock(Array.isArray(context.messages), "replay_messages");
  const tools = context.tools;
  requireBedrock(tools === undefined || Array.isArray(tools), "tools");
  let toolConfig: BedrockObject | undefined;
  if (Array.isArray(tools) && tools.length && options.toolChoice !== "none") {
    const specs = tools.map(value => {
      const tool = bedrockRecord(value);
      requireBedrock(tool && typeof tool.name === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(tool.name) && bedrockRecord(tool.parameters), "tool_spec");
      requireBedrock(tool.description === undefined || typeof tool.description === "string", "tool_description");
      return { toolSpec: { name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), inputSchema: { json: tool.parameters } } } as BedrockObject;
    }).sort((left, right) => {
      const a = (left.toolSpec as BedrockObject).name as string, b = (right.toolSpec as BedrockObject).name as string;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    let choice = options.toolChoice;
    if (options.adaptiveThinking && (choice === "any" || typeof choice === "object")) choice = "auto";
    const nativeChoice: BedrockObject | undefined = choice === "auto" ? { auto: {} } : choice === "any" ? { any: {} } : typeof choice === "object" ? { tool: { name: choice.name } } : undefined;
    toolConfig = { tools: specs, ...(nativeChoice ? { toolChoice: nativeChoice } : {}) };
  }
  const messages: BedrockObject[] = [];
  const identities = new Map<string, string>();
  function toolId(value: unknown) {
    const normalized = id(value), original = (value as string).trim(), previous = identities.get(normalized);
    requireBedrock(previous === undefined || previous === original, "tool_id_collision"); identities.set(normalized, original); return normalized;
  }
  let volatile: number | undefined;
  for (let index = 0; index < context.messages.length; index++) {
    const message = bedrockRecord(context.messages[index]);
    requireBedrock(message, "replay_message");
    if (message.role === "user") {
      const content = typeof message.content === "string" ? [{ text: clean(message.content) }] : textImage(message.content, false);
      if (content.length) {
        if (volatile === undefined && volatileUserIndexes.has(index) && !model.bindsThinkingPrefix) volatile = messages.length;
        messages.push({ role: "user", content });
      }
    } else if (message.role === "assistant") {
      const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
      requireBedrock(Array.isArray(blocks), "assistant_content");
      const same = message.provider === model.provider && message.api === model.api && message.model === model.id;
      const content: BedrockObject[] = [];
      for (const value of blocks) {
        const block = bedrockRecord(value);
        requireBedrock(block, "assistant_block");
        if (block.type === "text") {
          requireBedrock(typeof block.text === "string", "assistant_text"); if (block.text.trim()) content.push({ text: clean(block.text) });
        } else if (block.type === "toolCall") {
          requireBedrock(typeof block.name === "string", "tool_name");
          const input = argumentsObject(block.arguments);
          content.push(toolConfig ? { toolUse: { toolUseId: toolId(block.id), name: block.name, input } } : { text: `[Assistant tool call]: ${block.name}(${JSON.stringify(input)})` });
        } else if (block.type === "thinking") {
          if (block.redacted) {
            if (same && model.claude) content.push({ reasoningContent: { redactedContent: bedrockBase64(block.thinkingSignature) } });
            continue;
          }
          requireBedrock(typeof block.thinking === "string", "thinking_text");
          const signature = same && typeof block.thinkingSignature === "string" ? block.thinkingSignature : undefined;
          if (model.claude && signature?.trim() === "reasoning_content") continue;
          if (model.claude && signature?.trim()) content.push({ reasoningContent: { reasoningText: { text: block.thinking, signature } } });
          else if (block.thinking.trim()) content.push({ text: clean(block.thinking) });
        }
      }
      if (content.length) messages.push({ role: "assistant", content });
    } else if (message.role === "toolResult") {
      const group = [message];
      while (bedrockRecord(context.messages[index + 1])?.role === "toolResult") group.push(bedrockRecord(context.messages[++index])!);
      const content: BedrockObject[] = [], images: BedrockObject[] = [];
      for (const result of group) {
        const parts = toolContent(result);
        if (!toolConfig) {
          requireBedrock(typeof result.toolName === "string", "tool_result_name");
          content.push({ text: `[Tool result: ${result.toolName}${result.isError ? " (error)" : ""}]:` }, ...parts); continue;
        }
        const toolUseId = toolId(result.toolCallId);
        let nested = parts;
        if (model.id.includes("openai.gpt-5.6-sol")) {
          const attached = parts.filter(part => part.image);
          if (attached.length) {
            const label = `Images from tool result ${toolUseId}`;
            images.push({ text: `${label}:` }, ...attached);
            nested = [...parts.filter(part => !part.image), { text: `(see attached images labeled "${label}")` }];
          }
        }
        content.push({ toolResult: { toolUseId, status: result.isError ? "error" : "success", content: nested } });
      }
      messages.push({ role: "user", content: [...content, ...images] });
    } else throw new Error("invalid_bedrock_replay_role");
  }
  if (options.cachePoint && messages.at(-1)?.role === "user") {
    let remaining = 2;
    for (let index = (volatile ?? messages.length) - 1; index >= 0; index--) {
      if (messages[index].role === "user") {
        (messages[index].content as BedrockObject[]).push({ cachePoint: options.cachePoint });
        if (--remaining === 0) break;
      }
    }
  }
  requireBedrock(context.systemPrompt === undefined || typeof context.systemPrompt === "string", "system_prompt");
  const system = buildBedrockSystemPrompt(context.systemPrompt as string | undefined, options.cachePoint);
  return bedrockObject({ messages, ...(system ? { system } : {}), ...(toolConfig ? { toolConfig } : {}) });
}
