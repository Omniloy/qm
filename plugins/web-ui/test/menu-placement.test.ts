import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { toggleFormMenu, closeFormMenus } from "../src/ui.ts";

for (const scenario of [
  { name: "opens upward inside a shorter dialog", dialog: true, anchorTop: 340, upward: true },
  { name: "stays downward when the dialog has room", dialog: true, anchorTop: 200, upward: false },
  { name: "keeps viewport placement outside dialogs", dialog: false, anchorTop: 340, upward: false },
  { name: "opens upward at the viewport bottom", dialog: false, anchorTop: 710, upward: true },
]) {
  test(`form menu ${scenario.name}`, () => {
    const dom = new JSDOM(
      `<body>${scenario.dialog ? "<dialog open>" : ""}<div class="form-menu-control"><button class="menu-button"></button><div class="menu-popover" hidden></div></div>${scenario.dialog ? "</dialog>" : ""}</body>`,
    );
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
    try {
      const document = dom.window.document;
      const control = document.querySelector<HTMLElement>(".form-menu-control")!;
      const button = document.querySelector<HTMLButtonElement>("button")!;
      const menu = document.querySelector<HTMLElement>(".menu-popover")!;
      const box = (x: number, y: number, width: number, height: number) => new dom.window.DOMRect(x, y, width, height);
      const dialog = document.querySelector("dialog");
      if (dialog) dialog.getBoundingClientRect = () => box(100, 100, 440, 300);
      control.getBoundingClientRect = () => box(300, scenario.anchorTop, 100, 30);
      menu.getBoundingClientRect = () => box(300, scenario.anchorTop + 36, 170, 110);
      button.addEventListener("click", toggleFormMenu);
      button.click();
      assert.equal(menu.hidden, false);
      assert.equal(menu.classList.contains("drop-up"), scenario.upward);
      assert.equal(button.getAttribute("aria-expanded"), "true");
      closeFormMenus();
      assert.equal(menu.hidden, true);
      assert.equal(menu.classList.contains("drop-up"), false);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
      dom.window.close();
    }
  });
}

for (const scenario of [
  { name: "opens upward near the bottom of the page", anchorTop: 700, upward: true },
  { name: "stays downward with room below", anchorTop: 200, upward: false },
]) {
  test(`row menu ${scenario.name}`, async () => {
    const dom = new JSDOM(
      `<body><div class="pane"><div class="row-menu"><div class="session-menu-popover"></div></div></div></body>`,
    );
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
    try {
      const { placeMenuPopover } = await import("../src/row-actions.ts");
      const document = dom.window.document;
      const box = (y: number, height: number) => new dom.window.DOMRect(0, y, 200, height);
      Object.defineProperty(dom.window, "innerHeight", { value: 800, configurable: true });
      document.querySelector<HTMLElement>(".pane")!.getBoundingClientRect = () => box(0, 800);
      document.querySelector<HTMLElement>(".row-menu")!.getBoundingClientRect = () => box(scenario.anchorTop, 30);
      const menu = document.querySelector<HTMLElement>(".session-menu-popover")!;
      menu.getBoundingClientRect = () => box(scenario.anchorTop + 34, 190);
      placeMenuPopover(menu);
      assert.equal(menu.classList.contains("drop-up"), scenario.upward);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (previousElement) Object.defineProperty(globalThis, "HTMLElement", previousElement);
      else Reflect.deleteProperty(globalThis, "HTMLElement");
      dom.window.close();
    }
  });
}
