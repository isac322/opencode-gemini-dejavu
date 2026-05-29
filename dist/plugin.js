import { createHash, randomUUID } from "node:crypto";
const PLUGIN_ID = "gemini-dejavu";
const DEFAULT_CALL_REPEAT = 3;
const DEFAULT_BATCH_REPEAT = 2;
const VERBOSE = process.env.GEMINI_DEJAVU_VERBOSE === "1";
function canonicalJson(value) {
    const walk = (input) => {
        if (Array.isArray(input))
            return input.map(walk);
        if (input && typeof input === "object") {
            const out = {};
            for (const key of Object.keys(input).sort()) {
                if (key === "callID" || key === "id" || key === "thoughtSignature")
                    continue;
                out[key] = walk(input[key]);
            }
            return out;
        }
        return input;
    };
    return JSON.stringify(walk(value ?? null));
}
function callKey(tool, args) {
    return createHash("sha256")
        .update(`${tool}\0${canonicalJson(args)}`)
        .digest("hex");
}
function batchKey(calls) {
    return createHash("sha256")
        .update(calls.map((call) => call.key).join("\n"))
        .digest("hex");
}
function isGemini3AfterLastUser(messages, lastUserIndex) {
    const user = messages[lastUserIndex]?.info;
    const userModel = user?.model?.modelID;
    if (typeof userModel === "string" && /^gemini-3\./i.test(userModel))
        return true;
    for (let i = messages.length - 1; i > lastUserIndex; i--) {
        const info = messages[i]?.info;
        if (typeof info?.modelID === "string" && /^gemini-3\./i.test(info.modelID))
            return true;
    }
    return false;
}
function isSyntheticBoundary(message) {
    return message.info.role === "user" && message.info.id.startsWith(`${PLUGIN_ID}_boundary_`);
}
function hasUserContent(message) {
    if (message.info.role !== "user")
        return false;
    return message.parts.some((part) => (part.type === "text" && typeof part.text === "string" && part.text.length > 0) ||
        part.type === "file" ||
        part.type === "agent" ||
        part.type === "subtask");
}
function lastRealUserIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.info.role === "user" && !isSyntheticBoundary(message) && hasUserContent(message))
            return i;
    }
    return -1;
}
function callsForMessage(message) {
    const calls = [];
    if (message.info.role !== "assistant")
        return calls;
    for (const part of message.parts) {
        if (part.type !== "tool")
            continue;
        const tool = part.tool ?? part.toolName;
        if (!tool)
            continue;
        const args = part.state?.input ?? part.input ?? part.args ?? null;
        calls.push({ key: callKey(tool, args), tool, args, part });
    }
    return calls;
}
function batchesAfterLastUser(messages, lastUser) {
    const batches = [];
    for (let i = lastUser + 1; i < messages.length; i++) {
        const message = messages[i];
        if (!message)
            continue;
        const calls = callsForMessage(message);
        if (calls.length === 0)
            continue;
        batches.push({ messageIndex: i, key: batchKey(calls), calls });
    }
    return batches;
}
function tailSameBatchCount(batches) {
    const last = batches.at(-1);
    if (!last)
        return 0;
    let count = 0;
    for (let i = batches.length - 1; i >= 0; i--) {
        if (batches[i]?.key !== last.key)
            break;
        count++;
    }
    return count;
}
function tailSameCallCount(batches) {
    const stream = batches.flatMap((batch) => batch.calls);
    const last = stream.at(-1);
    if (!last)
        return { count: 0 };
    let count = 0;
    for (let i = stream.length - 1; i >= 0; i--) {
        if (stream[i]?.key !== last.key)
            break;
        count++;
    }
    return { count, key: last.key };
}
function duplicateWithinLastBatchRepeatedBefore(batches) {
    const last = batches.at(-1);
    if (!last)
        return { duplicated: false };
    const seen = new Map();
    for (const call of last.calls)
        seen.set(call.key, (seen.get(call.key) ?? 0) + 1);
    for (const [key, count] of seen) {
        if (count < 2)
            continue;
        const appearedBefore = batches.slice(0, -1).some((batch) => batch.calls.some((call) => call.key === key));
        if (appearedBefore)
            return { duplicated: true, key };
    }
    return { duplicated: false };
}
function detectLoop(batches, options) {
    if (batches.length < 2)
        return { active: false };
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
function clearSignature(part) {
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
function makeBoundaryMessage(previousUser, before, reason) {
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
function applyRewrite(messages, options) {
    const lastUser = lastRealUserIndex(messages);
    if (lastUser < 0)
        return { rewritten: false, pruned: 0 };
    if (!isGemini3AfterLastUser(messages, lastUser))
        return { rewritten: false, pruned: 0 };
    const batches = batchesAfterLastUser(messages, lastUser);
    if (batches.length < 2)
        return { rewritten: false, pruned: 0 };
    const detection = detectLoop(batches, options);
    if (!detection.active)
        return { rewritten: false, pruned: 0 };
    const lastBatch = batches.at(-1);
    if (!lastBatch)
        return { rewritten: false, pruned: 0 };
    let pruned = 0;
    if (options.prune !== "none") {
        const repeatedKeys = detection.repeatedCallKeys ?? new Set();
        for (let i = lastUser + 1; i < lastBatch.messageIndex; i++) {
            const message = messages[i];
            if (!message)
                continue;
            for (const call of callsForMessage(message)) {
                if (options.prune === "all" || repeatedKeys.has(call.key)) {
                    if (clearSignature(call.part))
                        pruned++;
                }
            }
        }
    }
    const previousUser = messages[lastUser];
    const before = messages[lastBatch.messageIndex];
    if (!previousUser || !before)
        return { rewritten: false, pruned: 0 };
    const boundary = makeBoundaryMessage(previousUser, before, detection.reason ?? "loop");
    messages.splice(lastBatch.messageIndex, 0, boundary);
    return { rewritten: true, reason: detection.reason, pruned, insertedAt: lastBatch.messageIndex };
}
function parseOptions(options) {
    const candidate = options && typeof options === "object" ? options : undefined;
    return {
        callRepeat: typeof candidate?.callRepeat === "number" ? candidate.callRepeat : DEFAULT_CALL_REPEAT,
        batchRepeat: typeof candidate?.batchRepeat === "number" ? candidate.batchRepeat : DEFAULT_BATCH_REPEAT,
        prune: candidate?.prune === "none" || candidate?.prune === "all" || candidate?.prune === "repeated" ? candidate.prune : "repeated",
        dryRun: candidate?.dryRun === true,
    };
}
export function rewriteMessagesForTest(messages, pluginOptions) {
    return applyRewrite(messages, parseOptions(pluginOptions));
}
const pluginRuntime = async (_input, pluginOptions) => {
    const options = parseOptions(pluginOptions);
    const hooks = {
        "experimental.chat.messages.transform": async (_input, output) => {
            const messages = output.messages;
            if (!Array.isArray(messages))
                return;
            const cloned = structuredClone(messages);
            const result = applyRewrite(cloned, options);
            if (!result.rewritten)
                return;
            if (!options.dryRun)
                output.messages = cloned;
            if (VERBOSE) {
                console.warn(`[${PLUGIN_ID}] ${options.dryRun ? "would rewrite" : "rewrote"} reason=${result.reason} insertedAt=${result.insertedAt} pruned=${result.pruned}`);
            }
        },
    };
    return hooks;
};
const pluginTypecheck = pluginRuntime;
void pluginTypecheck;
export const server = pluginRuntime;
export default { id: PLUGIN_ID, server: pluginRuntime };
//# sourceMappingURL=plugin.js.map