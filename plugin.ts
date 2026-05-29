import { createHash, randomUUID } from "node:crypto";
import type { Plugin } from "@opencode-ai/plugin";

const PLUGIN_ID = "gemini-dejavu";
const DEFAULT_CALL_REPEAT = 3;
const DEFAULT_BATCH_REPEAT = 2;
const VERBOSE = process.env.GEMINI_DEJAVU_VERBOSE === "1";

type MessageInfo = {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time?: { created?: number; completed?: number };
  agent?: string;
  model?: { providerID: string; modelID: string };
  providerID?: string;
  modelID?: string;
  parentID?: string;
  mode?: string;
  path?: { cwd: string; root: string };
  cost?: number;
  tokens?: unknown;
  [key: string]: unknown;
};

type Part = {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  text?: string;
  callID?: string;
  tool?: string;
  toolName?: string;
  state?: { input?: unknown; status?: string; [key: string]: unknown };
  input?: unknown;
  args?: unknown;
  metadata?: {
    google?: { thoughtSignature?: string; [key: string]: unknown };
    vertex?: { thoughtSignature?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type ChatMessage = { info: MessageInfo; parts: Part[] };
type Call = { key: string; tool: string; args: unknown; part: Part };
type Batch = { messageIndex: number; key: string; calls: Call[] };

type LoopBreakerOptions = {
  callRepeat?: number;
  batchRepeat?: number;
  prune?: "none" | "repeated" | "all";
  dryRun?: boolean;
};

type TransformHooks = {
  "experimental.chat.messages.transform": (_input: unknown, output: { messages: unknown }) => Promise<void>;
};

function canonicalJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        if (key === "callID" || key === "id" || key === "thoughtSignature") continue;
        out[key] = walk((input as Record<string, unknown>)[key]);
      }
      return out;
    }
    return input;
  };
  return JSON.stringify(walk(value ?? null));
}

function callKey(tool: string, args: unknown): string {
  return createHash("sha256")
    .update(`${tool}\0${canonicalJson(args)}`)
    .digest("hex");
}

function batchKey(calls: Call[]): string {
  return createHash("sha256")
    .update(calls.map((call) => call.key).join("\n"))
    .digest("hex");
}

function isGemini3AfterLastUser(messages: ChatMessage[], lastUserIndex: number): boolean {
  const user = messages[lastUserIndex]?.info;
  const userModel = user?.model?.modelID;
  if (typeof userModel === "string" && /^gemini-3\./i.test(userModel)) return true;
  for (let i = messages.length - 1; i > lastUserIndex; i--) {
    const info = messages[i]?.info;
    if (typeof info?.modelID === "string" && /^gemini-3\./i.test(info.modelID)) return true;
  }
  return false;
}

function isSyntheticBoundary(message: ChatMessage): boolean {
  return message.info.role === "user" && message.info.id.startsWith(`${PLUGIN_ID}_boundary_`);
}

function hasUserContent(message: ChatMessage): boolean {
  if (message.info.role !== "user") return false;
  return message.parts.some(
    (part) =>
      (part.type === "text" && typeof part.text === "string" && part.text.length > 0) ||
      part.type === "file" ||
      part.type === "agent" ||
      part.type === "subtask",
  );
}

function lastRealUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.info.role === "user" && !isSyntheticBoundary(message) && hasUserContent(message)) return i;
  }
  return -1;
}

function callsForMessage(message: ChatMessage): Call[] {
  const calls: Call[] = [];
  if (message.info.role !== "assistant") return calls;
  for (const part of message.parts) {
    if (part.type !== "tool") continue;
    const tool = part.tool ?? part.toolName;
    if (!tool) continue;
    const args = part.state?.input ?? part.input ?? part.args ?? null;
    calls.push({ key: callKey(tool, args), tool, args, part });
  }
  return calls;
}

function batchesAfterLastUser(messages: ChatMessage[], lastUser: number): Batch[] {
  const batches: Batch[] = [];
  for (let i = lastUser + 1; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    const calls = callsForMessage(message);
    if (calls.length === 0) continue;
    batches.push({ messageIndex: i, key: batchKey(calls), calls });
  }
  return batches;
}

function tailSameBatchCount(batches: Batch[]): number {
  const last = batches.at(-1);
  if (!last) return 0;
  let count = 0;
  for (let i = batches.length - 1; i >= 0; i--) {
    if (batches[i]?.key !== last.key) break;
    count++;
  }
  return count;
}

function tailSameCallCount(batches: Batch[]): { count: number; key?: string } {
  const stream = batches.flatMap((batch) => batch.calls);
  const last = stream.at(-1);
  if (!last) return { count: 0 };
  let count = 0;
  for (let i = stream.length - 1; i >= 0; i--) {
    if (stream[i]?.key !== last.key) break;
    count++;
  }
  return { count, key: last.key };
}

function duplicateWithinLastBatchRepeatedBefore(batches: Batch[]): { duplicated: boolean; key?: string } {
  const last = batches.at(-1);
  if (!last) return { duplicated: false };
  const seen = new Map<string, number>();
  for (const call of last.calls) seen.set(call.key, (seen.get(call.key) ?? 0) + 1);
  for (const [key, count] of seen) {
    if (count < 2) continue;
    const appearedBefore = batches.slice(0, -1).some((batch) => batch.calls.some((call) => call.key === key));
    if (appearedBefore) return { duplicated: true, key };
  }
  return { duplicated: false };
}

