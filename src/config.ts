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

import type { ActionBudget } from "./types.js";

export const DEFAULT_ACTION_BUDGET: ActionBudget = {
  locateMs: 800,
  actMs: 200,
  verifyMs: 2000,
  maxRetries: 1,
};

export const DEFAULT_NAVIGATE_TIMEOUT_MS = 10_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 2_000;
export const DEFAULT_PROFILE = "automation";
