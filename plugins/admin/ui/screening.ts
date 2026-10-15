import { html, nothing } from "lit";
import { badge, card, renderer, table } from "./shared.ts";

interface ScreeningSource {
  kind: string;
  skillId?: string;
  name?: string;
  version?: number;
  contentHash?: string;
  builtIn?: boolean;
  packId?: string;
}

type ReportStatus = "open" | "screen_correct" | "fixed";

interface ScreeningReportView {
  id: string;
  source: ScreeningSource;
  step?: string;
  category: string;
  categoryLabel?: string;
  reason?: string;
  evidence?: string;
  content: string;
  reporterId: string;
  note?: string;
  createdAt: number;
  status: ReportStatus;
  trusted?: boolean;
}

interface ScreeningGroup {
  sourceKey: string;
  source: ScreeningSource;
  sourceLabel: string;
  holds?: number;
  open: number;
  reports: ScreeningReportView[];
}

interface SkillTrustView {
  id: string;
  skillId: string;
  name: string;
  version: number;
  contentHash?: string;
  grantedBy: string;
  grantedAt: number;
}

interface TrustPreview {
  skillId: string;
  name: string;
  version: number;
  contentHash: string;
  files: Array<{ path: string; content: string }>;
}

type ApiResult = { ok: boolean; status?: number; data?: any };

interface ScreeningDeps {
  api: (method: string, path: string, body?: unknown) => Promise<ApiResult>;
  fmtTime: (ts: number) => string;
  defaultShell: (extras?: Record<string, unknown>) => void;
  openAutoFlagger: (content: string) => void;
  reload: () => void;
  confirm?: (message: string) => boolean;
}

const STATUS_LABELS: Record<ReportStatus, [string, string]> = {
  open: ["Needs review", "warn"],
  screen_correct: ["Screen correct", "ok"],
  fixed: ["Fixed", "ok"],
};

const notices = new Map<string, [string, string]>();

function groupStatus(group: ScreeningGroup): ReportStatus {
  if (group.open > 0) return "open";
  return group.reports.every((r) => r.status === "fixed") ? "fixed" : "screen_correct";
}

function mergeGroups(into: ScreeningGroup[], more: ScreeningGroup[]): void {
  for (const group of more) {
    const existing = into.find((g) => g.sourceKey === group.sourceKey);
    if (!existing) {
      into.push({ ...group, reports: [...group.reports] });
      continue;
    }
    const known = new Set(existing.reports.map((r) => r.id));
    existing.reports.push(...group.reports.filter((r) => !known.has(r.id)));
    existing.open = existing.reports.filter((r) => r.status === "open").length;
    existing.holds = Math.max(existing.holds ?? 0, group.holds ?? 0);
  }
}

