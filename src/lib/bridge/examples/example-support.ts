/**
 * Shared helpers for runnable bridge examples.
 */

import type {
  BridgeStore,
  LLMProvider,
  BridgeSession,
  BridgeMessage,
  LifecycleHooks,
  PermissionGateway,
  PermissionLinkRecord,
  BridgeApiProvider,
  StreamChatParams,
} from '../host.js';
import type { ChannelBinding, ChannelType } from '../types.js';

export class InMemoryStore implements BridgeStore {
  private settings = new Map<string, string>();
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private locks = new Map<string, { lockId: string; expiresAt: number }>();
  private dedup = new Map<string, number>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private nextId = 1;

  constructor(initialSettings: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initialSettings)) {
      this.settings.set(key, value);
    }
  }

  setSetting(key: string, value: string): void {
    this.settings.set(key, value);
  }

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  getChannelBinding(channelType: string, chatId: string): ChannelBinding | null {
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }

  upsertChannelBinding(data: {
    channelType: string;
    chatId: string;
    codepilotSessionId: string;
    workingDirectory: string;
    model: string;
  }): ChannelBinding {
    const key = `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    const now = new Date().toISOString();

    if (existing) {
      const updated: ChannelBinding = {
        ...existing,
        ...data,
        updatedAt: now,
      };
      this.bindings.set(key, updated);
      return updated;
    }

    const binding: ChannelBinding = {
      id: `binding-${this.nextId++}`,
      channelType: data.channelType,
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: 'code',
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.bindings.set(key, binding);
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, binding] of this.bindings) {
      if (binding.id === id) {
        this.bindings.set(key, {
          ...binding,
          ...updates,
          updatedAt: new Date().toISOString(),
        });
        return;
      }
    }
  }

  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    const bindings = Array.from(this.bindings.values());
    return channelType ? bindings.filter((binding) => binding.channelType === channelType) : bindings;
  }

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  createSession(_name: string, model: string, _systemPrompt?: string, cwd?: string): BridgeSession {
    const session: BridgeSession = {
      id: `session-${this.nextId++}`,
      working_directory: cwd || process.cwd(),
      model,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  updateSessionProviderId(sessionId: string, providerId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.set(sessionId, { ...session, provider_id: providerId });
  }

  addMessage(sessionId: string, role: string, content: string): void {
    const history = this.messages.get(sessionId) || [];
    history.push({ role, content });
    this.messages.set(sessionId, history);
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const history = this.messages.get(sessionId) || [];
    if (!opts?.limit || history.length <= opts.limit) {
      return { messages: history };
    }
    return { messages: history.slice(-opts.limit) };
  }

  acquireSessionLock(sessionId: string, lockId: string, _owner: string, ttlSecs: number): boolean {
    const now = Date.now();
    const existing = this.locks.get(sessionId);
    if (existing && existing.expiresAt > now && existing.lockId !== lockId) {
      return false;
    }
    this.locks.set(sessionId, {
      lockId,
      expiresAt: now + ttlSecs * 1000,
    });
    return true;
  }

  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const existing = this.locks.get(sessionId);
    if (!existing || existing.lockId !== lockId) return;
    this.locks.set(sessionId, {
      lockId,
      expiresAt: Date.now() + ttlSecs * 1000,
    });
  }

  releaseSessionLock(sessionId: string, lockId: string): void {
    const existing = this.locks.get(sessionId);
    if (existing?.lockId === lockId) {
      this.locks.delete(sessionId);
    }
  }

  setSessionRuntimeStatus(): void {}

  updateSdkSessionId(sessionId: string, sdkSessionId: string): void {
    for (const [key, binding] of this.bindings) {
      if (binding.codepilotSessionId === sessionId) {
        this.bindings.set(key, {
          ...binding,
          sdkSessionId,
          updatedAt: new Date().toISOString(),
        });
        break;
      }
    }
  }

  updateSessionModel(sessionId: string, model: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.set(sessionId, { ...session, model });
  }

  syncSdkTasks(): void {}

  getProvider(_id: string): BridgeApiProvider | undefined {
    return undefined;
  }

  getDefaultProviderId(): string | null {
    return null;
  }

  insertAuditLog(): void {}

  checkDedup(key: string): boolean {
    const expiresAt = this.dedup.get(key);
    return typeof expiresAt === 'number' && expiresAt > Date.now();
  }

  insertDedup(key: string): void {
    this.dedup.set(key, Date.now() + 24 * 60 * 60 * 1000);
  }

  cleanupExpiredDedup(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.dedup) {
      if (expiresAt <= now) this.dedup.delete(key);
    }
  }

  insertOutboundRef(): void {}

  insertPermissionLink(link: {
    permissionRequestId: string;
    channelType: string;
    chatId: string;
    messageId: string;
    toolName: string;
    suggestions: string;
  }): void {
    this.permissionLinks.set(link.permissionRequestId, {
      permissionRequestId: link.permissionRequestId,
      chatId: link.chatId,
      messageId: link.messageId,
      resolved: false,
      suggestions: link.suggestions,
    });
  }

  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string): boolean {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link || link.resolved) return false;
    this.permissionLinks.set(permissionRequestId, { ...link, resolved: true });
    return true;
  }

  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[] {
    return Array.from(this.permissionLinks.values()).filter((link) => !link.resolved && link.chatId === chatId);
  }

  getChannelOffset(key: string): string {
    return this.settings.get(`offset:${key}`) || '0';
  }

  setChannelOffset(key: string, offset: string): void {
    this.settings.set(`offset:${key}`, offset);
  }
}

export class EchoLLM implements LLMProvider {
  constructor(private readonly options?: { markdown?: boolean; label?: string }) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const response = this.options?.markdown
      ? this.buildMarkdownResponse(params)
      : `Echo: ${params.prompt}`;

    return new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: response })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'result',
          data: JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }),
        })}\n`);
        controller.close();
      },
    });
  }

  private buildMarkdownResponse(params: StreamChatParams): string {
    const label = this.options?.label || 'Bridge Demo';
    const quotedPrompt = params.prompt
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    const fileLines = (params.files || [])
      .map((file, index) => {
        const address = file.filePath || '(no address)';
        return `${index + 1}. ${file.name} -> ${address}`;
      });

    const sections = [
      `## ${label}`,
      '',
      `- Session: \`${params.sessionId}\``,
      `- Working Directory: \`${params.workingDirectory || process.cwd()}\``,
      `- Permission Mode: \`${params.permissionMode || 'default'}\``,
      '',
      'You said:',
      '',
      quotedPrompt,
    ];

    if (fileLines.length > 0) {
      sections.push(
        '',
        'Files:',
        '',
        ...fileLines,
      );
    }

    return sections.join('\n');
  }
}

export const allowAllPermissions: PermissionGateway = {
  resolvePendingPermission: () => true,
};

export const logLifecycle: LifecycleHooks = {
  onBridgeStart: () => console.log('[lifecycle] Bridge started'),
  onBridgeStop: () => console.log('[lifecycle] Bridge stopped'),
};
