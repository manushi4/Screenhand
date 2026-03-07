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

export class LocatorCache {
  private readonly store = new Map<string, string>();

  get(siteKey: string, actionKey: string): string | undefined {
    return this.store.get(this.key(siteKey, actionKey));
  }

  set(siteKey: string, actionKey: string, locator: string): void {
    this.store.set(this.key(siteKey, actionKey), locator);
  }

  private key(siteKey: string, actionKey: string): string {
    return `${siteKey}::${actionKey}`;
  }
}