export function screening(
  root: HTMLElement,
  d: { groups?: ScreeningGroup[]; trusts?: SkillTrustView[]; nextBefore?: number },
  s: ScreeningDeps,
) {
  const paint = renderer(root);
  const groups: ScreeningGroup[] = [];
  mergeGroups(groups, d.groups || []);
  const trusts = d.trusts || [];
  let nextBefore = d.nextBefore;
  let loadingMore = false;
  let expanded = groups.length === 1 ? groups[0]!.sourceKey : "";
  let preview: { report: ScreeningReportView; data: TrustPreview } | null = null;
  const ask = s.confirm ?? ((message: string) => window.confirm(message));

  async function act(key: string, run: () => Promise<ApiResult>, done: string): Promise<boolean> {
    notices.clear();
    notices.set(key, ["Working…", ""]);
    draw();
    const r = await run();
    if (r.ok) {
      notices.set(key, [done, "ok"]);
      draw();
      s.reload();
      return true;
    }
    notices.set(key, [r.data?.message || "That didn't work. Try again.", "err"]);
    draw();
    return false;
  }

  const setStatus = (report: ScreeningReportView, status: ReportStatus, done: string) =>
    act(
      report.id,
      () => s.api("POST", "/api/screening-reports/" + encodeURIComponent(report.id) + "/status", { status }),
      done,
    );

  async function openTrust(report: ScreeningReportView) {
    notices.clear();
    notices.set(report.id, ["Loading every file of this version…", ""]);
    draw();
    const query = new URLSearchParams({
      skillId: report.source.skillId ?? "",
      version: String(report.source.version ?? ""),
    });
    const r = await s.api("GET", "/api/skill-trusts/preview?" + query.toString());
    notices.delete(report.id);
    if (!r.ok) {
      notices.set(report.id, [r.data?.message || "Could not load this skill version.", "err"]);
      draw();
      return;
    }
    preview = { report, data: r.data as TrustPreview };
    draw();
  }

  async function confirmTrust() {
    if (!preview) return;
    const { report, data } = preview;
    preview = null;
    await act(
      report.id,
      () =>
        s.api("POST", "/api/skill-trusts", {
          skillId: data.skillId,
          version: data.version,
          contentHash: data.contentHash,
          reportId: report.id,
        }),
      `Trusted ${data.name} v${data.version}. Its content now skips the screen until it changes.`,
    );
  }

  const revoke = (trust: SkillTrustView) => {
    if (!ask(`Revoke trust for ${trust.name} v${trust.version}? Its content will be screened again.`)) return;
    void act(
      "trust:" + trust.id,
      () => s.api("DELETE", "/api/skill-trusts/" + encodeURIComponent(trust.id)),
      "Trust revoked.",
    );
  };

  async function loadMore() {
    if (nextBefore === undefined || loadingMore) return;
    loadingMore = true;
    draw();
    const r = await s.api("GET", "/api/screening-reports?status=all&before=" + encodeURIComponent(String(nextBefore)));
    loadingMore = false;
    if (r.ok) {
      mergeGroups(groups, (r.data?.groups as ScreeningGroup[]) || []);
      nextBefore = typeof r.data?.nextBefore === "number" ? r.data.nextBefore : undefined;
    } else notices.set("more", [r.data?.message || "Could not load more reports.", "err"]);
    draw();
  }

  function notice(key: string) {
    const n = notices.get(key);
    return n ? html`<span class=${"status " + n[1]}>${n[0]}</span>` : nothing;
  }

  function statusActions(report: ScreeningReportView) {
    if (report.status === "open")
      return html`<button
          type="button"
          data-act="correct"
          @click=${() => setStatus(report, "screen_correct", "Marked screen correct.")}
        >
          Mark screen correct</button
        ><button type="button" data-act="fixed" @click=${() => setStatus(report, "fixed", "Marked fixed.")}>
          Mark fixed
        </button>`;
    return html`<button type="button" data-act="reopen" @click=${() => setStatus(report, "open", "Reopened.")}>
      Reopen
    </button>`;
  }

  function reportDetail(report: ScreeningReportView) {
    const skill = report.source.kind === "skill" && report.source.skillId && report.source.version !== undefined;
    return html`<div class="screening-report" data-report=${report.id}>
      <div class="screening-verdict">
        <div><span class="k">Category</span>${report.categoryLabel || report.category}</div>
        ${
          report.reason
            ? html`<div><span class="k">Screening model's explanation (unverified)</span>${report.reason}</div>`
            : nothing
        }
        <div>
          <span class="k">Reporter's note</span>${report.note ? html`"${report.note}"` : html`<em>No note</em>`}
          <span class="subline">${report.reporterId} · ${s.fmtTime(report.createdAt)}</span>
        </div>
        ${report.step ? html`<div><span class="k">Step</span>${report.step}</div>` : nothing}
      </div>
      ${
        report.evidence
          ? html`<blockquote class="screening-evidence">
              <span class="k">Text the screener flagged</span>${report.evidence}
            </blockquote>`
          : nothing
      }
      <details class="screening-content">
        <summary>Show what was blocked</summary>
        <pre>${report.content}</pre>
      </details>
      <div class="screening-actions">
        ${badge(STATUS_LABELS[report.status][0], STATUS_LABELS[report.status][1])}
        <button type="button" class="primary" data-act="flagger" @click=${() => s.openAutoFlagger(report.content)}>
          Open in Auto flagger test
        </button>
        ${statusActions(report)}
        ${
          skill && !report.trusted
            ? html`<button type="button" data-act="trust" @click=${() => openTrust(report)}>
                Trust this skill version
              </button>`
            : nothing
        }
        ${skill && report.trusted ? html`<span class="subline">This version is trusted</span>` : nothing}
        ${notice(report.id)}
      </div>
    </div>`;
  }

  function trustDialog() {
    if (!preview) return nothing;
    const { data } = preview;
    return html`<dialog class="review-dialog screening-trust-dialog" open aria-labelledby="screening-trust-title">
      <div class="review-dialog-head">
        <h2 id="screening-trust-title">Trust ${data.name} v${data.version}?</h2>
        <p>
          Every file below skips the security screen while the skill stays at this exact version and content. Read all
          of it before trusting. Hash <span class="mono">${data.contentHash}</span>.
        </p>
      </div>
      <div class="review-dialog-body screening-trust-files">
        ${data.files.map(
          (file) =>
            html`<section class="screening-trust-file" data-file=${file.path}>
              <h3 class="mono">${file.path}</h3>
              <pre>${file.content}</pre>
            </section>`,
        )}
      </div>
      <div class="review-dialog-foot">
        <button
          type="button"
          data-act="trust-cancel"
          @click=${() => {
            preview = null;
            draw();
          }}
        >
          Cancel</button
        ><button type="button" class="primary" data-act="trust-confirm" @click=${() => confirmTrust()}>
          Trust this exact version
        </button>
      </div>
    </dialog>`;
  }

  function draw() {
    const rows = groups.map((group) => {
      const latest = group.reports[0]!;
      const status = groupStatus(group);
      return [
        { node: html`<div class="primaryline">${group.sourceLabel}</div>` },
        {
          node: html`<div>
            <div class="primaryline">${latest.categoryLabel || latest.category}</div>
            ${latest.evidence ? html`<div class="subline">"${latest.evidence}"</div>` : nothing}
          </div>`,
        },
        { text: group.holds === undefined ? "—" : String(group.holds), cls: "num" },
        { text: String(group.reports.length), cls: "num" },
        { text: String(group.open), cls: "num" },
        { badges: [[STATUS_LABELS[status][0], STATUS_LABELS[status][1]]] },
      ];
    });
    const open = groups.find((g) => g.sourceKey === expanded);
    paint(
      html`<div class="list-root screening-root">
        ${card(
          "Screening reports",
          "Holds people marked as wrong, grouped by source. Admins are not notified automatically — new reports appear here.",
          html`${table(
            ["Source", "What tripped it", "Holds", "Reports", "Open", "Status"],
            rows,
            "No screening reports yet.",
            (i) => {
              expanded = expanded === groups[i]!.sourceKey ? "" : groups[i]!.sourceKey;
              draw();
            },
          )}${
            nextBefore !== undefined
              ? html`<div class="screening-actions">
                  <button type="button" data-act="more" ?disabled=${loadingMore} @click=${() => loadMore()}>
                    ${loadingMore ? "Loading…" : "Load more"}</button
                  >${notice("more")}
                </div>`
              : nothing
          }${
            open
              ? html`<div class="screening-detail" data-group=${open.sourceKey}>
                  <h3>${open.sourceLabel}</h3>
                  ${open.reports.map((report) => reportDetail(report))}
                </div>`
              : nothing
          }`,
        )}
        ${card(
          "Trusted skill versions",
          "Content from these exact skill versions skips the security screen. A new version or changed content is screened again.",
          table(
            ["Skill", "Version", "Granted", ""],
            trusts.map((trust) => [
              {
                node: html`<div class="primaryline">${trust.name}</div>
                  <div class="subline mono">${trust.skillId}</div>`,
              },
              { text: "v" + trust.version, cls: "num" },
              {
                node: html`<div>${s.fmtTime(trust.grantedAt)}</div>
                  <div class="subline">${trust.grantedBy}</div>`,
              },
              {
                node: html`<button type="button" class="rowbtn danger" data-act="revoke" @click=${() => revoke(trust)}>
                    Revoke</button
                  >${notice("trust:" + trust.id)}`,
              },
            ]),
            "No skill versions are trusted.",
          ),
        )}
        ${trustDialog()}
      </div>`,
    );
  }

  s.defaultShell({
    stats: [
      [groups.reduce((n, g) => n + g.open, 0), "Open reports"],
      [groups.length, "Sources"],
      [trusts.length, "Trusted skill versions"],
    ],
  });
  draw();
}
