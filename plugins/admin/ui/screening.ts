import { html, nothing } from "lit";
import { badge, card, renderer, table } from "./shared.ts";

interface ScreeningSource {
  kind: string;
  skillId?: string;
  name?: string;
  version?: number;
  contentHash?: string;
  builtIn?: boolean;
}

interface ScreeningReportView {
  id: string;
  source: ScreeningSource;
  step: string;
  category: string;
  categoryLabel?: string;
  reason?: string;
  evidence?: string;
  content: string;
  reporterId: string;
  note?: string;
  createdAt: number;
  status: "open" | "screen_correct" | "fixed";
}

interface ScreeningGroup {
  sourceKey: string;
  source: ScreeningSource;
  sourceLabel: string;
  open: number;
  reports: ScreeningReportView[];
  trusted: SkillTrustView | null;
}

interface SkillTrustView {
  id: string;
  skillId: string;
  name: string;
  version: number;
  grantedBy: string;
  grantedAt: number;
}

interface ScreeningDeps {
  api: (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; status?: number; data?: any }>;
  fmtTime: (ts: number) => string;
  defaultShell: (extras?: Record<string, unknown>) => void;
  openAutoFlagger: (content: string) => void;
  reload: () => void;
}

const STATUS_LABELS: Record<ScreeningReportView["status"], [string, string]> = {
  open: ["Needs review", "warn"],
  screen_correct: ["Screen correct", "ok"],
  fixed: ["Fixed", "ok"],
};

const notices = new Map<string, [string, string]>();

function groupStatus(group: ScreeningGroup): ScreeningReportView["status"] {
  if (group.open > 0) return "open";
  return group.reports.every((r) => r.status === "fixed") ? "fixed" : "screen_correct";
}

export function screening(
  root: HTMLElement,
  d: { groups?: ScreeningGroup[]; trusts?: SkillTrustView[] },
  s: ScreeningDeps,
) {
  const paint = renderer(root);
  const groups = d.groups || [];
  const trusts = d.trusts || [];
  let expanded = groups.length === 1 ? groups[0]!.sourceKey : "";

  async function act(key: string, run: () => Promise<{ ok: boolean; status?: number; data?: any }>, done: string) {
    notices.set(key, ["Working…", ""]);
    draw();
    const r = await run();
    if (r.ok) {
      notices.set(key, [done, "ok"]);
      draw();
      s.reload();
      return;
    }
    notices.set(key, [r.data?.message || "That didn't work. Try again.", "err"]);
    draw();
  }

  const markCorrect = (report: ScreeningReportView) =>
    act(
      report.id,
      () =>
        s.api("POST", "/api/screening-reports/" + encodeURIComponent(report.id) + "/status", {
          status: "screen_correct",
        }),
      "Marked screen correct.",
    );

  const trustVersion = (report: ScreeningReportView) =>
    act(
      report.id,
      () =>
        s.api("POST", "/api/skill-trusts", {
          skillId: report.source.skillId,
          version: report.source.version,
          contentHash: report.source.contentHash,
          reportId: report.id,
        }),
      `Trusted ${report.source.name} v${report.source.version}. Its content now skips the screen until it changes.`,
    );

  const revoke = (trust: SkillTrustView) =>
    act(
      "trust:" + trust.id,
      () => s.api("DELETE", "/api/skill-trusts/" + encodeURIComponent(trust.id)),
      "Trust revoked.",
    );

  function notice(key: string) {
    const n = notices.get(key);
    return n ? html`<span class=${"status " + n[1]}>${n[0]}</span>` : nothing;
  }

  function reportDetail(group: ScreeningGroup, report: ScreeningReportView) {
    const skill = report.source.kind === "skill" && report.source.skillId && report.source.version !== undefined;
    return html`<div class="screening-report" data-report=${report.id}>
      <div class="screening-verdict">
        <div>
          <span class="k">Screener said</span>${report.categoryLabel || report.category}${
            report.reason ? html`: ${report.reason}` : nothing
          }
        </div>
        <div>
          <span class="k">Reporter's note</span>${report.note ? html`"${report.note}"` : html`<em>No note</em>`}
          <span class="subline">${report.reporterId} · ${s.fmtTime(report.createdAt)}</span>
        </div>
        <div><span class="k">Step</span>${report.step}</div>
      </div>
      ${
        report.evidence
          ? html`<blockquote class="screening-evidence">
              <span class="k">Text that triggered it</span>${report.evidence}
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
        ${
          report.status === "open"
            ? html`<button type="button" data-act="correct" @click=${() => markCorrect(report)}>
                Mark screen correct
              </button>`
            : nothing
        }
        ${
          skill && !group.trusted
            ? html`<button type="button" data-act="trust" @click=${() => trustVersion(report)}>
                Trust this skill version
              </button>`
            : nothing
        }
        ${notice(report.id)}
      </div>
    </div>`;
  }

  function draw() {
    const rows = groups.map((group) => {
      const latest = group.reports[0]!;
      const status = groupStatus(group);
      return [
        {
          node: html`<div>
            <div class="primaryline">${group.sourceLabel}</div>
            ${group.trusted ? html`<div class="subline">Trusted v${group.trusted.version}</div>` : nothing}
          </div>`,
        },
        {
          node: html`<div>
            <div class="primaryline">${latest.categoryLabel || latest.category}</div>
            ${latest.evidence ? html`<div class="subline">"${latest.evidence}"</div>` : nothing}
          </div>`,
        },
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
            ["Source", "What tripped it", "Reports", "Open", "Status"],
            rows,
            "No screening reports yet.",
            (i) => {
              expanded = expanded === groups[i]!.sourceKey ? "" : groups[i]!.sourceKey;
              draw();
            },
          )}${
            open
              ? html`<div class="screening-detail" data-group=${open.sourceKey}>
                  <h3>${open.sourceLabel}</h3>
                  ${open.reports.map((report) => reportDetail(open, report))}
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
