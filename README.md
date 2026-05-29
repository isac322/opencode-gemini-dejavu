# opencode-gemini-dejavu: mitigate Gemini repeated tool-call loops in OpenCode

Gemini 3.x can sometimes get stuck in a tool-call deja vu: the agent says it should move on, but the next model request calls the same tool with the same arguments again.

`opencode-gemini-dejavu` is a small OpenCode plugin that catches that loop at the request boundary. It doesn't edit your saved transcript. It only rewrites the message array OpenCode is about to send to Gemini, then lets the run continue.

Use it when an OpenCode session with Gemini keeps repeating calls like `read({ filePath: "..." })` instead of producing the next answer.

## Quick start

Add the npm package name to `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gemini-dejavu"]
}
```

OpenCode installs npm plugins automatically at startup and caches them under its package cache.

To tune the loop detector:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-gemini-dejavu",
      {
        "callRepeat": 3,
        "batchRepeat": 2,
        "prune": "repeated",
        "dryRun": false
      }
    ]
  ]
}
```

Defaults are deliberately conservative:

| Option | Default | What it means |
| --- | --- | --- |
| `callRepeat` | `3` | Trigger when the same individual `tool + args` call repeats this many times at the tail. |
| `batchRepeat` | `2` | Trigger when the same ordered batch of tool calls repeats this many times at the tail. |
| `prune` | `"repeated"` | Remove thought signatures from older repeated calls only. Use `"none"` to disable pruning or `"all"` to prune more aggressively. |
| `dryRun` | `false` | Detect and log without mutating the outgoing request. |

Set `GEMINI_DEJAVU_VERBOSE=1` to log rewrites:

```bash
GEMINI_DEJAVU_VERBOSE=1 opencode
```

## When to use it

Reach for this plugin when all of these are true:

- You're using Gemini 3.x in OpenCode.
- The agent is making progress in text, but the tool call keeps snapping back to the same action.
- The repeated call has the same tool name and effectively the same arguments.
- You want a mitigation that leaves the persisted session history alone.

Skip it when:

- You're not using Gemini 3.x.
- You're debugging raw Gemini request payloads and need every thought signature preserved exactly.
- Your workflow intentionally performs identical back-to-back tool calls and you don't want a loop breaker involved.

## What it changes

The plugin runs in OpenCode's `experimental.chat.messages.transform` hook.

When it detects a repeated Gemini 3.x tool-call tail, it:

1. Finds the latest meaningful user message. Empty continuation messages are ignored.
2. Finds repeated assistant tool-call batches after that user message.
3. Inserts a request-local `role: "user"` boundary immediately before the latest repeated tool-call message.
4. Prunes older repeated `thoughtSignature` values by default.
5. Preserves the latest current-turn tool call signatures.

The boundary text is short on purpose:

```text
Continue from the evidence above. Treat the following tool result as the latest completed step for this generation.
```

The saved OpenCode transcript is not rewritten. The change exists only in the outgoing request for that generation.

## Why this helps

The failure mode is not just "the model called a tool twice." In the captured repro used to build this plugin, the model's reasoning moved on, while the emitted `functionCall` kept returning to an older `read(...)` call. Exact preservation of call IDs and available Gemini thought signatures did not stop the repeat.

The working mitigation was a request-local turn boundary: make the latest completed tool result look like the current step, then remove older repeated signatures that were pulling the model back into the stale call.

That is all this package does. No cache, no database, no model setting changes, no transcript migration.

## Verification

This plugin was checked against the OpenCode loop that motivated it:

- Plugin off: continuing the imported looping session caused Gemini to call the same `read(...)` tool again.
- Plugin on: the same continuation inserted one request-local boundary, pruned older repeated signatures, and the assistant finished without making a new tool call.

Local package checks:

```bash
bun run prepublishOnly
node -e "import('./dist/plugin.js').then((m) => console.log(m.default.id))"
bun pm pack --dry-run
```

The test harness uses a repo-local fixture. It is not included in the npm tarball.

## Package facts

```yaml
name: opencode-gemini-dejavu
type: opencode-plugin
runtime: node >=18.17
models: gemini-3.x
hook: experimental.chat.messages.transform
entrypoint: dist/plugin.js
types: dist/plugin.d.ts
published_files:
  - dist
  - README.md
```

Runtime code uses standard Node APIs: `node:crypto`, `structuredClone`, and `console`. Bun is used for development scripts, tests, and packaging checks, not for the published plugin runtime.

`@opencode-ai/plugin` is a dev dependency for the official OpenCode plugin types. The compiled JavaScript does not import it.

## Build and publish

```bash
bun install
bun run prepublishOnly
bun pm pack --dry-run
```

Publish with npm if it is available:

```bash
npm publish --access public
```

Or publish with Bun after npm authentication is configured:

```bash
bunx npm login
bun publish --access public
```

`publishConfig.access` is already set to `public`, but passing `--access public` makes the registry intent explicit.
