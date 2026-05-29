import { readFileSync } from "node:fs";
import { rewriteMessagesForTest } from "./plugin";

const dumpDir = process.argv[2] ?? "fixtures/minimal-loop";
const messages = JSON.parse(readFileSync(`${dumpDir}/messages.json`, "utf8"));
type FixturePart = { type?: string; metadata?: { google?: { thoughtSignature?: string }; vertex?: { thoughtSignature?: string } } };

const beforeCount = messages.length;
const result = rewriteMessagesForTest(messages, { callRepeat: 3, batchRepeat: 2, prune: "repeated" });
const boundaryIndex = messages.findIndex((message: { info?: { id?: string } }) => message.info?.id?.startsWith("gemini-dejavu_boundary_"));
const signedBeforeBoundary = messages
  .slice(0, boundaryIndex < 0 ? 0 : boundaryIndex)
  .flatMap(
    (message: {
      parts?: Array<{ type?: string; metadata?: { google?: { thoughtSignature?: string }; vertex?: { thoughtSignature?: string } } }>;
    }) => message.parts ?? [],
  )
  .filter(
    (part: FixturePart) => part.type === "tool" && (part.metadata?.google?.thoughtSignature || part.metadata?.vertex?.thoughtSignature),
  ).length;
const signedAfterBoundary = messages
  .slice(boundaryIndex < 0 ? messages.length : boundaryIndex + 1)
  .flatMap(
    (message: {
      parts?: Array<{ type?: string; metadata?: { google?: { thoughtSignature?: string }; vertex?: { thoughtSignature?: string } } }>;
    }) => message.parts ?? [],
  )
  .filter(
    (part: FixturePart) => part.type === "tool" && (part.metadata?.google?.thoughtSignature || part.metadata?.vertex?.thoughtSignature),
  ).length;

if (!result.rewritten) throw new Error("expected fixture rewrite");
if (messages.length !== beforeCount + 1) throw new Error("expected one inserted boundary message");
if (boundaryIndex < 0) throw new Error("expected boundary message");
if (messages[boundaryIndex]?.info?.role !== "user") throw new Error("expected user-role boundary");
if (signedBeforeBoundary !== 0) throw new Error("expected repeated pre-boundary signatures to be pruned");
if (signedAfterBoundary < 1) throw new Error("expected latest current-turn signature to remain");

console.log(
  JSON.stringify(
    {
      rewritten: result.rewritten,
      reason: result.reason,
      beforeCount,
      afterCount: messages.length,
      insertedAt: result.insertedAt,
      pruned: result.pruned,
      boundaryIndex,
      boundaryRole: boundaryIndex >= 0 ? messages[boundaryIndex]?.info?.role : null,
      signedBeforeBoundary,
      signedAfterBoundary,
    },
    null,
    2,
  ),
);
