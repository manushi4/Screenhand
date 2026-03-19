// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared sanitization utilities for redacting sensitive data from tool outputs.
 * Used by both the world model (state persistence) and MCP tool responses.
 */

import { execSync } from "node:child_process";
import os from "node:os";

const MAX_STRING_LENGTH = 1000;

const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:", "about:", "chrome:", "chrome-extension:"]);

const SENSITIVE_URL_PARAMS = new Set([
  "code", "token", "access_token", "refresh_token", "id_token",
  "secret", "password", "key", "api_key", "apikey", "auth",
  "session", "session_id", "sessionid", "state", "nonce",
]);

const SENSITIVE_LABEL_PATTERNS: Array<[RegExp, string]> = [
  // email:password in window titles (e.g. "user@example.com:P@ssw0rd! - Chrome")
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+:[^\s]+/g, "[CREDENTIALS_REDACTED]"],
  // Bearer tokens
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, "[BEARER_REDACTED]"],
];

/**
 * Sanitize untrusted strings: truncate + strip control characters.
 */
export function sanitizeString(s: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return stripped.length > MAX_STRING_LENGTH
    ? stripped.slice(0, MAX_STRING_LENGTH)
    : stripped;
}

/**
 * Sanitize a URL: validate protocol + redact sensitive query params.
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) return "about:blocked";
    let redacted = false;
    for (const paramName of parsed.searchParams.keys()) {
      if (SENSITIVE_URL_PARAMS.has(paramName.toLowerCase())) {
        parsed.searchParams.set(paramName, "[REDACTED]");
        redacted = true;
      }
    }
    return redacted ? parsed.toString() : url;
  } catch {
    return "about:blocked";
  }
}

/**
 * Check if a string looks like a token/key (32+ chars, 3+ character classes).
 */
function looksLikeToken(s: string): boolean {
  if (s.length < 32) return false;
  const hasUpper = /[A-Z]/.test(s);
  const hasLower = /[a-z]/.test(s);
  const hasDigit = /[0-9]/.test(s);
  const hasSpecial = /[\-._~+/]/.test(s);
  const classes = [hasUpper, hasLower, hasDigit, hasSpecial].filter(Boolean).length;
  return classes >= 3;
}

/**
 * Redact sensitive patterns from labels/titles: credentials, bearer tokens, long token strings.
 */
export function redactSensitiveLabel(label: string): string {
  let result = label;
  for (const [pattern, replacement] of SENSITIVE_LABEL_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  result = result.replace(/[A-Za-z0-9\-._~+/]{32,}={0,2}/g, (match) =>
    looksLikeToken(match) ? "[TOKEN_REDACTED]" : match,
  );
  return result;
}

/**
 * Redact PII patterns from text for persistence paths (Option C: redact on write, not on read).
 * Catches: email addresses, phone numbers, and the local user's name parts.
 * Applied to: memory actions/strategies, playbook exports, timeline logs.
 * NOT applied to: live tool responses (ocr, ui_tree, screenshot, browser_dom, world_state).
 */
export function redactPII(text: string): string {
  let result = text;
  // Email addresses
  result = result.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "[EMAIL_REDACTED]");
  // Phone numbers — international and domestic formats
  result = result.replace(/(?:\+\d{1,3}[\s\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g, "[PHONE_REDACTED]");
  // Local user name parts (from OS)
  result = redactUsername(result);
  // Credential patterns already handled by redactSensitiveLabel
  result = redactSensitiveLabel(result);
  return result;
}

/**
 * Redact the macOS username from strings (e.g. menu labels like "Log Out username").
 */
let _cachedNameParts: string[] | null = null;

/** Collect all name parts to redact: short username, full name from id -F, home dir name. */
function getNameParts(): string[] {
  if (_cachedNameParts !== null) return _cachedNameParts;
  const parts = new Set<string>();

  // Short username from env
  const username = process.env.USER || process.env.USERNAME || "";
  if (username.length >= 2) parts.add(username);

  // Home directory basename (e.g. /Users/khushi → khushi)
  try {
    const home = os.homedir();
    const homeName = home.split("/").pop() || "";
    if (homeName.length >= 2) parts.add(homeName);
  } catch { /* ignore */ }

  // Full display name from id -F (macOS only)
  try {
    const fullName = execSync("id -F", { encoding: "utf-8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (fullName.length >= 2) {
      parts.add(fullName);
      // Also add individual name words (e.g. "khushi goyal" → "khushi", "goyal")
      for (const word of fullName.split(/\s+/)) {
        if (word.length >= 2) parts.add(word);
      }
    }
  } catch { /* not macOS or id -F unavailable */ }

  // Sort longest first so longer matches take priority
  _cachedNameParts = [...parts].sort((a, b) => b.length - a.length);
  return _cachedNameParts;
}

/**
 * Redact the macOS username, full display name, and individual name parts from strings.
 * Also catches common patterns like "Log Out <name>" where the name may not match env vars.
 */
export function redactUsername(text: string): string {
  let result = text;
  for (const part of getNameParts()) {
    result = result.replaceAll(part, "[USER]");
  }
  // Catch "Log Out <name>" pattern — macOS always formats this as "Log Out <full display name>"
  // The name part may already be partially redacted (e.g. "[USER] goyal"), so match everything after "Log Out "
  result = result.replace(/Log Out [^\n:]+/g, "Log Out [USER]");
  return result;
}
