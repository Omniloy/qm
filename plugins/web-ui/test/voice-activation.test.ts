import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><button>mic</button></body></html>", {
  url: "http://localhost/",
  virtualConsole: new VirtualConsole(),
});
for (const [key, value] of Object.entries({ document: dom.window.document, navigator: dom.window.navigator }))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { onFirstActivation } = await import("../src/voice-assistant/activation.ts");

test("the first click reaches its own handler before the deferred auto-start runs", async () => {
  const order: string[] = [];
  const button = dom.window.document.querySelector("button")!;
  button.addEventListener("click", () => order.push("toggle"));
  onFirstActivation(() => order.push("auto-start"));
  button.click();
  assert.deepEqual(order, ["toggle"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ["toggle", "auto-start"]);
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ["toggle", "auto-start", "toggle"]);
});
