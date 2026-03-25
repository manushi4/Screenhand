import { describe, it, expect } from "vitest";
import { extractFeaturesFromHTML, generateValueAddFeatures } from "../src/ingestion/feature-extractor.js";
import { generateLadderFromReference } from "../src/state/ladder-generator.js";
import type { WebsiteFeature } from "../src/ingestion/types.js";

describe("extractFeaturesFromHTML", () => {
  it("extracts h2/h3 headings as features", () => {
    const html = `
      <html><body>
        <h2>Create Notes</h2>
        <p>Start writing notes quickly.</p>
        <h3>Organize with Folders</h3>
        <p>Keep your notes tidy with folder structure.</p>
        <h2>Share with Friends</h2>
        <p>Send notes to anyone.</p>
      </body></html>
    `;
    const result = extractFeaturesFromHTML(html, "Notes", "https://example.com/notes");
    expect(result.websiteFeatures.length).toBe(3);
    expect(result.websiteFeatures.map((f) => f.name)).toEqual([
      "Create Notes",
      "Organize with Folders",
      "Share with Friends",
    ]);
  });

  it("assigns levels based on keywords", () => {
    const html = `
      <html><body>
        <h2>Create Notes</h2><p>Basic note creation.</p>
        <h2>Organize with Tags</h2><p>Tag your notes.</p>
        <h2>Export to PDF</h2><p>Export notes as PDF.</p>
        <h2>API Integration</h2><p>Connect with external services.</p>
      </body></html>
    `;
    const result = extractFeaturesFromHTML(html, "Notes", "https://example.com");
    const levels = Object.fromEntries(result.websiteFeatures.map((f) => [f.name, f.level]));
    expect(levels["Create Notes"]).toBe("F");
    expect(levels["Organize with Tags"]).toBe("B");
    expect(levels["Export to PDF"]).toBe("S");
    expect(levels["API Integration"]).toBe("SSS");
  });

  it("extracts feature cards", () => {
    const html = `
      <html><body>
        <div class="feature-card">
          <h3>Smart Search</h3>
          <p>Find anything instantly with powerful search.</p>
        </div>
        <div class="app-feature">
          <h3>Quick Actions</h3>
          <p>Shortcuts for common tasks.</p>
        </div>
      </body></html>
    `;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    const names = result.websiteFeatures.map((f) => f.name);
    expect(names).toContain("Smart Search");
    expect(names).toContain("Quick Actions");
  });

  it("handles empty/minimal HTML without crashing", () => {
    expect(extractFeaturesFromHTML("", "App", "https://x.com").websiteFeatures).toEqual([]);
    expect(extractFeaturesFromHTML("<html></html>", "App", "https://x.com").websiteFeatures).toEqual([]);
    expect(extractFeaturesFromHTML("<h2></h2>", "App", "https://x.com").websiteFeatures).toEqual([]);
  });

  it("deduplicates by normalized name", () => {
    const html = `
      <html><body>
        <h2>Create Notes</h2><p>Write notes.</p>
        <div class="feature"><h3>Create Notes</h3><p>Make new notes.</p></div>
      </body></html>
    `;
    const result = extractFeaturesFromHTML(html, "Notes", "https://example.com");
    const createFeatures = result.websiteFeatures.filter((f) => f.id === "create_notes");
    expect(createFeatures.length).toBe(1);
  });

  it("decodes HTML entities", () => {
    const html = `<html><body><h2>Import &amp; Export</h2><p>Move data in &#39;n&#39; out.</p></body></html>`;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    expect(result.websiteFeatures[0]!.name).toBe("Import & Export");
  });

  it("strips script/style content from features", () => {
    const html = `<html><body><h2>Feature <script>alert('xss')</script> Name</h2><p>Description.</p></body></html>`;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    expect(result.websiteFeatures[0]!.name).toBe("Feature  Name");
    expect(result.websiteFeatures[0]!.name).not.toContain("alert");
  });

  it("strips control characters from decoded entities", () => {
    // ESC character (0x1B) should be stripped
    const html = `<html><body><h2>Feature &#x1b;[31mRed&#x1b;[0m</h2><p>Desc.</p></body></html>`;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    expect(result.websiteFeatures[0]!.name).not.toContain("\x1b");
  });

  it("handles deeply nested feature divs without hanging", () => {
    const nested = "<div>".repeat(50) + "content" + "</div>".repeat(50);
    const html = `<div class="features">${nested}</div>`;
    const start = Date.now();
    extractFeaturesFromHTML(html, "App", "https://x.com");
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("skips navigation headings", () => {
    const html = `
      <html><body>
        <h2>Menu</h2>
        <h2>Footer</h2>
        <h2>Privacy</h2>
        <h2>Real Feature</h2><p>A real feature.</p>
      </body></html>
    `;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    expect(result.websiteFeatures.length).toBe(1);
    expect(result.websiteFeatures[0]!.name).toBe("Real Feature");
  });

  it("extracts definition list features", () => {
    const html = `
      <html><body>
        <dt>Smart Folders</dt>
        <dd>Automatically organize notes by topic.</dd>
        <dt>Pin Notes</dt>
        <dd>Keep important notes at the top.</dd>
      </body></html>
    `;
    const result = extractFeaturesFromHTML(html, "Notes", "https://example.com");
    expect(result.websiteFeatures.length).toBe(2);
    expect(result.websiteFeatures[0]!.description).toContain("organize");
  });

  it("includes description from nearby paragraph", () => {
    const html = `
      <html><body>
        <h2>Collaboration</h2>
        <p>Work together in real-time with shared notes.</p>
      </body></html>
    `;
    const result = extractFeaturesFromHTML(html, "Notes", "https://example.com");
    expect(result.websiteFeatures[0]!.description).toContain("real-time");
  });

  it("returns proper metadata", () => {
    const html = `<html><body><h2>Feature One</h2><p>Desc.</p></body></html>`;
    const result = extractFeaturesFromHTML(html, "TestApp", "https://test.com/features");
    expect(result.appName).toBe("TestApp");
    expect(result.url).toBe("https://test.com/features");
    expect(result.extractedAt).toBeTruthy();
  });
});

describe("generateValueAddFeatures", () => {
  const makeFeature = (name: string): WebsiteFeature => ({
    id: name.toLowerCase().replace(/\s+/g, "_"),
    name,
    description: name,
    sourceHeading: name,
    level: "F",
  });

  it("generates bulk_create when app has create feature", () => {
    const features = [makeFeature("Create Notes")];
    const valueAdds = generateValueAddFeatures("Notes", features);
    expect(valueAdds.some((v) => v.id === "bulk_create")).toBe(true);
  });

  it("generates bulk_delete when app has delete feature", () => {
    const features = [makeFeature("Delete Items")];
    const valueAdds = generateValueAddFeatures("App", features);
    expect(valueAdds.some((v) => v.id === "bulk_delete")).toBe(true);
  });

  it("generates auto_organize when app has folder/tag feature", () => {
    const features = [makeFeature("Organize with Tags")];
    const valueAdds = generateValueAddFeatures("Notes", features);
    expect(valueAdds.some((v) => v.id === "auto_organize")).toBe(true);
  });

  it("always generates summarize and change_monitor", () => {
    const valueAdds = generateValueAddFeatures("App", []);
    expect(valueAdds.some((v) => v.id === "summarize_all")).toBe(true);
    expect(valueAdds.some((v) => v.id === "change_monitor")).toBe(true);
  });

  it("generates cross_app_export when app has share feature", () => {
    const features = [makeFeature("Share Notes")];
    const valueAdds = generateValueAddFeatures("Notes", features);
    expect(valueAdds.some((v) => v.id === "cross_app_export")).toBe(true);
  });

  it("does NOT generate bulk_delete when no delete feature exists", () => {
    const features = [makeFeature("View Items")];
    const valueAdds = generateValueAddFeatures("App", features);
    expect(valueAdds.some((v) => v.id === "bulk_delete")).toBe(false);
  });

  it("sets correct categories and levels", () => {
    const features = [makeFeature("Create"), makeFeature("Delete"), makeFeature("Share")];
    const valueAdds = generateValueAddFeatures("App", features);

    const bulkCreate = valueAdds.find((v) => v.id === "bulk_create");
    expect(bulkCreate?.category).toBe("bulk");
    expect(bulkCreate?.level).toBe("B");

    const monitor = valueAdds.find((v) => v.id === "change_monitor");
    expect(monitor?.category).toBe("monitoring");
    expect(monitor?.level).toBe("SSS");
  });
});

describe("ladder generator integration", () => {
  it("includes websiteFeatures in generated ladder", () => {
    const ref = {
      selectors: {
        navigation: { home: "[data-test='home']", search: "[data-test='search']" },
        settings: { theme: "[data-test='theme']", prefs: "[data-test='prefs']" },
      },
      websiteFeatures: [
        { id: "smart_folders", name: "Smart Folders", description: "Auto-organize by topic", level: "B" },
        { id: "scan_documents", name: "Scan Documents", description: "Scan paper documents", level: "S" },
      ],
    };
    const result = generateLadderFromReference(ref);
    expect(result.ladder.some((f) => f.id === "web_smart_folders")).toBe(true);
    expect(result.ladder.some((f) => f.id === "web_scan_documents")).toBe(true);
  });

  it("includes valueAddFeatures in generated ladder", () => {
    const ref = {
      selectors: {
        navigation: { home: "[data-test='home']", search: "[data-test='search']" },
        settings: { theme: "[data-test='theme']", prefs: "[data-test='prefs']" },
      },
      valueAddFeatures: [
        { id: "bulk_create", name: "Bulk Create", description: "Create many items", level: "B", category: "bulk" },
        { id: "summarize_all", name: "Summarize", description: "Summarize content", level: "S", category: "intelligence" },
      ],
    };
    const result = generateLadderFromReference(ref);
    expect(result.ladder.some((f) => f.id === "va_bulk_create")).toBe(true);
    expect(result.ladder.some((f) => f.id === "va_summarize_all")).toBe(true);
  });

  it("does not duplicate features covered by selector groups", () => {
    const ref = {
      selectors: {
        navigation: { home: "[data-test='home']", search: "[data-test='search']" },
        settings: { theme: "[data-test='theme']", prefs: "[data-test='prefs']" },
      },
      websiteFeatures: [
        { id: "navigation", name: "Navigation", description: "Navigate the app", level: "F" },
      ],
    };
    const result = generateLadderFromReference(ref);
    // "navigation" from selectors exists; "web_navigation" should be skipped
    // because flowNamesRelated("navigation", "navigation") is true
    expect(result.ladder.some((f) => f.id === "navigation")).toBe(true);
    expect(result.ladder.some((f) => f.id === "web_navigation")).toBe(false);
  });

  it("does NOT suppress website features with partial name overlap", () => {
    const ref = {
      selectors: {
        edit: { undo: "[data-test='undo']", redo: "[data-test='redo']" },
        view: { zoom: "[data-test='zoom']", grid: "[data-test='grid']" },
      },
      websiteFeatures: [
        { id: "edit_photos", name: "Edit Photos", description: "Edit your photos", level: "B" },
        { id: "view_gallery", name: "View Gallery", description: "Browse gallery", level: "F" },
      ],
    };
    const result = generateLadderFromReference(ref);
    // These should NOT be suppressed — "edit_photos" != "edit", "view_gallery" != "view"
    expect(result.ladder.some((f) => f.id === "web_edit_photos")).toBe(true);
    expect(result.ladder.some((f) => f.id === "web_view_gallery")).toBe(true);
  });

  it("websiteFeatures alone (no selectors) produce a valid ladder", () => {
    const ref = {
      websiteFeatures: [
        { id: "create_notes", name: "Create Notes", description: "Write notes", level: "F" },
        { id: "organize_folders", name: "Organize Folders", description: "Organize with folders", level: "B" },
      ],
    };
    const result = generateLadderFromReference(ref);
    expect(result.ladder.length).toBe(2);
    expect(result.ladder.some((f) => f.id === "web_create_notes")).toBe(true);
  });

  it("hash changes when websiteFeatures change", () => {
    const ref1 = {
      selectors: { nav: { home: "h" } },
    };
    const ref2 = {
      selectors: { nav: { home: "h" } },
      websiteFeatures: [{ id: "new_feature", name: "New", description: "New feature", level: "F" }],
    };
    const hash1 = generateLadderFromReference(ref1).hash;
    const hash2 = generateLadderFromReference(ref2).hash;
    expect(hash1).not.toBe(hash2);
  });
});
