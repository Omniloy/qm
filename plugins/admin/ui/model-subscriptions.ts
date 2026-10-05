import { html, nothing } from "lit";
import { mountTemplate } from "./shared.ts";
type Data = Record<string, any>;
const DAY_MS = 86_400_000;
const TOKEN_LIFETIME_DAYS = 365;
const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};
const RESET_LABEL = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
let context: Data = {};
const claude = { status: null as Data | null, token: "", busy: false, message: "", tone: "" };
const chatgpt = {
  state: "Checking…",
  available: true,
  account: "",
  accounts: [] as Data[],
  pending: null as { url: string; expiresAt: number } | null,
  callback: "",
  busy: false,
  message: "",
  tone: "",
};
let countdown: ReturnType<typeof setInterval> | undefined;
let redrawClaude = () => {};
let redrawChatgpt = () => {};
export function configure(options: Data) {
  context = options;
}
export async function load() {
  await Promise.all([loadClaude(), loadChatgpt()]);
}
export function describeSubscription(status: Data | null, now = Date.now()): string {
  if (!status?.configured) return "No subscription configured — the Claude harness bills the Anthropic API key.";
  const added = status.updatedAt ? new Date(status.updatedAt) : null;
  const by = status.updatedBy ? " by " + status.updatedBy : "";
  if (!added) return "Active" + by + ".";
  const daysLeft = Math.ceil((added.getTime() + TOKEN_LIFETIME_DAYS * DAY_MS - now) / DAY_MS);
  let life = " — expires in " + daysLeft + " days";
  if (daysLeft <= 30) life += ", generate a new one soon";
  if (daysLeft <= 0) life = " — expired, generate a new one";
  return "Active, added " + added.toLocaleDateString() + by + life + ".";
}
function limitWindow(minutes?: number): string {
  if (minutes === 10_080) return "Weekly usage";
  if (minutes === 1_440) return "Daily usage";
  if (minutes && minutes % 60 === 0) return minutes / 60 + "-hour usage";
  return "Usage";
}
export function describeChatgptAccount(account: Data): string {
  const limit = account.usageLimit;
  const tags = [
    ...(account.plan
      ? ["ChatGPT " + ((Object.hasOwn(PLAN_LABELS, account.plan) && PLAN_LABELS[account.plan]) || account.plan)]
      : []),
    ...(limit || account.status === "active" ? [] : [account.status]),
  ];
  const signedIn =
    "Signed in as " + (account.email || account.name) + (tags.length ? " (" + tags.join(", ") + ")" : "") + ".";
  if (!limit) return signedIn;
  const resets = limit.resetsAt ? "; resets " + RESET_LABEL.format(limit.resetsAt) + " UTC" : "";
  return signedIn + " " + limitWindow(limit.windowMinutes) + " limit reached" + resets + ".";
}
async function loadClaude() {
  const response = await context.api("GET", "/api/harness-auth");
  claude.status =
    (response.ok && (response.data?.harnesses || []).find((item: Data) => item.harnessId === "claude")) || null;
  redrawClaude();
}
function sayClaude(message: string, tone: string) {
  claude.message = message;
  claude.tone = tone;
  redrawClaude();
}
async function saveClaude() {
  const token = claude.token.trim();
  if (!token) return sayClaude("Paste the token from claude setup-token.", "err");
  claude.busy = true;
  sayClaude("Checking the token with Claude…", "saving");
  try {
    const saved = await context.api("PUT", "/api/harness-auth/claude", { token });
    if (!saved.ok) return sayClaude(saved.data?.message || "Claude rejected this token.", "err");
    claude.token = "";
    await loadClaude();
    sayClaude("Subscription saved. Claude-harness turns stop billing the API key.", "ok");
  } finally {
    claude.busy = false;
    redrawClaude();
  }
}
async function disableClaude() {
  if (!confirm("Disable the subscription? Claude-harness turns go back to billing the Anthropic API key.")) return;
  claude.busy = true;
  redrawClaude();
  try {
    const response = await context.api("DELETE", "/api/harness-auth/claude");
    await loadClaude();
    sayClaude(response.ok ? "Subscription disabled." : "That could not be disabled.", response.ok ? "ok" : "err");
  } finally {
    claude.busy = false;
    redrawClaude();
  }
}
async function loadChatgpt(): Promise<boolean> {
  const response = await context.api("GET", "/api/codex-auth");
  chatgpt.available = response.status !== 503;
  chatgpt.account = "";
  chatgpt.accounts = [];
  if (!chatgpt.available) chatgpt.state = "No ChatGPT proxy is configured on this instance.";
  else if (!response.ok) chatgpt.state = "The proxy could not be reached.";
  else {
    const live = (response.data?.accounts || []).filter((account: Data) => !account.disabled);
    chatgpt.accounts = live;
    chatgpt.account = live[0]?.name || "";
    chatgpt.state = live.length ? "" : "No ChatGPT account connected.";
  }
  redrawChatgpt();
  return Boolean(chatgpt.account);
}
function sayChatgpt(message: string, tone: string) {
  chatgpt.message = message;
  chatgpt.tone = tone;
  redrawChatgpt();
}
function endPending() {
  clearInterval(countdown);
  countdown = undefined;
  chatgpt.pending = null;
}
function tick() {
  if (chatgpt.pending && chatgpt.pending.expiresAt <= Date.now()) {
    endPending();
    return sayChatgpt("That link expired. Start again.", "err");
  }
  redrawChatgpt();
}
async function startChatgpt() {
  chatgpt.busy = true;
  sayChatgpt("Starting…", "");
  try {
    const response = await context.api("POST", "/api/codex-auth/start");
    if (!response.ok) return sayChatgpt(response.data?.message || "The sign-in could not be started.", "err");
    endPending();
    chatgpt.pending = { url: response.data.url, expiresAt: response.data.expiresAt };
    chatgpt.callback = "";
    countdown = setInterval(tick, 1000);
    sayChatgpt("Open the link, then paste where it lands.", "ok");
  } finally {
    chatgpt.busy = false;
    redrawChatgpt();
  }
}
async function waitForAccount() {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await loadChatgpt()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
async function completeChatgpt() {
  const callback = chatgpt.callback.trim();
  if (!callback) return sayChatgpt("Paste the address the sign-in ended on.", "err");
  chatgpt.busy = true;
  redrawChatgpt();
  try {
    const response = await context.api("POST", "/api/codex-auth/complete", { callback });
    if (!response.ok) return sayChatgpt(response.data?.message || "That sign-in could not be finished.", "err");
    endPending();
    const connected = await waitForAccount();
    sayChatgpt(
      connected
        ? "Signed in. GPT models now bill the subscription."
        : "The sign-in was accepted but no account has appeared yet. Reload in a moment.",
      connected ? "ok" : "err",
    );
  } finally {
    chatgpt.busy = false;
    redrawChatgpt();
  }
}
async function signOutChatgpt(name = chatgpt.account) {
  if (!name || !confirm("Sign this ChatGPT account out? GPT models stop working until one is signed in again.")) return;
  chatgpt.busy = true;
  redrawChatgpt();
  try {
    const response = await context.api("DELETE", "/api/codex-auth?name=" + encodeURIComponent(name));
    await loadChatgpt();
    sayChatgpt(response.ok ? "Signed out." : "That could not be signed out.", response.ok ? "ok" : "err");
  } finally {
    chatgpt.busy = false;
    redrawChatgpt();
  }
}
const status = (id: string, message: string, tone: string) =>
  html`<span class=${"status" + (tone ? " " + tone : "")} id=${id}>${message}</span>`;
function remaining(expiresAt: number) {
  const secs = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  return `expires in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}
function claudeTemplate() {
  return html`<section class="card sv-models" id="card-claude-subscription">
    <div class="head">
      <h2>Claude subscription</h2>
      <p>
        Optional. Runs the Claude harness on a Claude subscription instead of per-token API billing. Generate a token
        with <code>claude setup-token</code> — it needs a Pro, Max, Team, or Enterprise plan, lasts a year, and is
        printed once. Saving checks it against Claude before storing it write-only. The Anthropic API key stays in place
        for the other harnesses; the Claude harness stops using it, because Claude Code prefers an API key over a
        subscription and would otherwise keep billing it silently.
      </p>
    </div>
    <div class="body setup-form">
      <label
        >Subscription token
        <input
          type="password"
          id="harness-claude-token"
          autocomplete="off"
          placeholder="sk-ant-oat01-…"
          .value=${claude.token}
          ?disabled=${claude.busy}
          @input=${(e: Event) => {
            claude.token = (e.target as HTMLInputElement).value;
          }}
      /></label>
      <p class="muted" id="harness-claude-state">${describeSubscription(claude.status)}</p>
    </div>
    <div class="foot">
      <button class="primary" id="harness-claude-save" ?disabled=${claude.busy} @click=${saveClaude}>
        Validate and save</button
      ><button
        class="danger"
        id="harness-claude-delete"
        ?disabled=${claude.busy || !claude.status?.configured}
        @click=${disableClaude}
      >
        Disable</button
      >${status("st-harness-claude", claude.message, claude.tone)}
    </div>
  </section>`;
}
function chatgptTemplate() {
  const pending = chatgpt.pending;
  return html`<section class="card sv-models" id="card-chatgpt-subscription">
    <div class="head">
      <h2>ChatGPT subscription</h2>
      <p>
        Optional. Runs GPT models on a ChatGPT subscription instead of an OpenAI API key. Sign in below and the proxy
        holds the account and keeps it refreshed — no token is stored here and none is pasted. The sign-in ends at a
        <code>localhost</code> address that will not load, because the proxy is on the server and not on your machine;
        copy that address back into the box. A link is good for five minutes.
      </p>
    </div>
    <div class="body setup-form">
      <p class="muted" id="codex-auth-state">
        ${
          chatgpt.state ||
          chatgpt.accounts.map(
            (account) =>
              html`<span class="codex-account"
                >${describeChatgptAccount(account)}${
                  chatgpt.accounts.length > 1
                    ? html` <button
                        class="danger"
                        data-codex-account=${account.name}
                        ?disabled=${chatgpt.busy}
                        @click=${() => signOutChatgpt(account.name)}
                      >
                        Sign out
                      </button>`
                    : nothing
                }</span
              >`,
          )
        }
      </p>
      ${
        pending
          ? html`<div id="codex-auth-step">
              <p>
                <a id="codex-auth-link" href=${pending.url} target="_blank" rel="noopener noreferrer"
                  >Open the ChatGPT sign-in</a
                >
                <span class="muted" id="codex-auth-countdown">${remaining(pending.expiresAt)}</span>
              </p>
              <label
                >Address the sign-in ended on
                <input
                  type="text"
                  id="codex-auth-callback"
                  autocomplete="off"
                  placeholder="http://localhost:1455/auth/callback?code=…&state=…"
                  .value=${chatgpt.callback}
                  @input=${(e: Event) => {
                    chatgpt.callback = (e.target as HTMLInputElement).value;
                  }}
              /></label>
            </div>`
          : nothing
      }
    </div>
    <div class="foot">
      ${
        pending
          ? html`<button class="primary" id="codex-auth-complete" ?disabled=${chatgpt.busy} @click=${completeChatgpt}>
              Finish sign-in
            </button>`
          : html`<button
              class="primary"
              id="codex-auth-start"
              ?disabled=${chatgpt.busy || !chatgpt.available}
              @click=${startChatgpt}
            >
              Sign in with ChatGPT
            </button>`
      }${
        chatgpt.accounts.length > 1
          ? nothing
          : html`<button
              class="danger"
              id="codex-auth-delete"
              ?disabled=${chatgpt.busy || !chatgpt.account}
              @click=${() => signOutChatgpt()}
            >
              Sign out
            </button>`
      }${status("st-codex-auth", chatgpt.message, chatgpt.tone)}
    </div>
  </section>`;
}
export function mount() {
  redrawClaude = mountTemplate('template[data-settings-card="card-claude-subscription"]', claudeTemplate);
  redrawChatgpt = mountTemplate('template[data-settings-card="card-chatgpt-subscription"]', chatgptTemplate);
}
