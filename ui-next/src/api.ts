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
  allowedRoots: string[]; selectedRoots?: string[]; permissionMode: string; permissions: Permission;
  operationMode?: 'standard' | 'full' | 'custom';
  toolMode: string; hasOwnerToken: boolean; hasNgrokToken: boolean; hasCloudflareToken: boolean;
  ngrokProxyUrl: string; features: Record<string, boolean>; mcpUrl: string;
  portableDisplayVersion: string;
  autoContinuationEnabled?:boolean;
  forceModelWorkflowEnabled?:boolean;
};
export type Settings = {
  provider: Provider; publicBaseUrl: string; port: number; allowedRoots: string[];
  permissions: Permission; toolMode: string; ngrokProxyUrl: string;
  fileScopeMode: 'selected' | 'all'; operationMode: 'standard' | 'full' | 'custom';
  allowAllFixedDrives?: boolean;
  ngrokToken?: string; cloudflareToken?: string; ownerToken?: string;
};
export type Progress = { phase: string; message: string; step: number; total: number };
export type UpdateProgress = {
  phase:string;title:string;description:string;bytesReceived:number;bytesTotal:number;
  percent:number|null;speedBytesPerSecond:number;etaSeconds:number|null;updatedAt:number;
};
export type UpdateState = {progress:UpdateProgress|null;lastInstall:{
  success:boolean;version:string;servicesRecovered:boolean;occurredAt:number;
}|null};
export type CloseChoice = 'minimize-tray' | 'exit-ui' | 'cancel';
export type ModelProvider = {
  id:string; name:string; type:'deepseek'|'custom'|'ollama'|'vllm';
  baseUrl:string; model:string; api:'chat'|'responses';
  role:'worker'|'reviewer'|'planner';
  contextLength:number;maxOutputTokens:number;maxTaskUSD:number;
  inputPerMillionUSD:number;outputPerMillionUSD:number;
  hasKey:boolean;keyEncrypted:boolean;
  workerCredentialReady?:boolean;
  reasoningEffort?:'auto'|'off'|'low'|'medium'|'high'|'extra-high';
  reasoningAdapter?:'auto'|'native'|'openai';
  vision?:boolean;
  allowCalls:boolean;
};
export type ModelProviderDraft = Omit<ModelProvider,'hasKey'|'keyEncrypted'|'workerCredentialReady'> & {
  apiKey?:string;clearKey?:boolean;
};
export type AgentGroup={id:string;name:string;members:string[];childGroups?:string[];isDefault:boolean;requiredReviews:number;parallelism?:number;backendParallelism?:number;leaderId?:string;writerId?:string};
export type AgentTeam={leader:string;writer:string;reviewers:string[];phase:string;assignments:Record<string,{goal:string;dependsOn:string[];status:string;summary?:string}>};
export type AgentRouteMode='auto'|'single'|'group';
export type AgentRoutingSettings={mode:AgentRouteMode;defaultWorkerId:string|null};
export type AgentTaskRouting={requestedMode:AgentRouteMode;mode:'single'|'group';reason:string;detail?:string};
export type AgentTask={id:string;instruction:string;workspaceId:string;groupId:string|null;status:string;steps:number;createdAt:string;updatedAt?:string;error?:string;result?:string;pending?:unknown;team?:AgentTeam;routing?:AgentTaskRouting;parallelism?:number;backendParallelism?:number;agents:{id:string;profileId:string;state:string;steps:number;inputTokens:number;outputTokens:number;estimatedUSD:number;contextEstimate:number;groupPaths?:string[][]}[]};
export type AgentEvent={seq:number;at:string;kind:string;agent:string|null;[key:string]:unknown};
export type ModelDiscovery = {reachable:boolean;httpStatus:number;models:string[];reason?:string;contexts?:Record<string,number>};
export type ReasoningSettings={adapter:string;requested:string;effective:string;parameters:Record<string,unknown>};
export type ModelProbe = {connected:boolean;httpStatus:number;
  functionCalling:'supported'|'unsupported'|'not-tested';returnedToolCall?:boolean;
  reasoning?:{planned:ReasoningSettings;applied:ReasoningSettings;accepted:boolean;reasoningReturned?:boolean;reasoningChars?:number;reasoningTokens?:number|null};
  usage?:{inputTokens:number;outputTokens:number;estimatedUSD:number}|null};
export type ModelUsageStats = {
  profileId:string;model:string;firstCallAt:string|null;lastCallAt:string|null;
  lastCompletedAt:string|null;lastDurationMs:number|null;lastStatus:'success'|'failed'|null;
  totalCalls:number;successfulCalls:number;failedCalls:number;
  inputTokens:number;outputTokens:number;totalTokens:number;
  totalDurationMs:number;estimatedUSD:number;usageMissingCalls:number;
  corruptRecords:number;bySource:{worker:number;'connection-test':number;'function-test':number};
};
export type Backend = {
  initialize(): Promise<{config: Config; status: any; root: string; applyPending:boolean}>;
  getConfig(): Promise<Config>;
  getStatus(): Promise<any>;
  getUpdateState(since?:number):Promise<UpdateState>;
  startUpdateInstaller(stagingPath:string):Promise<{started:boolean}>;
  save(settings: Settings): Promise<{ mcpUrl: string; generatedOwnerToken: boolean }>;
  deploy(provider: Provider): Promise<void>;
  copySecret(kind: 'owner' | 'ngrok' | 'cloudflare'): Promise<{copied: boolean}>;
  copyValue(value:string): Promise<{copied:boolean}>;
  pickPlugin(): Promise<string|null>;
  pickExport(suggestedName:string): Promise<string|null>;
  admin(action:string,payload:Record<string,unknown>,confirmed?:boolean):Promise<any>;
  modelProvidersList():Promise<ModelProvider[]>;
  modelProvidersSave(config:ModelProviderDraft):Promise<ModelProvider>;
  modelProvidersSetAllowed(id:string,enabled:boolean):Promise<ModelProvider>;
  modelProvidersDelete(id:string):Promise<{removed:boolean}>;
  modelProvidersDiscover(id:string):Promise<ModelDiscovery>;
  modelProvidersProbe(id:string,tools?:boolean,reasoning?:boolean):Promise<ModelProbe>;
  modelProvidersStats(id:string):Promise<ModelUsageStats>;
  agentGroupsList():Promise<AgentGroup[]>;
  agentGroupsSave(input:AgentGroup):Promise<AgentGroup>;
  agentGroupsDelete(id:string):Promise<{removed:boolean}>;
  agentRuntime(action:string,payload?:Record<string,unknown>):Promise<any>;
  copyUrl(kind: 'local' | 'public'): Promise<{copied: boolean}>;
  chooseFolder(): Promise<string | null>;
  runAction(action: 'diagnose' | 'restart-local' | 'restart-tunnel' | 'plugin-list' | 'continuation-list' | 'memory-list' | 'review-list' | 'oauth-client-list' | 'update-check'): Promise<unknown>;
  onStatus(handler: (value: any) => void): () => void;
  onProgress(handler: (value: Progress) => void): () => void;
  onCloseRequest(handler:()=>void):()=>void;
  chooseClose(choice:CloseChoice,remember?:boolean):Promise<{action:CloseChoice}>;
  getClosePreference():Promise<'' | 'minimize-tray' | 'exit-ui'>;
  setClosePreference(choice:'' | 'minimize-tray' | 'exit-ui'):Promise<{choice:'' | 'minimize-tray' | 'exit-ui'}>;
  resetClosePreference():Promise<{remembered:boolean}>;
};
declare global { interface Window { devspace: Backend } }
