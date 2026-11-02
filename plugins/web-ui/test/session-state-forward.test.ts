import { test } from "node:test";
import assert from "node:assert/strict";

process.env.CORE_API_URL = "http://localhost:9";
process.env.CORE_ORG_ID = "acme";
process.env.CORE_SIGNING_SECRET = "session-state-forward-test";

const { sessionStateDeliveries } = await import("../server/index.ts");

test("a security hold reaches only the participants who own it, and the hold owners are never forwarded", () => {
  const deliveries = sessionStateDeliveries({
    threadRef: "slack:C1:1",
    state: "awaiting_approval",
    participants: ["ana", "bob"],
    heldFor: ["bob"],
  });
  assert.deepEqual(deliveries, [
    ["ana", { threadRef: "slack:C1:1", state: "awaiting_approval" }],
    ["bob", { threadRef: "slack:C1:1", state: "awaiting_approval", securityHeld: true }],
  ]);
});

test("a frame without participants still reaches the web thread's owner", () => {
  assert.deepEqual(sessionStateDeliveries({ threadRef: "web:ana:voice:1", state: "idle" }), [
    ["ana", { threadRef: "web:ana:voice:1", state: "idle" }],
  ]);
});
