import type { AppAdapter } from "./app-adapter.js";
import type { SessionInfo } from "../types.js";

export class SessionManager {
  private readonly sessionsByProfile = new Map<string, SessionInfo>();
  private readonly sessionsById = new Map<string, SessionInfo>();

  constructor(private readonly adapter: AppAdapter) {}

  async sessionStart(profile: string): Promise<SessionInfo> {
    const existing = this.sessionsByProfile.get(profile);
    if (existing) {
      return existing;
    }

    const created = await this.adapter.attach(profile);
    this.sessionsByProfile.set(profile, created);
    this.sessionsById.set(created.sessionId, created);
    return created;
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessionsById.get(sessionId);
  }

  requireSession(sessionId: string): SessionInfo {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }
}
