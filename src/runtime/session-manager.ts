// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only
//
// This file is part of ScreenHand.
//
// ScreenHand is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, version 3.
//
// ScreenHand is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with ScreenHand. If not, see <https://www.gnu.org/licenses/>.

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
