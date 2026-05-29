import { readFileSync } from "node:fs";
import pluginModule from "./plugin";

type FixturePart = { type?: string; metadata?: { google?: { thoughtSignature?: string }; vertex?: { thoughtSignature?: string } } };
type FixtureMessage = { info?: { id?: string; role?: string }; parts?: FixturePart[] };

const dumpDir = process.argv[2] ?? "fixtures/minimal-loop";
const messages = JSON.parse(readFileSync(`${dumpDir}/messages.json`, "utf8")) as FixtureMessage[];
const output = { messages: structuredClone(messages) };
const hooks = await pluginModule.server({} as never, { callRepeat: 3, batchRepeat: 2, prune: "repeated" });
const hook = hooks["experimental.chat.messages.transform"];
if (!hook) throw new Error("messages transform hook missing");

await hook({}, output as never);

const boundaryIndex = output.messages.findIndex((message) => message.info?.id?.startsWith("gemini-dejavu_boundary_"));
const signedBeforeBoundary = output.messages
  .slice(0, boundaryIndex < 0 ? 0 : boundaryIndex)
  .flatMap((message) => message.parts ?? [])
  .filter((part) => part.type === "tool" && (part.metadata?.google?.thoughtSignature || part.metadata?.vertex?.thoughtSignature)).length;
const signedAfterBoundary = output.messages
  .slice(boundaryIndex < 0 ? output.messages.length : boundaryIndex + 1)
  .flatMap((message) => message.parts ?? [])
  .filter((part) => part.type === "tool" && (part.metadata?.google?.thoughtSignature || part.metadata?.vertex?.thoughtSignature)).length;

if (output.messages.length !== messages.length + 1) throw new Error("expected one inserted boundary message");
if (boundaryIndex < 0) throw new Error("expected boundary message");
if (output.messages[boundaryIndex]?.info?.role !== "user") throw new Error("expected user-role boundary");
if (signedBeforeBoundary !== 0) throw new Error("expected repeated pre-boundary signatures to be pruned");
if (signedAfterBoundary < 1) throw new Error("expected latest current-turn signature to remain");

console.log(
  JSON.stringify(
    {
      beforeCount: messages.length,
      afterCount: output.messages.length,
      boundaryIndex,
      boundaryRole: boundaryIndex >= 0 ? output.messages[boundaryIndex]?.info?.role : null,
      signedBeforeBoundary,
      signedAfterBoundary,
    },
    null,
    2,
  ),
);