function detectLoop(
  batches: Batch[],
  options: Required<Pick<LoopBreakerOptions, "callRepeat" | "batchRepeat">>,
): { active: boolean; reason?: string; repeatedCallKeys?: Set<string> } {
  if (batches.length < 2) return { active: false };
  const batchCount = tailSameBatchCount(batches);
  if (batchCount >= options.batchRepeat)
    return {
      active: true,
      reason: `repeated_batch_${batchCount}`,
      repeatedCallKeys: new Set(batches.at(-1)?.calls.map((call) => call.key) ?? []),
    };
  const call = tailSameCallCount(batches);
  if (call.count >= options.callRepeat && call.key)
    return { active: true, reason: `repeated_call_${call.count}`, repeatedCallKeys: new Set([call.key]) };
  const duplicate = duplicateWithinLastBatchRepeatedBefore(batches);
  if (duplicate.duplicated && duplicate.key)
    return { active: true, reason: "intra_generation_duplicate", repeatedCallKeys: new Set([duplicate.key]) };
  return { active: false };
}

function clearSignature(part: Part): boolean {
  let changed = false;
  if (part.metadata?.google?.thoughtSignature) {
    delete part.metadata.google.thoughtSignature;
    changed = true;
  }
  if (part.metadata?.vertex?.thoughtSignature) {
    delete part.metadata.vertex.thoughtSignature;
    changed = true;
  }
  return changed;
}

function makeBoundaryMessage(previousUser: ChatMessage, before: ChatMessage, reason: string): ChatMessage {
  const id = `${PLUGIN_ID}_boundary_${randomUUID()}`;
  const sessionID = previousUser.info.sessionID || before.info.sessionID;
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: previousUser.info.agent ?? "build",
      model: previousUser.info.model,
      tools: previousUser.info.tools,
    },
    parts: [
      {
        id: `${id}_text`,
        sessionID,
        messageID: id,
        type: "text",
        text: "Continue from the evidence above. Treat the following tool result as the latest completed step for this generation.",
        metadata: { [PLUGIN_ID]: { reason } },
      },
    ],
  };
}

function applyRewrite(
  messages: ChatMessage[],
  options: Required<LoopBreakerOptions>,
): { rewritten: boolean; reason?: string; pruned: number; insertedAt?: number } {
  const lastUser = lastRealUserIndex(messages);
  if (lastUser < 0) return { rewritten: false, pruned: 0 };
  if (!isGemini3AfterLastUser(messages, lastUser)) return { rewritten: false, pruned: 0 };

  const batches = batchesAfterLastUser(messages, lastUser);
  if (batches.length < 2) return { rewritten: false, pruned: 0 };

  const detection = detectLoop(batches, options);
  if (!detection.active) return { rewritten: false, pruned: 0 };

  const lastBatch = batches.at(-1);
  if (!lastBatch) return { rewritten: false, pruned: 0 };
  let pruned = 0;
  if (options.prune !== "none") {
    const repeatedKeys = detection.repeatedCallKeys ?? new Set<string>();
    for (let i = lastUser + 1; i < lastBatch.messageIndex; i++) {
      const message = messages[i];
      if (!message) continue;
      for (const call of callsForMessage(message)) {
        if (options.prune === "all" || repeatedKeys.has(call.key)) {
          if (clearSignature(call.part)) pruned++;
        }
      }
    }
  }

  const previousUser = messages[lastUser];
  const before = messages[lastBatch.messageIndex];
  if (!previousUser || !before) return { rewritten: false, pruned: 0 };

  const boundary = makeBoundaryMessage(previousUser, before, detection.reason ?? "loop");
  messages.splice(lastBatch.messageIndex, 0, boundary);
  return { rewritten: true, reason: detection.reason, pruned, insertedAt: lastBatch.messageIndex };
}

function parseOptions(options: unknown): Required<LoopBreakerOptions> {
  const candidate = options && typeof options === "object" ? (options as LoopBreakerOptions) : undefined;
  return {
    callRepeat: typeof candidate?.callRepeat === "number" ? candidate.callRepeat : DEFAULT_CALL_REPEAT,
    batchRepeat: typeof candidate?.batchRepeat === "number" ? candidate.batchRepeat : DEFAULT_BATCH_REPEAT,
    prune: candidate?.prune === "none" || candidate?.prune === "all" || candidate?.prune === "repeated" ? candidate.prune : "repeated",
    dryRun: candidate?.dryRun === true,
  };
}

export function rewriteMessagesForTest(messages: ChatMessage[], pluginOptions?: LoopBreakerOptions): ReturnType<typeof applyRewrite> {
  return applyRewrite(messages, parseOptions(pluginOptions));
}

const pluginRuntime = async (_input: unknown, pluginOptions?: unknown): Promise<TransformHooks> => {
  const options = parseOptions(pluginOptions);
  const hooks: TransformHooks = {
    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = output.messages as unknown as ChatMessage[];
      if (!Array.isArray(messages)) return;
      const cloned = structuredClone(messages);
      const result = applyRewrite(cloned, options);
      if (!result.rewritten) return;
      if (!options.dryRun) output.messages = cloned as typeof output.messages;
      if (VERBOSE) {
        console.warn(
          `[${PLUGIN_ID}] ${options.dryRun ? "would rewrite" : "rewrote"} reason=${result.reason} insertedAt=${result.insertedAt} pruned=${result.pruned}`,
        );
      }
    },
  };
  return hooks;
};

const pluginTypecheck: Plugin = pluginRuntime;
void pluginTypecheck;

export const server = pluginRuntime;
export default { id: PLUGIN_ID, server: pluginRuntime };
