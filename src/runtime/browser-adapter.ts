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

import type {
  ExtractFormat,
  LocatedElement,
  PageMeta,
  SessionInfo,
  Target,
  WaitCondition,
} from "../types.js";

export interface BrowserAdapter {
  connect(profile: string): Promise<SessionInfo>;
  getPageMeta(sessionId: string): Promise<PageMeta>;
  navigate(sessionId: string, url: string, timeoutMs: number): Promise<PageMeta>;
  locate(
    sessionId: string,
    target: Target,
    timeoutMs: number,
  ): Promise<LocatedElement | null>;
  click(sessionId: string, element: LocatedElement): Promise<void>;
  setValue(
    sessionId: string,
    element: LocatedElement,
    text: string,
    clear: boolean,
  ): Promise<void>;
  getValue(sessionId: string, element: LocatedElement): Promise<string>;
  waitFor(
    sessionId: string,
    condition: WaitCondition,
    timeoutMs: number,
  ): Promise<boolean>;
  extract(
    sessionId: string,
    target: Target,
    format: ExtractFormat,
  ): Promise<unknown>;
  screenshot(
    sessionId: string,
    region?: { x: number; y: number; width: number; height: number },
  ): Promise<string>;
}

export class PlaceholderBrowserAdapter implements BrowserAdapter {
  async connect(profile: string): Promise<SessionInfo> {
    return {
      sessionId: `session_${profile}_${Date.now()}`,
      profile,
      createdAt: new Date().toISOString(),
    };
  }

  async getPageMeta(_sessionId: string): Promise<PageMeta> {
    return { url: "about:blank", title: "Placeholder Session" };
  }

  async navigate(
    _sessionId: string,
    url: string,
    _timeoutMs: number,
  ): Promise<PageMeta> {
    return { url, title: "Placeholder Navigation" };
  }

  async locate(
    _sessionId: string,
    _target: Target,
    _timeoutMs: number,
  ): Promise<LocatedElement | null> {
    throw new Error("Browser adapter not implemented: locate");
  }

  async click(_sessionId: string, _element: LocatedElement): Promise<void> {
    throw new Error("Browser adapter not implemented: click");
  }

  async setValue(
    _sessionId: string,
    _element: LocatedElement,
    _text: string,
    _clear: boolean,
  ): Promise<void> {
    throw new Error("Browser adapter not implemented: setValue");
  }

  async getValue(_sessionId: string, _element: LocatedElement): Promise<string> {
    throw new Error("Browser adapter not implemented: getValue");
  }

  async waitFor(
    _sessionId: string,
    _condition: WaitCondition,
    _timeoutMs: number,
  ): Promise<boolean> {
    throw new Error("Browser adapter not implemented: waitFor");
  }

  async extract(
    _sessionId: string,
    _target: Target,
    _format: ExtractFormat,
  ): Promise<unknown> {
    throw new Error("Browser adapter not implemented: extract");
  }

  async screenshot(
    _sessionId: string,
    _region?: { x: number; y: number; width: number; height: number },
  ): Promise<string> {
    throw new Error("Browser adapter not implemented: screenshot");
  }
}
