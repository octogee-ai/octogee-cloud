export type ConnectorCaptureMethod = 'oauth-web' | 'device' | 'pat' | 'fields' | 'local-pairing';

export type ConnectorConsumption = 'platform-read' | 'agent-runtime';

const AGENT_RUNTIME: ConnectorConsumption = 'agent-runtime';

export type ConnectorFamily =
  | 'code-hosting'
  | 'deploy-hosting'
  | 'registry'
  | 'ai'
  | 'cloud'
  | 'productivity';

export type ConnectorId =
  | 'github'
  | 'vercel'
  | 'netlify'
  | 'cloudflare'
  | 'npm'
  | 'docker'
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'grok'
  | 'minimax'
  | 'openai-compatible'
  | 'gemini'
  | 'aws'
  | 'gcp'
  | 'azure'
  | 'google'
  | 'microsoft'
  | 'obsidian'
  | 'yahoo';

export interface ConnectorCaptureField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  multiline?: boolean;
}

export interface ConnectorMeta {
  id: ConnectorId;
  displayName: string;
  tagline: string;
  family: ConnectorFamily;
  captureMethods: ConnectorCaptureMethod[];
  consumption: ConnectorConsumption;
  scopes: string[];
  agentRuntimeMaterializable?: boolean;
  captureFields?: ConnectorCaptureField[];
  implemented: boolean;
}

export type GoogleCapability = 'calendar' | 'gmail' | 'drive' | 'tasks' | 'contacts';

export const GOOGLE_CAPABILITY_ORDER: readonly GoogleCapability[] = [
  'calendar',
  'gmail',
  'drive',
  'tasks',
  'contacts',
];

export const GOOGLE_CAPABILITY_SCOPES: Record<GoogleCapability, string[]> = {
  calendar: ['https://www.googleapis.com/auth/calendar.events'],
  gmail: ['https://www.googleapis.com/auth/gmail.modify'],
  drive: ['https://www.googleapis.com/auth/drive.file'],
  tasks: ['https://www.googleapis.com/auth/tasks'],
  contacts: ['https://www.googleapis.com/auth/contacts.readonly'],
};

export const GOOGLE_IDENTITY_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

export const GOOGLE_DRIVE_FULL_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

export const GOOGLE_OAUTH_REVOCATION_URL = 'https://oauth2.googleapis.com/revoke';

export const CONNECTOR_OAUTH_REVOCATION_TARGETS = [
  { connectorId: 'google', revocationUrl: GOOGLE_OAUTH_REVOCATION_URL },
] as const;

export function googleAuthRequestScopes(capability: GoogleCapability): string[] {
  return [...GOOGLE_CAPABILITY_SCOPES[capability], GOOGLE_IDENTITY_SCOPE];
}

export function googleCapabilitiesFromScopes(
  granted: readonly string[] | null | undefined,
): GoogleCapability[] {
  const set = new Set(granted ?? []);
  return GOOGLE_CAPABILITY_ORDER.filter((capability) =>
    GOOGLE_CAPABILITY_SCOPES[capability].every((scope) => set.has(scope)),
  );
}

export const GOOGLE_SCOPES = [
  ...GOOGLE_CAPABILITY_ORDER.flatMap((capability) => GOOGLE_CAPABILITY_SCOPES[capability]),
  GOOGLE_IDENTITY_SCOPE,
];

export function googleEscalationRequestScopes(escalation: string): string[] | null {
  if (escalation !== 'drive-full') return null;
  return [...GOOGLE_CAPABILITY_SCOPES.drive, GOOGLE_DRIVE_FULL_READ_SCOPE, GOOGLE_IDENTITY_SCOPE];
}

export function googleDriveFullReadGranted(granted: readonly string[] | null | undefined): boolean {
  return (granted ?? []).includes(GOOGLE_DRIVE_FULL_READ_SCOPE);
}

export interface GooglePickedFile {
  id: string;
  name: string;
  mimeType: string;
}

export function parseGooglePickedFiles(value: unknown): GooglePickedFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const { id, name, mimeType } = (entry ?? {}) as Record<string, unknown>;
    if (
      typeof id !== 'string' || id.length === 0 ||
      typeof name !== 'string' || name.length === 0 ||
      typeof mimeType !== 'string' || mimeType.length === 0
    ) {
      return [];
    }
    return [{ id, name, mimeType }];
  });
}

export const MICROSOFT_SCOPES = [
  'Files.Read.All',
  'Mail.Read',
  'Mail.Send',
  'Calendars.Read',
  'Calendars.ReadWrite',
  'User.Read',
  'offline_access',
];

