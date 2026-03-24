import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { generateLadderFromReference, type ReferenceData } from "../src/state/ladder-generator.js";

describe("ladder-generator", () => {
  const notionRef = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "references", "notion.json"), "utf-8"),
  ) as ReferenceData;

  const discordRef = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "references", "discord.json"), "utf-8"),
  ) as ReferenceData;

  describe("generateLadderFromReference", () => {
    it("generates a rich ladder from Notion reference", () => {
      const result = generateLadderFromReference(notionRef);
      expect(result.ladder.length).toBeGreaterThanOrEqual(8);
      expect(result.hash).toBeTruthy();

      // Should have features at multiple levels
      const levels = new Set(result.ladder.map(f => f.level));
      expect(levels.size).toBeGreaterThanOrEqual(2);

      // Should have signal keywords for every feature
      for (const f of result.ladder) {
        expect(result.signals[f.id]).toBeDefined();
        expect(result.signals[f.id]!.length).toBeGreaterThan(0);
      }
    });

    it("generates a rich ladder from Discord reference", () => {
      const result = generateLadderFromReference(discordRef);
      expect(result.ladder.length).toBeGreaterThanOrEqual(5);

      const levels = new Set(result.ladder.map(f => f.level));
      expect(levels.size).toBeGreaterThanOrEqual(2);
    });

    it("returns empty ladder for sparse reference", () => {
      const sparse: ReferenceData = {
        selectors: { auto_discovered: { foo: "bar" } },
        flows: {},
      };
      const result = generateLadderFromReference(sparse);
      expect(result.ladder.length).toBe(0);
    });

    it("returns empty ladder for empty reference", () => {
      const result = generateLadderFromReference({});
      expect(result.ladder.length).toBe(0);
    });

    it("assigns proper levels based on feature names", () => {
      const result = generateLadderFromReference(notionRef);
      const featureMap = new Map(result.ladder.map(f => [f.id, f]));

      // navigation should be F tier
      const nav = featureMap.get("navigation");
      expect(nav?.level).toBe("F");

      // database should be S tier
      const db = featureMap.get("database");
      expect(db?.level).toBe("S");

      // ai_sidebar should be SSS tier
      const ai = featureMap.get("ai_sidebar");
      expect(ai?.level).toBe("SSS");
    });

    it("marks complex features as critical", () => {
      const result = generateLadderFromReference(notionRef);
      const criticals = result.ladder.filter(f => f.critical);
      expect(criticals.length).toBeGreaterThanOrEqual(1);
    });

    it("generates meaningful signal keywords", () => {
      const result = generateLadderFromReference(notionRef);

      // Navigation signals should include navigation-related keywords
      const navSignals = result.signals["navigation"];
      expect(navSignals).toBeDefined();
      expect(navSignals!.some(k => k.includes("sidebar") || k.includes("back") || k.includes("find"))).toBe(true);

      // Database signals should include database-related keywords
      const dbSignals = result.signals["database"];
      expect(dbSignals).toBeDefined();
      expect(dbSignals!.some(k => k.includes("tasks") || k.includes("status") || k.includes("view"))).toBe(true);
    });

    it("produces deterministic hash", () => {
      const r1 = generateLadderFromReference(notionRef);
      const r2 = generateLadderFromReference(notionRef);
      expect(r1.hash).toBe(r2.hash);
    });

    it("produces different hash for different references", () => {
      const r1 = generateLadderFromReference(notionRef);
      const r2 = generateLadderFromReference(discordRef);
      expect(r1.hash).not.toBe(r2.hash);
    });

    it("handles reference with flows only (no selectors)", () => {
      const flowOnly: ReferenceData = {
        flows: {
          create_page: { steps: ["Click new", "Type title", "Press enter"], guards: ["Must be logged in"] },
          edit_page: { steps: ["Click page", "Edit content"], guards: [] },
          share_page: { steps: ["Click share", "Enter email", "Send"], guards: ["Must be owner"] },
        },
      };
      const result = generateLadderFromReference(flowOnly);
      expect(result.ladder.length).toBeGreaterThanOrEqual(2);
    });

    it("merges flow keywords into matching selector features", () => {
      const ref: ReferenceData = {
        selectors: {
          database: { view: "view selector", filter: "filter btn" },
          navigation: { sidebar: "sidebar nav", back: "back btn" },
        },
        flows: {
          create_database: { steps: ["Type /database", "Choose template", "Click done"] },
        },
      };
      const result = generateLadderFromReference(ref);
      // "database" feature should exist (from selector group)
      const db = result.ladder.find(f => f.id === "database");
      expect(db).toBeDefined();
      // Its signals should include keywords from the flow too
      const signals = result.signals["database"];
      expect(signals).toBeDefined();
      expect(signals!.some(k => k.includes("template") || k.includes("create"))).toBe(true);
    });
  });
});
