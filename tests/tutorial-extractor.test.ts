// Copyright (C) 2025 Clazro Technology Private Limited
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import { TutorialExtractor } from "../src/ingestion/tutorial-extractor.js";
import type { TranscriptSegment } from "../src/ingestion/tutorial-extractor.js";

describe("TutorialExtractor", () => {
  const extractor = new TutorialExtractor();

  function seg(text: string, startTime = 0, duration = 5): TranscriptSegment {
    return { text, startTime, duration };
  }

  it("extracts click actions from transcript", () => {
    const segments = [
      seg("First, click on the Edit tab."),
      seg("Then click the Trim button."),
    ];
    const result = extractor.extract(segments, "Test Tutorial", "davinci");
    expect(result.steps.length).toBeGreaterThanOrEqual(2);
    expect(result.steps.some((s) => s.tool === "click_text")).toBe(true);
  });

  it("extracts type actions", () => {
    const segments = [seg("Now type your project name in the field.")];
    const result = extractor.extract(segments, "Test", "generic");
    expect(result.steps.some((s) => s.tool === "type_text")).toBe(true);
  });

  it("extracts keyboard shortcuts", () => {
    const segments = [seg("Press Cmd+S to save your work.")];
    const result = extractor.extract(segments, "Test", "generic");
    expect(result.steps.some((s) => s.tool === "key")).toBe(true);
  });

  it("skips filler/promo segments", () => {
    const segments = [
      seg("Hey guys, welcome back to my channel!"),
      seg("Don't forget to subscribe and like this video."),
      seg("Click on File to open the menu."),
    ];
    const result = extractor.extract(segments, "Test", "generic");
    // Only the action segment should produce steps
    expect(result.steps.length).toBe(1);
  });

  it("deduplicates consecutive identical steps", () => {
    const segments = [
      seg("Click the play button."),
      seg("Click the play button."),
      seg("Click the stop button."),
    ];
    const result = extractor.extract(segments, "Test", "generic");
    const playSteps = result.steps.filter((s) =>
      s.description.toLowerCase().includes("play"),
    );
    expect(playSteps.length).toBe(1);
  });

  it("converts to playbook steps", () => {
    const segments = [
      seg("Click the Export button."),
      seg("Type the filename."),
    ];
    const result = extractor.extract(segments, "Test", "generic");
    const pbSteps = extractor.toPlaybookSteps(result);
    expect(pbSteps.length).toBeGreaterThanOrEqual(1);
    for (const step of pbSteps) {
      expect(step.tool).toBeTruthy();
      expect(step.params).toBeDefined();
    }
  });

  it("sets metadata correctly", () => {
    const segments = [seg("Click Save."), seg("Click Export.")];
    const result = extractor.extract(segments, "My Tutorial", "figma");
    expect(result.title).toBe("My Tutorial");
    expect(result.platform).toBe("figma");
    expect(result.rawSegments).toBe(2);
    expect(result.extractedAt).toBeTruthy();
  });

  it("handles empty transcript", () => {
    const result = extractor.extract([], "Empty", "generic");
    expect(result.steps).toHaveLength(0);
    expect(result.rawSegments).toBe(0);
  });

  it("extracts drag actions as click_text fallback", () => {
    const segments = [seg("Drag the clip to the timeline.")];
    const result = extractor.extract(segments, "Test", "generic");
    expect(result.steps.some((s) => s.tool === "click_text")).toBe(true);
  });

  it("extracts scroll actions", () => {
    const segments = [seg("Scroll down to find the settings panel.")];
    const result = extractor.extract(segments, "Test", "generic");
    expect(result.steps.some((s) => s.tool === "scroll")).toBe(true);
  });
});
