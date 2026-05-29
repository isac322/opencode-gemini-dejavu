type MessageInfo = {
    id: string;
    sessionID: string;
    role: "user" | "assistant";
    time?: {
        created?: number;
        completed?: number;
    };
    agent?: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    providerID?: string;
    modelID?: string;
    parentID?: string;
    mode?: string;
    path?: {
        cwd: string;
        root: string;
    };
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
    state?: {
        input?: unknown;
        status?: string;
        [key: string]: unknown;
    };
    input?: unknown;
    args?: unknown;
    metadata?: {
        google?: {
            thoughtSignature?: string;
            [key: string]: unknown;
        };
        vertex?: {
            thoughtSignature?: string;
            [key: string]: unknown;
        };
        [key: string]: unknown;
    };
    [key: string]: unknown;
};
type ChatMessage = {
    info: MessageInfo;
    parts: Part[];
};
type LoopBreakerOptions = {
    callRepeat?: number;
    batchRepeat?: number;
    prune?: "none" | "repeated" | "all";
    dryRun?: boolean;
};
type TransformHooks = {
    "experimental.chat.messages.transform": (_input: unknown, output: {
        messages: unknown;
    }) => Promise<void>;
};
declare function applyRewrite(messages: ChatMessage[], options: Required<LoopBreakerOptions>): {
    rewritten: boolean;
    reason?: string;
    pruned: number;
    insertedAt?: number;
};
export declare function rewriteMessagesForTest(messages: ChatMessage[], pluginOptions?: LoopBreakerOptions): ReturnType<typeof applyRewrite>;
export declare const server: (_input: unknown, pluginOptions?: unknown) => Promise<TransformHooks>;
declare const _default: {
    id: string;
    server: (_input: unknown, pluginOptions?: unknown) => Promise<TransformHooks>;
};
export default _default;
//# sourceMappingURL=plugin.d.ts.map