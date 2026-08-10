import type { ModelProviderAvailability } from "../model/pi-models.ts";
import type { HarnessAuthStore } from "../credentials/harness-auth-store.ts";
import type { BrowserProviderSpec } from "../connectors/browser-providers.ts";
import type { RelayHub } from "../browser-relay/relay.ts";
import type { ModelCredentialStore } from "../model/model-credential-store.ts";
import type { CustomProviderStore } from "../model/custom-provider-store.ts";
import type { ReplayDedupe } from "../auth/replay-dedupe.ts";
import type { FetchLike, OAuthClientResolver } from "../connectors/oauth.ts";
import type { ConsentLinkStore } from "../connectors/consent-link.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";
import type { AclStore } from "../acl/acl-store.ts";
import type { CredentialUsageSink } from "../admin/credential-usage-sink.ts";
import type { EgressAuditSink } from "../admin/egress-audit-sink.ts";
import type { BrokerFetch } from "./credential-broker.ts";
import type { GitHttpFetch } from "./git-http-broker.ts";
import type { AdminService } from "../admin/admin-service.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { ErrorLog } from "../admin/error-log.ts";
import type { MetricsSink } from "../admin/metrics-sink.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { ScopeId } from "../types.ts";
import type { MountStore } from "../mounts/mount-store.ts";
import type { ListingCache } from "../mounts/listing-cache.ts";
import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import type { MemoryService } from "../memory/memory-service.ts";
import type { SandboxMigrationRunner } from "../sandbox/sandbox-migration-runner.ts";
import type { EgressEnforcement, Sandbox } from "../sandbox/sandbox.ts";
import type { EnvironmentStore } from "../environments/environment-store.ts";
import type { Scheduler } from "../cron/scheduler.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { DeviceFlowCutoverStore } from "../credentials/device-flow-cutover.ts";
import type {
  ConnectorTokenStore,
  Keychain,
  KeychainAsk,
  KeychainGrant,
  ServiceCredentialStore,
} from "../credentials/keychain.ts";
import type { SecretDropStore } from "../credentials/secret-drop.ts";
import type { DropResolution } from "../triggers/keychain-ask.ts";
import type { BlobTransferStore } from "../persistence/blob-transfer.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { ControlService } from "./control-service.ts";
import type { CronStore } from "../cron/cron-store.ts";
import type { ProcessRegistry } from "../processes/process-registry.ts";
import type { BrowserSessionStore } from "../connectors/browser-session-store.ts";
import type { LiveBrowserSessionStore } from "../connectors/browser-live-session-store.ts";
import type { DirectoryStore } from "../directory/directory-store.ts";
import type { DeploymentLayerStore } from "../deployment/deployment-layer-store.ts";
import type { AmbientJudgmentStore } from "../surface-cache/ambient-judgment-store.ts";
import type { AckEmojiPickStore } from "../surface-cache/ack-emoji-pick-store.ts";
import type { ChannelPolicyStore } from "../surface-cache/channel-policy-store.ts";
import type { RateLimiter } from "../ratelimit/rate-limiter.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { SlackInstallationStore, SlackSocketAppIdReader } from "../surfaces/slack-installation.ts";

