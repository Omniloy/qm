import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { card, table, renderer } from "./shared.ts";
import { choiceGroup } from "./setting-controls.ts";
import type { Context, Data } from "./artifacts.ts";
const badge = (text: unknown, tone = "muted", title = "") =>
  html`<span class=${"badge " + tone} title=${ifDefined(title || undefined)}>${text}</span>`;
const stacked = (name: unknown, desc: unknown) =>
  html`<div>
    <div class="primaryline">${name}</div>
    ${desc ? html`<div class="subline">${desc}</div>` : nothing}
  </div>`;
export async function removeSkill(s: Data, c: Context) {
  if (
    !confirm(
      "Remove '" +
        (s.name || s.id) +
        "' from " +
        (c.dirLabel(s.ownerScopeId) || s.ownerScopeId) +
        "? It stops being available to agents (kept for audit).",
    )
  )
    return;
  try {
    const response = await c.api(
      "DELETE",
      "/api/skills/" + encodeURIComponent(s.id) + "?scope=" + encodeURIComponent(s.ownerScopeId || c.scope),
    );
    if (!response.ok) {
      alert(response.data?.message || "1 scope(s) could not be removed.");
      return;
    }
    c.invalidate();
    await c.reload();
  } catch {
    alert("Could not remove skill.");
  }
}
let detailRequestSeq = 0;
export async function skillDetail(root: HTMLElement, rep: Data, group: Data[], c: Context) {
  const request = ++detailRequestSeq;
  root.replaceChildren();
  const paint = renderer(root);
  paint(html`<div class="loadingline">${"Loading " + (rep.name || rep.id) + "…"}</div>`);
  const response = await c.api(
    "GET",
    "/api/skills/" + encodeURIComponent(rep.id) + "?scope=" + encodeURIComponent(rep.ownerScopeId || c.scope),
  );
  if (request !== detailRequestSeq) return;
  if (!response.ok || !response.data) {
    paint(
      html`<p class="empty">
        ${response.status === 403 ? "You don't administer this skill's scope." : "Couldn't load this skill."}
      </p>`,
    );
    return;
  }
  const k = response.data;
  const source = (() => {
    if (k.pack) return "from " + (c.packRepoLabel(k.pack.url) || "pack " + c.shortId(k.pack.id, 8));
    if (k.createdBy?.startsWith("pack:")) return "from pack " + c.shortId(k.createdBy.slice(5), 8);
    return k.createdBy?.startsWith("system:") ? "built-in" : "";
  })();
  const by = source || "by " + (k.createdBy || "None");
  const editable = !source && k.status !== "archived";
  const org = "org:" + c.orgId;
  const adminPath = (id: string, action: string) =>
    "/api/skills/" + encodeURIComponent(id) + "/" + action + "?scope=" + encodeURIComponent(org);
  let ownership: { mode: "transfer" | "move"; owner: string; home: string; busy: boolean; message: string } | null =
    null;
  let mergeMessage = "";
  const homeChoices = () => [
    { scopeId: org, label: "org-wide" },
    ...c.scopeRows().map((r: Data) => ({ scopeId: r.scopeId, label: r.label || c.dirLabel(r.scopeId) || r.scopeId })),
  ];
  const submitOwnership = async () => {
    const o = ownership;
    if (!o || o.busy) return;
    const body =
      o.mode === "transfer"
        ? { ownerId: o.owner.trim(), ...(o.home ? { homeScope: o.home } : {}) }
        : { toScope: o.home };
    if (o.mode === "transfer" ? !o.owner.trim() : !o.home) {
      o.message = o.mode === "transfer" ? "Enter the new owner." : "Pick a home.";
      return draw();
    }
    o.busy = true;
    o.message = "Saving…";
    draw();
    const result = await c
      .api("POST", adminPath(k.id, o.mode === "transfer" ? "owner" : "move"), body)
      .catch(() => ({ ok: false, data: null }));
    if (ownership !== o || request !== detailRequestSeq) return;
    if (!result.ok) {
      o.busy = false;
      o.message = result.data?.message || "Failed.";
      return draw();
    }
    c.invalidate();
    await c.reload();
  };
  const mergeInto = async (from: Data) => {
    const run = (force: boolean) =>
      c
        .api("POST", adminPath(from.id, "merge"), { into: k.id, ...(force ? { force: true } : {}) })
        .catch(() => ({ ok: false, data: null }));
    let result = await run(false);
    if (!result.ok && result.data?.error === "diverged") {
      const diff = result.data.diff || {};
      const summary =
        (diff.description ? "description differs; " : "") +
        "body " +
        (diff.bodyDeltaChars >= 0 ? "+" : "") +
        diff.bodyDeltaChars +
        " chars" +
        (diff.files?.length ? "; files: " + diff.files.join(", ") : "");
      if (!confirm("These copies differ (" + summary + "). Merge anyway, with the owner's approval?")) return;
      result = await run(true);
    }
    if (request !== detailRequestSeq) return;
    if (!result.ok) {
      mergeMessage = result.data?.message || "Merge failed.";
      return draw();
    }
    c.invalidate();
    await c.reload();
  };
  const ownerText = k.ownerId ? c.dirLabel("personal:" + k.ownerId) || k.ownerId : "Built-in";
  const sharedChips = [
    ...(k.orgWide && c.scopeKind(k.ownerScopeId) !== "org" ? [badge("Everyone", "ok")] : []),
    ...(k.sharedWith || [])
      .filter((g: Data) => g.scopeId !== org)
      .map((g: Data) => badge((c.dirLabel(g.scopeId) || g.scopeId) + (g.permission === "write" ? " (edit)" : ""))),
  ];
  const ownershipForm = (o: NonNullable<typeof ownership>) =>
    html`<div class="skill-ownership-form">
      ${
        o.mode === "transfer"
          ? html`<label for="skill-owner-input">New owner (email or id)</label
              ><input
                id="skill-owner-input"
                .value=${o.owner}
                ?disabled=${o.busy}
                @input=${(ev: Event) => {
                  o.owner = (ev.target as HTMLInputElement).value;
                }}
              />`
          : nothing
      }
      ${
        o.mode === "move" || c.scopeKind(k.ownerScopeId) === "personal"
          ? html`<label for="skill-home-select">${o.mode === "move" ? "New home" : "New home (optional)"}</label
              ><select
                id="skill-home-select"
                ?disabled=${o.busy}
                @change=${(ev: Event) => {
                  o.home = (ev.target as HTMLSelectElement).value;
                }}
              >
                <option value="" ?selected=${!o.home}>
                  ${o.mode === "move" ? "Pick a home" : "The new owner's personal skills"}
                </option>
                ${homeChoices()
                  .filter((h) => h.scopeId !== k.ownerScopeId && (o.mode === "move" || !h.scopeId.startsWith("org:")))
                  .map((h) => html`<option value=${h.scopeId} ?selected=${o.home === h.scopeId}>${h.label}</option>`)}
              </select>`
          : nothing
      }
      <p class="metric-note">
        ${o.mode === "transfer" ? "The new owner can edit, share, move or transfer it; they are notified." : "Grants move with it."}
      </p>
      <div class="foot">
        <button type="button" class="primary" ?disabled=${o.busy} @click=${submitOwnership}>
          ${o.mode === "transfer" ? "Transfer" : "Move"}</button
        ><button
          type="button"
          ?disabled=${o.busy}
          @click=${() => {
            ownership = null;
            draw();
          }}
        >
          Cancel</button
        ><span class="status" role="status">${o.message}</span>
      </div>
    </div>`;
  let edit: { description: string; body: string; saving: boolean; message: string } | null = null;
  const startEdit = () => {
    edit = { description: k.description || "", body: k.body || "", saving: false, message: "" };
    draw();
  };
  const save = async () => {
    if (!edit || edit.saving) return;
    const current = edit;
    current.saving = true;
    current.message = "Saving…";
    draw();
    const result = await c
      .api("PUT", "/api/skills/" + encodeURIComponent(k.id) + "?scope=" + encodeURIComponent(k.ownerScopeId), {
        description: current.description,
        body: current.body,
      })
      .catch(() => ({ ok: false, data: null }));
    if (edit !== current || request !== detailRequestSeq) return;
    if (!result.ok) {
      current.saving = false;
      current.message = result.data?.message || "Save failed.";
      draw();
      return;
    }
    c.invalidate();
    await skillDetail(root, rep, group, c);
  };
  const editForm = (e: NonNullable<typeof edit>) =>
    html`<div class="skill-edit-form">
      <label for="skill-edit-description">Description</label
      ><input
        id="skill-edit-description"
        .value=${e.description}
        ?disabled=${e.saving}
        @input=${(ev: Event) => {
          e.description = (ev.target as HTMLInputElement).value;
        }}
      />
      <label for="skill-edit-body">Instructions</label
      ><textarea
        id="skill-edit-body"
        spellcheck="false"
        style="min-height:340px;font-family:ui-monospace, SFMono-Regular, Menlo, monospace;font-size:12px"
        .value=${e.body}
        ?disabled=${e.saving}
        @input=${(ev: Event) => {
          e.body = (ev.target as HTMLTextAreaElement).value;
        }}
      ></textarea>
      <p class="metric-note">Saving updates this skill in place for everyone who has it, right away.</p>
      <div class="foot">
        <button type="button" class="primary" ?disabled=${e.saving} @click=${save}>Save</button
        ><button
          type="button"
          ?disabled=${e.saving}
          @click=${() => {
            edit = null;
            draw();
          }}
        >
          Cancel</button
        ><span class="status" role="status">${e.message}</span>
      </div>
    </div>`;
  const draw = () =>
    paint(
      card(
        k.name || k.id,
        "",
        html`<div>
          <div class="badges">
            ${c.statusBadge(k.status)}${badge("v" + k.version)}${badge(by)}${badge("skill " + c.shortId(k.id, 16))}
          </div>
          ${k.description ? html`<p class="metric-note">${k.description}</p>` : nothing}${card(
            "Ownership",
            "Who owns this skill, where it lives, and who it is shared with.",
            html`<div class="badges">
                ${badge("Owner: " + ownerText)}${badge("Home: " + (c.dirLabel(k.ownerScopeId) || k.ownerScopeId))}${sharedChips}
              </div>
              ${ownership ? ownershipForm(ownership) : nothing}`,
            editable && !k.supersededBy && !ownership
              ? html`<button
                    type="button"
                    class="rowbtn skill-transfer"
                    @click=${() => {
                      ownership = { mode: "transfer", owner: "", home: "", busy: false, message: "" };
                      draw();
                    }}
                  >
                    Transfer…</button
                  ><button
                    type="button"
                    class="rowbtn skill-move"
                    @click=${() => {
                      ownership = { mode: "move", owner: "", home: "", busy: false, message: "" };
                      draw();
                    }}
                  >
                    Move…
                  </button>`
              : nothing,
          )}${card(
            "Other skills with this name",
            "Each is a separate skill. Merge one into this skill to retire it and move its shares here.",
            html`${table(
              ["Home", "Owner", "Status", "Version", ""],
              group
                .filter((g) => g.id !== k.id && !g.supersededBy)
                .map((g) => [
                  c.scopeCell(g.ownerScopeId),
                  { text: g.ownerId || "Built-in", cls: "mono" },
                  { node: c.statusBadge(g.status) },
                  { text: g.version != null ? "v" + g.version : "None", cls: "num" },
                  {
                    node:
                      g.sourceManaged || k.status !== "published"
                        ? nothing
                        : html`<button type="button" class="rowbtn skill-merge" @click=${() => mergeInto(g)}>
                            Merge into this
                          </button>`,
                  },
                ]),
              "No other skill has this name.",
            )}${mergeMessage ? html`<p class="status err" role="status">${mergeMessage}</p>` : nothing}`,
          )}${card(
            "Capabilities",
            "What the skill is allowed to reach. Granted at review time.",
            table(
              ["Capability", "Status"],
              (k.requiredCapabilities || []).map((cap: string) => [
                { text: cap, cls: "mono" },
                {
                  node: (k.grantedCapabilities || []).includes(cap)
                    ? badge("granted", "ok")
                    : badge("not granted", "warn"),
                },
              ]),
              "Requires no capabilities.",
            ),
          )}${
            k.approvals?.length
              ? card(
                  "Approvals",
                  "Reviewers who signed off on this skill.",
                  table(
                    ["Reviewer"],
                    k.approvals.map((a: string) => [{ text: a, cls: "mono" }]),
                    "",
                  ),
                )
              : nothing
          }${card(
            "Instructions",
            "The SKILL.md the agent reads when this skill is in play.",
            edit
              ? editForm(edit)
              : html`<pre
                  class="skillbody"
                  style="white-space:pre-wrap;font-family:ui-monospace, SFMono-Regular, Menlo, monospace;font-size:12px;margin:0"
                >
${k.body || "(empty)"}</pre>`,
            editable && !edit
              ? html`<button type="button" class="rowbtn skill-edit" @click=${startEdit}>Edit</button>`
              : nothing,
          )}
        </div>`,
      ),
    );
  draw();
  root.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
export async function mountDuplicates(root: HTMLElement, c: Context) {
  const org = "org:" + c.orgId;
  const paint = renderer(root);
  let report: Data | null = null;
  let message = "";
  const busy = new Set<string>();
  const load = async () => {
    const response = await c.api("GET", "/api/skills/duplicates?scope=" + encodeURIComponent(org));
    if (!root.isConnected) return;
    report = response.ok && Array.isArray(response.data?.clusters) ? response.data : null;
    draw();
  };
  const call = (action: Data) =>
    c.api(
      action.method,
      action.path.replace(/^\/v1\/admin\//, "/api/") + "?scope=" + encodeURIComponent(org),
      action.body,
    );
  const run = async (key: string, steps: Array<() => Promise<Data>>) => {
    if (busy.has(key)) return;
    busy.add(key);
    message = "";
    draw();
    for (const step of steps) {
      const result = await step().catch(() => ({ ok: false, data: null }));
      if (!result.ok) {
        message = result.data?.message || "A step failed; the report shows what is left.";
        break;
      }
    }
    busy.delete(key);
    c.invalidate();
    await load();
  };
  const ids = (rows: Data[]) =>
    rows.map((r: Data) => c.shortId(r.id, 8) + " (" + (c.dirLabel(r.scopeId) || r.scopeId) + ")").join(", ");
  const diffText = (d: Data) =>
    (d.description ? "description differs · " : "") +
    "body " +
    (d.bodyDeltaChars >= 0 ? "+" : "") +
    d.bodyDeltaChars +
    " chars" +
    (d.files?.length ? " · files " + d.files.join(", ") : "");
  const cluster = (cl: Data) =>
    html`<div class="skill-duplicate" data-status=${cl.status}>
      <div class="badges">
        ${badge("/" + cl.name)}${badge(cl.status.replace("_", " "), cl.status === "auto" ? "ok" : "warn")}
      </div>
      ${cl.canonical ? html`<div class="subline">Keep ${ids([cl.canonical])}</div>` : nothing}
      ${cl.retire.length ? html`<div class="subline">Retire ${ids(cl.retire)}</div>` : nothing}
      ${cl.purge.length ? html`<div class="subline">Purge ${ids(cl.purge)}</div>` : nothing}
      ${cl.evidence.length ? html`<div class="subline">${cl.evidence.join(" · ")}</div>` : nothing}
      ${cl.diff ? html`<div class="subline">Differs: ${diffText(cl.diff)}</div>` : nothing}
      ${
        cl.status === "ambiguous"
          ? html`<div class="subline">Open the skill you want to keep and use "Merge into this" for each copy.</div>`
          : html`<button
              type="button"
              class="rowbtn skill-duplicate-merge"
              ?disabled=${busy.has(cl.name)}
              @click=${() =>
                run(
                  cl.name,
                  cl.actions.map((a: Data) => () => call(a)),
                )}
            >
              ${cl.status === "auto" ? "Merge" : "Merge anyway (owner approved)"}
            </button>`
      }
    </div>`;
  const draw = () => {
    if (!report) return paint(nothing);
    const r = report;
    paint(
      card(
        "Duplicate skills",
        "Org copies left behind by the old copy-on-promote, matched to the skill they came from. Merging keeps one skill, moves its shares over, and redirects the retired id.",
        html`${r.clusters.length ? r.clusters.map(cluster) : html`<p class="empty">No duplicates to merge.</p>`}
          ${
            r.nameClashes.length
              ? html`<h3>Same name, no shared history</h3>
                  ${r.nameClashes.map(
                    (n: Data) =>
                      html`<div class="subline">/${n.name}: ${ids(n.rows)}${n.note ? " · " + n.note : ""}</div>`,
                  )}`
              : nothing
          }
          ${
            r.archivedLeftovers.length
              ? html`<h3>Archived leftovers</h3>
                  ${r.archivedLeftovers.map(
                    (row: Data) =>
                      html`<div class="subline">
                        ${ids([row])}
                        <button
                          type="button"
                          class="rowbtn danger skill-purge"
                          ?disabled=${busy.has(row.id)}
                          @click=${() =>
                            confirm("Delete this archived skill for good?") &&
                            run(row.id, [
                              () => call({ method: "POST", path: "/v1/admin/skills/" + row.id + "/purge" }),
                            ])}
                        >
                          Purge
                        </button>
                      </div>`,
                  )}`
              : nothing
          }
          <h3>Owners</h3>
          <div class="subline">
            ${c.plural(r.ownerBackfill.pending, "skill")} without a recorded
            owner${
              r.ownerBackfill.personalHomeMismatch.length
                ? " · " +
                  c.plural(r.ownerBackfill.personalHomeMismatch.length, "personal skill") +
                  " created by someone else"
                : ""
            }
            ${
              r.ownerBackfill.pending
                ? html`<button
                    type="button"
                    class="rowbtn skill-backfill"
                    ?disabled=${busy.has("backfill")}
                    @click=${() =>
                      run("backfill", [
                        () =>
                          call({ method: "POST", path: "/v1/admin/skills/backfill-owners", body: { dryRun: false } }),
                      ])}
                  >
                    Run backfill
                  </button>`
                : nothing
            }
          </div>
          ${message ? html`<p class="status err" role="status">${message}</p>` : nothing}`,
      ),
    );
  };
  await load();
}
type Audience = "everyone" | "admins";
type SharingPolicy = { contexts: Audience; org: Audience };
export async function mountSharing(root: HTMLElement, c: Context) {
  const path = "/api/scopes/" + encodeURIComponent("org:" + c.orgId);
  const response = await c.api("GET", path + "?view=skills");
  if (!root.isConnected || !response.ok || !response.data?.skillSharing) return;
  const paint = renderer(root);
  let saved: SharingPolicy = response.data.skillSharing;
  let draft: SharingPolicy = { ...saved };
  let saving = false,
    message = "",
    tone = "";
  const dirty = () => draft.contexts !== saved.contexts || draft.org !== saved.org;
  const pick = (key: keyof SharingPolicy) => (e: Event) => {
    draft = { ...draft, [key]: (e.target as HTMLInputElement).value as Audience };
    message = dirty() ? "Unsaved changes" : "";
    tone = dirty() ? "dirty" : "";
    draw();
  };
  const save = async () => {
    if (saving || !dirty()) return;
    const body = { ...draft };
    saving = true;
    message = "Saving…";
    tone = "saving";
    draw();
    try {
      const result = await c.api("PUT", path + "/skill-sharing", body);
      if (result.ok) {
        saved = body;
        message = "Saved";
        tone = "ok";
      } else {
        message = result.data?.message || "Save failed.";
        tone = "err";
      }
    } catch {
      message = "Save failed.";
      tone = "err";
    } finally {
      saving = false;
      draw();
    }
  };
  const draw = () =>
    paint(
      html`<section class="card" id="card-skill-sharing">
        <div class="head">
          <h2>Skill sharing</h2>
          <p>
            Who may hand a skill they manage to other people. Applies org-wide and is enforced on every share, from the
            web UI or an agent.
          </p>
        </div>
        <div class="body">
          <h3>Other conversations and teammates</h3>
          ${choiceGroup({ name: "skill-sharing-contexts", value: draft.contexts, onChange: pick("contexts") }, [
            [
              "everyone",
              "Everyone",
              "Default. Anyone who manages a skill can share or move it into a conversation, channel, or teammate they're in.",
            ],
            [
              "admins",
              "Org admins only",
              "Members keep their skills personal. Only an admin can share or move one, or create or edit one in a shared conversation.",
            ],
          ])}
          <h3>The whole organization</h3>
          ${choiceGroup({ name: "skill-sharing-org", value: draft.org, onChange: pick("org") }, [
            ["admins", "Org admins only", "Default. Only an admin can give a skill to everyone or take one back."],
            [
              "everyone",
              "Everyone",
              "Any member can give a skill they manage to the whole organization, in person from the web app (never through an agent), and take back one they wrote. Replacing a skill the organization already has, or one a built-in skill reserves, stays with admins.",
            ],
          ])}
        </div>
        <div class="foot">
          <button class=${"primary" + (dirty() ? " dirty" : "")} ?disabled=${!dirty() || saving} @click=${save}>
            Save</button
          ><span class=${"status" + (tone ? " " + tone : "")} id="st-skill-sharing">${message}</span>
        </div>
      </section>`,
    );
  draw();
}
export async function mountPacks(root: HTMLElement, c: Context) {
  const response = await c.api("GET", "/api/skill-packs");
  if (!root.isConnected) return;
  packs(root, (response.ok && response.data?.packs) || [], c);
}
export function packs(root: HTMLElement, rows: Data[], c: Context) {
  const paint = renderer(root);
  const detail = document.createElement("div");
  const draft = { url: "", ref: "", exclude: "", slug: "", tier: "third-party" };
  let advanced = false,
    registering = false,
    message = "",
    tone = "",
    menu: string | null = null,
    menuTop = 0,
    menuLeft = 0;
  const statuses = new Map<string, Data>();
  const pending = new Set<string>();
  const closeMenu = () => {
    if (menu) {
      menu = null;
      draw();
    }
  };
  const abort = new AbortController();
  document.addEventListener("click", closeMenu, { signal: abort.signal });
  document.addEventListener("scroll", closeMenu, { signal: abort.signal, capture: true });
  window.addEventListener("resize", closeMenu, { signal: abort.signal });
  const observer = new MutationObserver(() => {
    if (!root.isConnected) {
      abort.abort();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const change = (key: keyof typeof draft) => (e: Event) => {
    draft[key] = (e.target as HTMLInputElement).value;
    draw();
  };
  const register = async () => {
    if (registering) return;
    if (!draft.url.trim()) {
      message = "A repo URL is required.";
      tone = "err";
      draw();
      return;
    }
    const submitted = JSON.stringify(draft);
    registering = true;
    message = "Registering…";
    tone = "";
    draw();
    const excluded = draft.exclude
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    try {
      const response = await c.api("POST", "/api/skill-packs", {
        url: draft.url.trim(),
        ...(draft.ref.trim() ? { ref: draft.ref.trim() } : {}),
        ...(excluded.length ? { config: { exclude: excluded } } : {}),
        ...(draft.slug.trim() ? { authCredentialSlug: draft.slug.trim() } : {}),
        ...(draft.tier !== "third-party" ? { trustTier: draft.tier } : {}),
      });
      if (!response.ok) {
        message = response.data?.message || "Failed (" + response.status + ").";
        tone = "err";
      } else {
        c.invalidate();
        if (JSON.stringify(draft) === submitted) await c.reload();
        else {
          message = "Pack registered. Your newer changes have not been registered.";
          tone = "ok";
        }
      }
    } catch {
      message = "Registration failed.";
      tone = "err";
    } finally {
      registering = false;
      draw();
    }
  };
  const act = async (s: Data, action: string) => {
    menu = null;
    if (action === "browse") {
      draw();
      void browsePack(s, detail, c);
      return;
    }
    if (pending.has(s.id)) return;
    if (action === "remove" && !confirm("Remove this pack and archive its imported skills?")) {
      draw();
      return;
    }
    pending.add(s.id);
    if (action === "sync") statuses.set(s.id, { text: "syncing…", tone: "saving" });
    draw();
    try {
      const path = "/api/skill-packs/" + encodeURIComponent(s.id);
      const response = await c.api(
        (() => {
          if (action === "remove") return "DELETE";
          return action === "sync" ? "POST" : "PATCH";
        })(),
        path + (action === "sync" ? "/sync" : ""),
        (() => {
          if (action === "sync") return {};
          return action === "track" ? { syncMode: s.syncMode === "tracked" ? "pinned" : "tracked" } : undefined;
        })(),
      );
      if (!response.ok) {
        statuses.set(s.id, {
          text: (action === "sync" ? "sync failed: " : "Failed: ") + (response.data?.message || response.status),
          tone: "err",
        });
        return;
      }
      if (action === "sync") {
        const data = response.data || {},
          n = (data.imported || []).length,
          u = (data.updated || []).length,
          a = (data.archived || []).length;
        statuses.set(s.id, {
          text:
            n || u || a
              ? "✓ " + n + " new" + (u ? " · " + u + " updated" : "") + (a ? " · " + a + " removed" : "")
              : "✓ up to date",
          tone: "ok",
        });
        setTimeout(() => {
          c.invalidate();
          if (root.isConnected) c.reload();
        }, 1200);
      } else {
        c.invalidate();
        await c.reload();
      }
    } catch {
      statuses.set(s.id, { text: "Request failed.", tone: "err" });
    } finally {
      pending.delete(s.id);
      draw();
    }
  };
  const input = (key: keyof typeof draft, placeholder: string, title?: string) =>
    html`<input
      type="text"
      placeholder=${placeholder}
      title=${ifDefined(title)}
      aria-label=${placeholder}
      spellcheck="false"
      .value=${draft[key]}
      @input=${change(key)}
    />`;
  const draw = () =>
    paint(
      html`${card(
        "Skill packs",
        "Register a repository, then choose which skills to import into each scope.",
        html`<div>
          <div class="pack-register">
            ${input("url", "Register a pack: paste a git repo URL of SKILL.md files, then Browse it into scopes")}<button
              type="button"
              class=${"linkish" + (advanced ? " open" : "")}
              aria-expanded=${String(advanced)}
              @click=${() => {
                advanced = !advanced;
                draw();
              }}
            >
              ${"Advanced" + (!advanced && (draft.ref.trim() || draft.exclude.trim() || draft.slug.trim() || draft.tier !== "third-party") ? " •" : "")}</button
            ><button type="button" class="primary" ?disabled=${registering} @click=${register}>Register</button
            ><span class=${"status" + (tone ? " " + tone : "")}>${message}</span>
          </div>
          <div class=${"pack-adv" + (advanced ? "" : " hidden")}>
            ${input("ref", "ref (branch or SHA)", "Pin to a branch or full 40-hex commit SHA. Blank = the repo's default branch.")}${input("exclude", "exclude globs, comma-separated", "e.g. trusted/*")}${input("slug", "deploy-token slug", "Private-repo deploy-token credential slug. Blank = your connected GitHub account.")}<select
              title="Trust tier"
              .value=${draft.tier}
              @change=${change("tier")}
            >
              <option value="third-party">trust: third-party</option>
              <option value="internal">trust: internal</option>
            </select>
          </div>
          ${table(
            ["Pack", "Skills", "Trust", "Status", ""],
            rows.map((s) => {
              const li = s.lastImport,
                counts = li?.counts || {},
                tracked = s.syncMode === "tracked";
              const delta = li
                ? "last sync: " +
                  (counts.imported || 0) +
                  " new · " +
                  (counts.updated || 0) +
                  " updated · " +
                  (counts.skipped || 0) +
                  " skipped" +
                  (counts.archived ? " · " + counts.archived + " removed" : "")
                : "";
              const status =
                statuses.get(s.id) ||
                (() => {
                  if (li?.status === "error")
                    return { text: "error: " + (li.error || "sync failed"), tone: "err", title: li.error || "" };
                  return s.updateAvailable
                    ? {
                        text: "update available",
                        tone: "dirty",
                        title: "Upstream advanced past the imported commit. Sync now (or turn on Auto-sync) to apply.",
                      }
                    : { text: li ? "up to date" : "not imported", tone: "muted", title: delta };
                })();
              return [
                {
                  node: html`<span class="pack-name" title=${s.url + (delta ? "\n" + delta : "")}
                    ><strong>${c.packRepoLabel(s.url) || s.url}</strong
                    >${s.ref ? html`<span class="subline">${" @ " + c.shortId(s.ref, 10)}</span>` : nothing}</span
                  >`,
                },
                {
                  node: html`<span
                    title=${ifDefined(s.available != null ? (s.importedCount || 0) + " imported · " + s.available + " available (eligible) in this pack" : undefined)}
                    >${s.available != null ? (s.importedCount || 0) + " of " + s.available : "n/a"}</span
                  >`,
                  cls: "num",
                },
                { text: s.trustTier + (tracked ? " · auto-sync" : ""), cls: "subline" },
                {
                  node: html`<span class=${"status " + status.tone} title=${ifDefined(status.title || undefined)}
                    >${status.text}</span
                  >`,
                },
                {
                  node: html`<div class="ovwrap">
                    <button
                      type="button"
                      class="rowbtn"
                      aria-label="Actions"
                      aria-haspopup="menu"
                      aria-expanded=${String(menu === s.id)}
                      @click=${(e: MouseEvent) => {
                        e.stopPropagation();
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        menu = menu === s.id ? null : s.id;
                        menuTop = r.bottom + 4;
                        menuLeft = r.right;
                        draw();
                        const el = root.querySelector<HTMLElement>(".ovmenu:not(.hidden)");
                        if (el) {
                          menuLeft = Math.max(8, r.right - el.offsetWidth);
                          draw();
                        }
                      }}
                    >
                      ⋯
                    </button>
                    <div
                      class=${"ovmenu" + (menu === s.id ? "" : " hidden")}
                      role="menu"
                      style=${`top:${menuTop}px;left:${menuLeft}px`}
                    >
                      ${[
                        ["browse", "Browse skills…"],
                        ["sync", "Sync now"],
                        ["track", tracked ? "Turn off auto-sync" : "Turn on auto-sync"],
                        ["remove", "Remove pack"],
                      ].map(
                        ([action, label]) =>
                          html`<button
                            type="button"
                            class=${ifDefined(action === "remove" ? "danger" : undefined)}
                            ?disabled=${pending.has(s.id)}
                            @click=${(e: MouseEvent) => {
                              e.stopPropagation();
                              void act(s, action);
                            }}
                          >
                            ${label}
                          </button>`,
                      )}
                    </div>
                  </div>`,
                  cls: "num",
                },
              ];
            }),
            "No packs yet. Register one above.",
          )}
        </div>`,
      )}${detail}`,
    );
  draw();
}
export async function browsePack(pack: Data, root: HTMLElement, c: Context) {
  root.replaceChildren();
  const paint = renderer(root);
  paint(html`<div class="loadingline">${"Fetching " + pack.url + "…"}</div>`);
  const response = await c.api("GET", "/api/skill-packs/" + encodeURIComponent(pack.id) + "/catalog");
  if (!response.ok || !response.data) {
    paint(html`<p class="empty">${response.data?.message || "Couldn't browse (" + response.status + ")."}</p>`);
    return;
  }
  const plan = response.data,
    candidates: Data[] = plan.candidates || [],
    counts = plan.counts || {};
  const selectedScopes = new Set<string>(["org:" + c.orgId]);
  const selected = new Set<string>();
  let filter = "all",
    busy = false,
    message = "",
    tone = "",
    closed = false;
  const all = (row: Data) =>
    selectedScopes.size > 0 && [...selectedScopes].every((scope) => (row.importedScopes || []).includes(scope));
  const eligible = (row: Data) => row.eligible && !all(row);
  let previousEligible = new Set<string>();
  const recompute = () => {
    const next = new Set(candidates.filter(eligible).map((r) => r.upstreamName));
    for (const r of candidates) {
      if (!next.has(r.upstreamName)) selected.delete(r.upstreamName);
      else if (!previousEligible.has(r.upstreamName)) selected.add(r.upstreamName);
    }
    previousEligible = next;
    draw();
  };
  const reasons: Record<string, Data> = {
    all: { label: "all", tone: "muted", help: "Show every skill." },
    eligible: {
      label: "eligible",
      tone: "ok",
      help: "Eligible and not yet in the selected scope(s). Importing adds it there.",
    },
    imported: {
      label: "imported",
      tone: "info",
      help: "Already imported into the selected scope(s). Sync refreshes them; un-index to remove.",
    },
    scope: {
      label: "personal-scoped",
      tone: "muted",
      help: "Held back: declares a personal/owner scope, so it isn't imported as a shared pack skill.",
    },
    private: { label: "private", tone: "muted", help: "Held back: marked owner-only / agent-only." },
    collision: {
      label: "collision",
      tone: "muted",
      help: "Held back: the name matches an existing platform or seed skill.",
    },
    "binary-asset": {
      label: "binary files",
      tone: "muted",
      help: "Held back: contains binary files (import is text-only).",
    },
    malformed: { label: "malformed", tone: "muted", help: "Held back: missing or unreadable SKILL.md frontmatter." },
  };
  const choices = [
    { scopeId: "org:" + c.orgId, label: "org-wide" },
    ...c.scopeRows().map((r: Data) => ({ scopeId: r.scopeId, label: r.label || c.dirLabel(r.scopeId) || r.scopeId })),
  ];
  const picker = c.buildScopeMultiSelect(choices, selectedScopes, recompute);
  const importSelected = async () => {
    if (busy) return;
    if (!selectedScopes.size || !selected.size) {
      message = !selectedScopes.size ? "Pick at least one scope to add skills to." : "Select at least one skill.";
      tone = "err";
      draw();
      return;
    }
    busy = true;
    message = "Importing…";
    tone = "";
    draw();
    const scopes = [...selectedScopes],
      names = [...selected];
    try {
      const result = await c.api("POST", "/api/skill-packs/" + encodeURIComponent(pack.id) + "/import", {
        selected: names.length === candidates.filter(eligible).length ? "all" : names,
        scopeIds: scopes,
      });
      if (!result.ok) {
        message = result.data?.message || "Import failed (" + result.status + ").";
        tone = "err";
      } else {
        const added = result.data.imported?.length ?? 0;
        message =
          "✓ " +
          added +
          " skill" +
          (added === 1 ? "" : "s") +
          " added" +
          (scopes.length > 1 ? " across " + scopes.length + " scopes" : "");
        tone = "ok";
        c.invalidate();
        setTimeout(() => {
          if (root.isConnected && !closed) c.reload();
        }, 1500);
      }
    } catch {
      message = "Import failed.";
      tone = "err";
    } finally {
      busy = false;
      draw();
    }
  };
  const action = (bottom = false) =>
    html`<div
      style=${"display:flex;flex-direction:column;align-items:flex-start;gap:6px;" + (bottom ? "margin-top:10px" : "")}
    >
      <button type="button" class="primary" ?disabled=${busy} @click=${importSelected}>Import selected</button
      ><span class=${"status" + (tone ? " " + tone : "")}>${message}</span>
    </div>`;
  const draw = () => {
    if (closed) return;
    const importable = candidates.filter(eligible),
      selectedCount = importable.filter((r) => selected.has(r.upstreamName)).length;
    const shown = candidates.filter(
      (r) =>
        filter === "all" ||
        (() => {
          if (all(r)) return "imported";
          return r.eligible ? "eligible" : r.excludeReason || "excluded";
        })() === filter,
    );
    paint(
      html`<section class="card" style="position:relative">
        <div class="head">
          <h2>${"Browse: " + pack.url}</h2>
          <p>
            Choose target scopes, then import. Eligible skills are added to every selected scope; excluded skills show
            why. They appear on the Skills page once imported.
          </p>
        </div>
        <div class="body">
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:2px 0 4px">
              <span style="font-size:12px;opacity:0.7">Add to scopes:</span>${picker}
            </div>
            ${
              plan.bundlePaths?.length
                ? html`<details style="margin:8px 0">
                    <summary>
                      ${plan.bundlePaths.length + " shared pack file" + (plan.bundlePaths.length === 1 ? "" : "s") + " (contained under a pack-owned directory)"}
                    </summary>
                    <pre
                      style="max-height:180px;overflow:auto;font-size:11px;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)"
                    >
${plan.bundlePaths.join("\n")}</pre>
                  </details>`
                : nothing
            }
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:10px 0 16px">
              <div class="badges" style="flex:1">
                ${Object.entries(reasons)
                  .filter(
                    ([key]) =>
                      key === "all" ||
                      key === "eligible" ||
                      (key === "imported" ? candidates.some((r) => r.importedScopes?.length) : counts[key]),
                  )
                  .map(
                    ([key, reason]) =>
                      html`<span
                        class=${"badge " + reason.tone}
                        style=${"cursor:pointer;" + (filter === key ? "background:var(--text);color:#fff;border-color:var(--text)" : "")}
                        title=${reason.help + " " + (key === "all" ? "" : "Click to show only these.")}
                        @click=${() => {
                          filter = key;
                          draw();
                        }}
                        >${
                          (() => {
                            if (key === "all") return candidates.length;
                            return (() => {
                              if (key === "eligible") return importable.length;
                              return key === "imported" ? candidates.filter(all).length : counts[key] || 0;
                            })();
                          })() +
                          " " +
                          reason.label
                        }</span
                      >`,
                  )}
              </div>
              ${action()}
            </div>
            <div>
              ${table(
                [
                  html`<input
                    type="checkbox"
                    title="Select / deselect all importable skills"
                    .checked=${importable.length > 0 && selectedCount === importable.length}
                    .indeterminate=${selectedCount > 0 && selectedCount < importable.length}
                    @change=${(e: Event) => {
                      const on = (e.target as HTMLInputElement).checked;
                      for (const row of importable) {
                        if (on) selected.add(row.upstreamName);
                        else selected.delete(row.upstreamName);
                      }
                      draw();
                    }}
                  />`,
                  "Skill",
                  "",
                ],
                shown.map((row) => [
                  {
                    node: html`<input
                      type="checkbox"
                      data-name=${row.upstreamName}
                      .checked=${selected.has(row.upstreamName)}
                      ?disabled=${!eligible(row)}
                      @change=${(e: Event) => {
                        if ((e.target as HTMLInputElement).checked) selected.add(row.upstreamName);
                        else selected.delete(row.upstreamName);
                        draw();
                      }}
                    />`,
                  },
                  { node: stacked(row.upstreamName, row.normalized?.manifest?.description || "") },
                  {
                    node: (() => {
                      if (all(row))
                        return badge(
                          "imported",
                          "info",
                          "Already imported into the selected scope(s): " + (row.importedScopes || []).join(", "),
                        );
                      return row.eligible
                        ? badge(
                            "eligible",
                            "ok",
                            [...selectedScopes].some((s) => (row.importedScopes || []).includes(s))
                              ? "Imported into " +
                                  (row.importedScopes || []).join(", ") +
                                  ". Importing adds it to the other selected scope(s)."
                              : "",
                          )
                        : badge(
                            reasons[row.excludeReason]?.label || row.excludeReason || "excluded",
                            "warn",
                            reasons[row.excludeReason]?.help || "",
                          );
                    })(),
                  },
                ]),
                filter === "all"
                  ? "No skills found in this pack."
                  : "No " + (reasons[filter]?.label || filter) + " skills.",
              )}
            </div>
            ${action(true)}
          </div>
        </div>
        <button
          type="button"
          title="Close"
          aria-label="Close browse"
          style="position:absolute;top:10px;right:12px;border:none;background:transparent;cursor:pointer;font-size:18px;line-height:1;color:var(--text);opacity:0.55;padding:4px"
          @mouseenter=${(e: Event) => {
            (e.target as HTMLElement).style.opacity = "1";
          }}
          @mouseleave=${(e: Event) => {
            (e.target as HTMLElement).style.opacity = "0.55";
          }}
          @click=${() => {
            closed = true;
            paint(nothing);
          }}
        >
          ✕
        </button>
      </section>`,
    );
  };
  recompute();
  root.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