export const CONNECTOR_CATALOG: readonly ConnectorMeta[] = [
  {
    id: 'github',
    tagline: 'Your repos, in your project file browser',
    displayName: 'GitHub',
    family: 'code-hosting',
    captureMethods: ['oauth-web', 'device', 'pat'],
    consumption: 'platform-read',
    scopes: ['repo'],
    agentRuntimeMaterializable: true,
    implemented: true,
  },
  {
    id: 'vercel',
    tagline: 'Deploys and previews',
    displayName: 'Vercel',
    family: 'deploy-hosting',
    captureMethods: ['pat'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    implemented: true,
  },
  {
    id: 'netlify',
    tagline: 'Deploys and previews',
    displayName: 'Netlify',
    family: 'deploy-hosting',
    captureMethods: ['pat'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    implemented: true,
  },
  {
    id: 'cloudflare',
    tagline: 'Workers, Pages and DNS',
    displayName: 'Cloudflare',
    family: 'deploy-hosting',
    captureMethods: ['pat'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    implemented: true,
  },
  {
    id: 'npm',
    tagline: 'Publish and install packages',
    displayName: 'npm',
    family: 'registry',
    captureMethods: ['pat'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    implemented: true,
  },
  {
    id: 'docker',
    tagline: 'Container images',
    displayName: 'Docker / GHCR',
    family: 'registry',
    captureMethods: ['fields'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    captureFields: [
      { key: 'username', label: 'Docker Hub username', placeholder: 'your-dockerhub-username' },
      { key: 'token', label: 'Access token', placeholder: 'dckr_pat_…', secret: true },
    ],
    implemented: true,
  },
  {
    id: 'openai',
    tagline: 'ChatGPT subscription or API key',
    displayName: 'OpenAI',
    family: 'ai',
    captureMethods: ['pat'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    implemented: false,
  },
  {
    id: 'anthropic',
    tagline: 'Claude subscription or API key',
    displayName: 'Anthropic',
    family: 'ai',
    captureMethods: ['pat'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    implemented: false,
  },
  {
    id: 'openrouter',
    tagline: 'Models through OpenRouter',
    displayName: 'OpenRouter',
    family: 'ai',
    captureMethods: ['pat'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    implemented: false,
  },
  {
    id: 'grok',
    tagline: 'xAI Grok models',
    displayName: 'Grok',
    family: 'ai',
    captureMethods: ['pat'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    implemented: false,
  },
  {
    id: 'minimax',
    tagline: 'MiniMax models',
    displayName: 'MiniMax',
    family: 'ai',
    captureMethods: ['pat'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    implemented: false,
  },
  {
    id: 'openai-compatible',
    tagline: 'Custom OpenAI-compatible endpoint',
    displayName: 'Custom OpenAI-compatible',
    family: 'ai',
    captureMethods: ['pat'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    implemented: false,
  },
  {
    id: 'gemini',
    tagline: 'Gemini API key (Google AI Studio)',
    displayName: 'Google Gemini',
    family: 'ai',
    captureMethods: ['pat'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    implemented: true,
  },
  {
    id: 'aws',
    tagline: 'Cloud credentials for your agent',
    displayName: 'AWS',
    family: 'cloud',
    captureMethods: ['fields'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    captureFields: [
      { key: 'accessKeyId', label: 'Access key ID', placeholder: 'AKIA…' },
      { key: 'secretAccessKey', label: 'Secret access key', secret: true },
    ],
    implemented: true,
  },
  {
    id: 'gcp',
    tagline: 'Cloud credentials for your agent',
    displayName: 'Google Cloud',
    family: 'cloud',
    captureMethods: ['fields'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    captureFields: [
      {
        key: 'serviceAccountJson',
        label: 'Service account key (JSON)',
        placeholder: 'Paste the downloaded key file contents',
        secret: true,
        multiline: true,
      },
    ],
    implemented: true,
  },
  {
    id: 'google',
    tagline: 'Drive, Gmail, Calendar and more for your agent',
    displayName: 'Google',
    family: 'productivity',
    captureMethods: ['oauth-web'],
    consumption: AGENT_RUNTIME,
    scopes: GOOGLE_SCOPES,
    implemented: true,
  },
  {
    id: 'microsoft',
    tagline: 'Outlook mail, calendar and OneDrive',
    displayName: 'Microsoft',
    family: 'productivity',
    captureMethods: ['oauth-web'],
    consumption: AGENT_RUNTIME,
    scopes: MICROSOFT_SCOPES,
    implemented: true,
  },
  {
    id: 'obsidian',
    tagline: 'Search, summarize and write your Markdown notes',
    displayName: 'Obsidian',
    family: 'productivity',
    captureMethods: ['local-pairing'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    implemented: true,
  },
  {
    id: 'azure',
    tagline: 'Cloud credentials for your agent',
    displayName: 'Azure',
    family: 'cloud',
    captureMethods: ['fields'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    captureFields: [
      { key: 'tenantId', label: 'Directory (tenant) ID' },
      { key: 'clientId', label: 'Application (client) ID' },
      { key: 'clientSecret', label: 'Client secret', secret: true },
    ],
    implemented: true,
  },
  {
    id: 'yahoo',
    tagline: 'Mail and calendar — via app passwords',
    displayName: 'Yahoo',
    family: 'productivity',
    captureMethods: ['pat'],
    consumption: AGENT_RUNTIME,
    scopes: [],
    implemented: false,
  },
];

export type IntegrationStatus = 'connected' | 'disconnected' | 'error' | 'pending';

export interface IntegrationStatusDoc {
  provider: string;
  status: IntegrationStatus;
  accountLabel?: string;
  scopes?: string[];
  captureMethod?: ConnectorCaptureMethod;
  pickedFiles?: GooglePickedFile[];
  error?: string;
  connectedAt: number | null;
  updatedAt: number;
  verifiedAt: number | null;
}

export interface IntegrationStatusResponse {
  integrations: Record<string, IntegrationStatusDoc>;
}
