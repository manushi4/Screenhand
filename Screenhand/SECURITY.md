# Security Policy

## Overview

ScreenHand is a desktop automation tool with significant system access. We take security seriously.

## What ScreenHand Can Access

- **Screen content** via screenshots and OCR
- **UI elements** via native Accessibility APIs (macOS) / UI Automation (Windows)
- **Keyboard and mouse** input simulation
- **Chrome browser** tabs via DevTools Protocol (requires Chrome launched with debug port)
- **AppleScript** execution (macOS only)

## What ScreenHand Cannot Do

- ScreenHand does **not** send screen data or any information to external servers
- It does **not** access browser cookies, passwords, or stored credentials
- It does **not** run with elevated/admin privileges
- It does **not** modify system settings or install background services
- It does **not** communicate with any remote server (all operations are local)

## Permissions Required

### macOS
- **Accessibility permission**: System Settings > Privacy & Security > Accessibility > enable your terminal app
- This is a standard macOS requirement for any app that reads UI elements or simulates input

### Windows
- No special permissions needed — UI Automation works without admin for most applications

## Audit Logging

All tool calls are logged to `.audit-log.jsonl` with timestamps. This file is gitignored by default and stays on your machine.

## Reporting a Vulnerability

If you discover a security vulnerability, please email **security@screenhand.com** instead of opening a public issue.

We will acknowledge receipt within 48 hours and aim to provide a fix within 7 days for critical issues.

## Responsible Use

ScreenHand is designed for legitimate automation, testing, and productivity use cases. Users are responsible for ensuring their use complies with applicable laws and the terms of service of any applications they automate.
