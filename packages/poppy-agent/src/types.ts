/**
 * Wire types from the Personal Agent Protocol (Poppy) Draft 0.1.
 *
 * Every object is "open": the spec requires both sides to ignore fields they don't recognize
 * (3.3), so these interfaces only name what this client reads, and keep an index signature.
 */

export interface PoppyDocument {
  protocol_version: string;
  organization: { name: string; domain: string; [k: string]: unknown };
  auth?: PoppyAuth;
  agent?: { protocols: PoppyProtocolEntry[]; [k: string]: unknown };
  web?: { browser_session_endpoint?: string; [k: string]: unknown };
  apis?: PoppyApiEntry[];
  extensions?: Record<string, { version: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface PoppyAuth {
  issuer: string;
  direct?: { scopes: string[]; [k: string]: unknown };
  device?: { scopes: string[]; [k: string]: unknown };
  mediated?: {
    endpoint: string;
    fields: MediatedField[];
    scopes: string[];
    [k: string]: unknown;
  };
  custom_scopes?: Record<string, string>;
  [k: string]: unknown;
}

export interface MediatedField {
  name: string;
  label: string;
  secret: boolean;
  [k: string]: unknown;
}

export interface PoppyProtocolEntry {
  type: string;
  endpoint: string;
  resource?: string;
  [k: string]: unknown;
}

export interface PoppyApiEntry {
  type: string;
  url: string;
  description?: string;
  resource?: string;
  [k: string]: unknown;
}

/** RFC 8414 metadata, plus the Poppy `poppy_domains` field (3.2). */
export interface AuthServerMetadata {
  issuer: string;
  token_endpoint: string;
  revocation_endpoint: string;
  authorization_endpoint?: string;
  device_authorization_endpoint?: string;
  poppy_domains: string[];
  [k: string]: unknown;
}

/** Client ID Metadata Document published by the Personal Agent (4.1). */
export interface ClientMetadata {
  client_id: string;
  client_name: string;
  logo_uri?: string;
  jwks_uri: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'private_key_jwt';
  extensions?: Record<string, { version: string }>;
  [k: string]: unknown;
}

/** Token endpoint success response (4.2, 4.4). */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  session_id: string;
  signed_in: boolean;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  [k: string]: unknown;
}

/** RFC 8628 device authorization response (4.6). */
export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
  [k: string]: unknown;
}

export type MediatedStatus = 'complete' | 'code_required' | 'failed' | 'expired';

export interface MediatedResponse extends Partial<TokenResponse> {
  status: MediatedStatus;
  sign_in_id?: string;
  code?: { sent_to?: string; [k: string]: unknown };
  expires_at?: string;
}

/* ---------------------------------------------------------------- Conversations (section 7) */

export interface MessageContext {
  locale?: string;
  time_zone?: string;
  user_available?: boolean;
  [k: string]: unknown;
}

/** A message the Personal Agent sends (7.4). */
export interface OutgoingMessage {
  id: string;
  sender: 'agent' | 'human';
  text?: string;
  data?: Record<string, unknown>;
  context?: MessageContext;
}

/** A message as it appears in a `message` event (7.5). */
export interface EventMessage {
  id: string;
  role?: 'user' | 'company';
  sender: 'agent' | 'human';
  text?: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

export type ConversationStatus = 'working' | 'idle' | 'queued' | 'closed';
export type Responder = 'agent' | 'human';

export interface ConversationEvent {
  id: string;
  type: string;
  created_at: string;
  message?: EventMessage;
  status?: ConversationStatus;
  responder?: Responder;
  error?: string;
  scope?: string;
  reason?: string;
  conversation_id?: string;
  [k: string]: unknown;
}

export interface ConversationState {
  status: ConversationStatus;
  responder: Responder;
}

export interface StartConversationResponse extends ConversationState {
  conversation_id: string;
  /** Present when the request carried `wait` (7.3). */
  events?: ConversationEvent[];
  cursor?: string;
  has_more?: boolean;
  [k: string]: unknown;
}

export interface EventsPage extends ConversationState {
  conversation_id: string;
  events: ConversationEvent[];
  cursor?: string;
  has_more: boolean;
  [k: string]: unknown;
}

export interface TextDelta {
  message_id: string;
  text: string;
}
