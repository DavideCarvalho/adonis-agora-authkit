import type { HttpContext } from '@adonisjs/core/http';

/**
 * The Agora dev-tools registration contract, version 1, declared here STRUCTURALLY.
 *
 * `@adonis-agora/agent`'s `mcp_provider` binds a hub at `'agora.devTools'` in its `register()`; every
 * lib with a console registers its developer tools into it from its own `boot()`, and the agent
 * serves them all on one MCP endpoint (`/mcp/agora`). authkit never imports the agent: the only
 * coupling is the binding name and these shapes.
 */

/** The container binding the hub lives at. */
export const DEV_TOOLS_BINDING = 'agora.devTools';

/** The hub a lib registers into. */
export interface DevToolsHub {
  readonly version: number;
  register(lib: DevToolsLib): void;
}

/** One lib's tools and the gate that decides who may use them. */
export interface DevToolsLib {
  lib: string;
  title: string;
  authorize(ctx: HttpContext): Promise<DevToolsDecision>;
  tools: DevTool[];
}

/** What `authorize` answers. */
export type DevToolsDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'unauthenticated' | 'forbidden';
      redirectTo?: string;
      error?: unknown;
    };

/** One developer tool. */
export interface DevTool {
  /** `authkit_<verb>_<noun>`. */
  name: string;
  kind: 'read' | 'action';
  description: string;
  input: DevToolInputSchema;
  destructive?: boolean;
  available?(): boolean | Promise<boolean>;
  run(input: Record<string, unknown>, call: DevToolCall): Promise<unknown>;
}

/** What a tool's `run` receives besides its input. */
export interface DevToolCall {
  ctx: HttpContext;
  caller: { id: string; via: 'token' | 'session' | 'open' };
  limits: { maxRows: number; maxBytes: number };
}

/** One property of a {@link DevToolInputSchema}. */
export interface DevToolInputProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  items?: { type: 'string' };
  minimum?: number;
  maximum?: number;
}

/** An object of scalar / enum / array-of-string properties. */
export interface DevToolInputSchema {
  type: 'object';
  properties: Record<string, DevToolInputProperty>;
  required?: string[];
}
