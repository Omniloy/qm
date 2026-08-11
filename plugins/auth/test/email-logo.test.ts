import assert from "node:assert/strict";
import test from "node:test";
import { renderSignInEmail } from "../src/email.ts";

function logoSrc(link: string): string | undefined {
  const email = renderSignInEmail({ to: "a@b.test", brandName: "Miniomni", link, ttlMinutes: 10 });
  return /<img src="([^"]+)"/.exec(email.html ?? "")?.[1];
}

test("the email logo resolves inside the auth mount, not the site root", () => {
  assert.equal(logoSrc("https://qm.omniloy.com/idp/verify#tok"), "https://qm.omniloy.com/idp/brand/logo.png");
});

test("an auth service at an origin root still gets a correct logo url", () => {
  assert.equal(logoSrc("https://auth.example.com/verify#tok"), "https://auth.example.com/brand/logo.png");
});

test("an unusable link drops the image rather than emitting a broken one", () => {
  const email = renderSignInEmail({ to: "a@b.test", brandName: "Miniomni", link: "not-a-url", ttlMinutes: 10 });
  assert.doesNotMatch(email.html ?? "", /<img/);
  assert.match(email.subject, /Sign in to Miniomni/);
});