export interface ServerDeps {
  production?: boolean;
  allowUnauthenticatedCore?: boolean;
  signingSecret?: string;
  capabilitySecret?: string;
  portalIdentitySecret?: string;
  requireSignedPortalIdentity?: boolean;
  control: ControlService;
  replayDedupe?: ReplayDedupe;
  connectorTokens?: ConnectorTokenStore;
  slackInstallation?: SlackInstallationStore;
  slackInstallationFetch?: typeof fetch;
  slackInstallationSocketAppId?: SlackSocketAppIdReader;
  slackEnvironmentState?: "absent" | "configured" | "partial";
  oauthStateSecret?: string;
  oauthFetch?: FetchLike;
  oauthEnv?: NodeJS.ProcessEnv;
  resolveClient?: OAuthClientResolver;
  consentLinks?: ConsentLinkStore;
  publicUrl?: string;
  portalUrl?: string;
  config?: ScopedConfigStore;
  acl?: AclStore;
  credentialUsage?: CredentialUsageSink;
  deviceFlowCutover?: DeviceFlowCutoverStore;
  egressAudit?: EgressAuditSink;
  brokerFetch?: BrokerFetch;
  gitHttpFetch?: GitHttpFetch;
  baseModelDefault?: string;
  modelProviders?: ModelProviderAvailability;
  providerKeys?: ModelProviderAvailability;
  modelCredentials?: ModelCredentialStore;
  harnessAuth?: HarnessAuthStore;
  /** Hosted browsers a person may connect, read from the browse skill docs. */
  browserProviders?: readonly BrowserProviderSpec[];
  /** Pairs a person's own Chrome with the browser their agent drives. */
  browserRelay?: RelayHub;
  /** Public wss origin the extension dials, e.g. https://relay.qm.example.com. */
  relayPublicUrl?: string;
  /** Injected in tests so saving a token needs no live model call. */
  harnessAuthProbe?: (token: string) => Promise<{ ok: boolean; detail?: string }>;
  modelCredentialFetch?: typeof fetch;
  customProviders?: CustomProviderStore;
  refreshCustomProviders?: () => Promise<void>;
  brandingDefault?: { accent?: string; mark?: string; selfLabel?: string; productName?: string; logoSvg?: string };
  harnessId?: string;
  admin?: AdminService;
  rateLimiter?: RateLimiter;
  sessions?: SessionStore;
  /**
   * Drive folder mounts. Absent when the deployment has no Google connector
   * configured, in which case the mount routes answer 503 rather than 404 —
   * the endpoints exist, the capability does not.
   */
  driveMounts?: {
    store: MountStore;
    cache: ListingCache;
    /** Same check that governs uploading a file to the scope. */
    canUseContext: (principalId: string, scopeId: ScopeId) => Promise<boolean>;
    /** The caller's own Drive token, or null when Google is not connected. */
    tokenFor: (principalId: string) => Promise<string | null>;
    /** Lists folders under a parent, server-side, with the caller's token. */
    browseFolders: (
      accessToken: string,
      parentId: string,
      search?: string,
    ) => Promise<Array<{ id: string; name: string }>>;
    /** Resolve one folder by id, for a pasted Drive link. */
    lookupFolder: (accessToken: string, folderId: string) => Promise<{ id: string; name: string } | null>;
  };
  auditLog?: AuditLog;
  errors?: ErrorLog;
  metrics?: MetricsSink;
  crons?: CronStore;
  runs?: RunStore;
  workspace?: WorkspaceStore;
  files?: FileArtifactStore;
  memory?: MemoryService;
  sandboxBackend?: string;
  egressDeclaredEnforcement?: EgressEnforcement;
  egressEnforcement?: EgressEnforcement;
  sandboxMigration?: SandboxMigrationRunner;
  sandbox?: Sandbox;
  advisoryLock?: AdvisoryLock;
  processes?: ProcessRegistry;
  browserSessionStore?: BrowserSessionStore;
  /** The browser a person has open right now, and who is driving it. */
  liveBrowserSessions?: LiveBrowserSessionStore;
  /**
   * How many browsers may be open at once across everyone. Each costs about
   * 1.25 GB, so this is a memory bound rather than a policy — raise it when the
   * host grows. Defaults to one.
   */
  maxLiveBrowsers?: number;
  directory?: DirectoryStore;
  ambientJudgments?: AmbientJudgmentStore;
  ackEmojiPicks?: AckEmojiPickStore;
  channelPolicy?: ChannelPolicyStore;
  environments?: EnvironmentStore;
  deploymentLayer?: DeploymentLayerStore;
  brokeredServices?: () => readonly string[];
  deployDialTimeoutMs?: number;
  deployAppsDomain?: string;
  deployGateSecret?: string;
  deployAppsSessionSecret?: string;
  deployAppsLoginUrl?: string;
  scheduler?: Scheduler;
  identity?: IdentityService;
  keychain?: Keychain;
  serviceCreds?: ServiceCredentialStore;
  deliveries?: DeliveryStore;
  fireAskResolution?: (ask: KeychainAsk, grant?: KeychainGrant) => Promise<unknown>;
  secretDrops?: SecretDropStore;
  fireDropResolution?: (drop: DropResolution) => Promise<unknown>;
  blobTransfer?: BlobTransferStore;
}
