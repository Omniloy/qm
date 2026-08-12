import type { Deployment, DeployEndpoint, DeploymentVersion } from "./deploy-store.ts";

export type { DeployEndpoint };

export interface DeployProfile {
  managedScaleToZero: boolean;
  inPlaceReconcile?: boolean;
  dataDir?: string;
}

export interface DeployApplyOptions {
  /**
   * Skip the provider's readiness gate and return as soon as the app is
   * launched. Set when relaunching a version that already ran — repairing a
   * vanished container is not a deploy, and making a waiting viewer pay for
   * a readiness verdict would trade a brief 502 for a hard failure.
   */
  waitForReady?: boolean;
  readyWindowMs?: number;
}

export interface DeployReconcileInput extends DeployApplyOptions {
  gitBundle?: Uint8Array;
  changedPaths: string[];
  deletedPaths: string[];
  allPaths: string[];
}

export interface DeployProvider {
  readonly profile: DeployProfile;
  apply(d: Deployment, version: DeploymentVersion, opts?: DeployApplyOptions): Promise<DeployEndpoint>;
  reconcile?(d: Deployment, version: DeploymentVersion, input: DeployReconcileInput): Promise<DeployEndpoint>;
  destroy(d: Deployment): Promise<void>;
  resolveEndpoint?(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint | null>;
}
