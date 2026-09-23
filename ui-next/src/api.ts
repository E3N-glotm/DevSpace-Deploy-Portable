export type PermissionProfile = 'workspace' | 'full-access' | 'custom';
export type Provider = 'local' | 'cloudflare' | 'ngrok';
export type Permission = {
  profile: PermissionProfile;
  allowExternalPaths: boolean; allowArbitraryCommands: boolean; allowShellMutation: boolean;
  allowNetworkAccess: boolean; allowCredentialAccess: boolean; allowComputerUse: boolean;
  allowInteractiveProcesses: boolean; allowPersistentProcesses: boolean;
};
export type Config = {
  configured: boolean; localOnly: boolean; tunnelProvider: string; port: number;
  publicBaseUrl: string; providerUrls: {cloudflare?: string; ngrok?: string};
  allowedRoots: string[]; permissionMode: string; permissions: Permission;
  toolMode: string; hasOwnerToken: boolean; hasNgrokToken: boolean; hasCloudflareToken: boolean;
  ngrokProxyUrl: string; features: Record<string, boolean>; mcpUrl: string;
  portableDisplayVersion: string;
};
export type Settings = {
  provider: Provider; publicBaseUrl: string; port: number; allowedRoots: string[];
  permissions: Permission; toolMode: string; ngrokProxyUrl: string;
  allowAllFixedDrives?: boolean;
  ngrokToken?: string; cloudflareToken?: string; ownerToken?: string;
};
export type Progress = { phase: string; message: string; step: number; total: number };
export type Backend = {
  initialize(): Promise<{config: Config; status: any; root: string; applyPending:boolean}>;
  getConfig(): Promise<Config>;
  getStatus(): Promise<any>;
  save(settings: Settings): Promise<{ mcpUrl: string; generatedOwnerToken: boolean }>;
  deploy(provider: Provider): Promise<void>;
  copySecret(kind: 'owner' | 'ngrok' | 'cloudflare'): Promise<{copied: boolean}>;
  copyUrl(kind: 'local' | 'public'): Promise<{copied: boolean}>;
  chooseFolder(): Promise<string | null>;
  runAction(action: 'diagnose' | 'restart-local' | 'restart-tunnel' | 'plugin-list' | 'continuation-list' | 'memory-list' | 'review-list' | 'oauth-client-list' | 'update-check'): Promise<unknown>;
  openLegacy(): Promise<void>;
  onStatus(handler: (value: any) => void): () => void;
  onProgress(handler: (value: Progress) => void): () => void;
};
declare global { interface Window { devspace: Backend } }
