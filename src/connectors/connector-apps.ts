import { requireAtomic, type DurableMap } from "../persistence/durable-map.ts";
import { providerForHost } from "./oauth.ts";

export interface ConnectorApp {
  id: string;
  label: string;
  tools: readonly string[];
  skills: readonly string[];
}

const MICROSOFT_DRIVE_TOOLS = [
  "list-folder-files",
  "get-drive-item",
  "get-drive-root-item",
  "search-onedrive-files",
  "download-bytes",
  "get-download-url",
  "upload-file-content",
] as const;

const MICROSOFT_365_APPS: readonly ConnectorApp[] = [
  {
    id: "mail",
    label: "Mail",
    tools: [
      "get-current-user",
      "list-mail-messages",
      "get-mail-message",
      "read-mail-text",
      "list-mail-folders",
      "list-mail-folder-messages",
      "list-mail-attachments",
      "get-mail-attachment-content",
      "create-draft-email",
      "create-reply-draft",
      "update-mail-message",
      "send-draft-message",
      "send-mail",
      "move-mail-message",
    ],
    skills: ["microsoft-365", "microsoft-365-mail"],
  },
  {
    id: "calendar",
    label: "Calendar",
    tools: [
      "get-current-user",
      "list-calendars",
      "get-calendar-view",
      "get-calendar-event",
      "create-calendar-event",
      "update-calendar-event",
      "delete-calendar-event",
      "accept-calendar-event",
      "decline-calendar-event",
      "tentatively-accept-calendar-event",
      "find-meeting-times",
      "get-schedule",
    ],
    skills: ["microsoft-365", "microsoft-365-calendar"],
  },
  {
    id: "teams-chats",
    label: "Teams chats",
    tools: [
      "get-current-user",
      "list-chats",
      "list-chat-members",
      "list-chat-messages",
      "get-chat-message",
      "list-chat-message-replies",
      "send-chat-message",
      "reply-to-chat-message",
    ],
    skills: ["microsoft-365", "microsoft-365-teams"],
  },
  {
    id: "teams-channels",
    label: "Teams channels",
    tools: [
      "get-current-user",
      "list-joined-teams",
      "list-team-channels",
      "list-channel-messages",
      "get-channel-message",
      "list-channel-message-replies",
      "send-channel-message",
      "reply-to-channel-message",
    ],
    skills: ["microsoft-365", "microsoft-365-teams"],
  },
  {
    id: "meeting-transcripts",
    label: "Meeting transcripts",
    tools: [
      "get-current-user",
      "parse-teams-url",
      "list-online-meetings",
      "get-online-meeting",
      "list-meeting-transcripts",
      "get-meeting-transcript-content",
    ],
    skills: ["microsoft-365", "microsoft-365-meeting-transcripts"],
  },
  {
    id: "onedrive",
    label: "OneDrive",
    tools: [
      "get-current-user",
      "list-drives",
      ...MICROSOFT_DRIVE_TOOLS,
      "create-onedrive-folder",
      "move-rename-onedrive-item",
    ],
    skills: ["microsoft-365", "microsoft-365-files"],
  },
  {
    id: "sharepoint",
    label: "SharePoint",
    tools: [
      "get-current-user",
      "search-sharepoint-sites",
      "get-sharepoint-site-by-path",
      "list-sharepoint-site-drives",
      "list-sharepoint-site-lists",
      "list-sharepoint-site-list-items",
      "get-sharepoint-site-list-item",
      "create-sharepoint-list-item",
      "update-sharepoint-list-item",
      ...MICROSOFT_DRIVE_TOOLS,
    ],
    skills: ["microsoft-365", "microsoft-365-files"],
  },
];

export const CONNECTOR_APPS: Readonly<Record<string, readonly ConnectorApp[]>> = {
  microsoft: MICROSOFT_365_APPS,
};

export type DisabledConnectorApps = Readonly<Record<string, readonly string[]>>;

export interface ConnectorAppState {
  id: string;
  label: string;
  enabled: boolean;
}

export function connectorAppStates(provider: string, disabled: DisabledConnectorApps): ConnectorAppState[] {
  const off = new Set(disabled[provider] ?? []);
  return (CONNECTOR_APPS[provider] ?? []).map((app) => ({ id: app.id, label: app.label, enabled: !off.has(app.id) }));
}

function visibleThroughApps(
  apps: readonly ConnectorApp[],
  disabled: readonly string[] | undefined,
  member: (app: ConnectorApp) => boolean,
): boolean {
  const off = new Set(disabled ?? []);
  return apps.some((app) => member(app) && !off.has(app.id));
}

export function connectorAppToolVisible(
  tool: { remoteName: string; credentialHost?: string },
  disabled: DisabledConnectorApps,
): boolean {
  const provider = tool.credentialHost ? providerForHost(tool.credentialHost)?.name : undefined;
  const apps = provider ? CONNECTOR_APPS[provider] : undefined;
  if (!provider || !apps) return true;
  return visibleThroughApps(apps, disabled[provider], (app) => app.tools.includes(tool.remoteName));
}

export function connectorAppSkillProviders(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CONNECTOR_APPS).flatMap(([provider, apps]) =>
      apps.flatMap((app) => app.skills.map((skill) => [skill, provider] as const)),
    ),
  );
}

export function connectorAppSkillVisible(skill: string, disabled: DisabledConnectorApps): boolean {
  return Object.entries(CONNECTOR_APPS).every(
    ([provider, apps]) =>
      !apps.some((app) => app.skills.includes(skill)) ||
      visibleThroughApps(apps, disabled[provider], (app) => app.skills.includes(skill)),
  );
}

export interface ConnectorAppPrefsRecord {
  principalId: string;
  disabled: Record<string, string[]>;
  updatedAt: number;
}

export interface ConnectorAppPrefs {
  disabled(principalId: string): Promise<DisabledConnectorApps>;
  set(principalId: string, provider: string, enabled: Readonly<Record<string, boolean>>): Promise<ConnectorAppState[]>;
}

export function createConnectorAppPrefs(
  map: DurableMap<ConnectorAppPrefsRecord>,
  now: () => number = Date.now,
): ConnectorAppPrefs {
  const store = requireAtomic(map);
  return {
    disabled: async (principalId) => (await store.get(principalId))?.disabled ?? {},
    async set(principalId, provider, enabled) {
      const apps = CONNECTOR_APPS[provider];
      if (!apps) throw new Error(`${provider} has no app settings`);
      const unknown = Object.keys(enabled).filter((id) => !apps.some((app) => app.id === id));
      if (unknown.length) throw new Error(`unknown ${provider} apps: ${unknown.join(", ")}`);
      const apply = (current: Record<string, string[]>): Record<string, string[]> => {
        const off = new Set(current[provider] ?? []);
        for (const [id, on] of Object.entries(enabled)) {
          if (on) off.delete(id);
          else off.add(id);
        }
        return { ...current, [provider]: apps.map((app) => app.id).filter((id) => off.has(id)) };
      };
      await store.putIfAbsent(principalId, { principalId, disabled: {}, updatedAt: now() });
      const next = await store.update(principalId, (rec) => ({
        ...rec,
        disabled: apply(rec.disabled),
        updatedAt: now(),
      }));
      return connectorAppStates(provider, next?.disabled ?? {});
    },
  };
}
