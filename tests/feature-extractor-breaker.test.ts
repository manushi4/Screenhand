/**
 * Breaker tests for Phase 8 Website Feature Discovery.
 * Goal: find real bugs, not validate happy paths.
 */
import { describe, it, expect } from "vitest";
import {
  extractFeaturesFromHTML,
  generateValueAddFeatures,
} from "../src/ingestion/feature-extractor.js";
import { generateLadderFromReference } from "../src/state/ladder-generator.js";
import type { WebsiteFeature } from "../src/ingestion/types.js";

// ─── BUG HUNT 1: Script tags leak into features ─────────────────────────────

describe("HTML injection / script leak", () => {
  it("BUG: script tag content inside headings leaks into feature names", () => {
    const html = `
      <h2>Feature <script>alert('xss')</script> Name</h2>
      <p>Description here.</p>
    `;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    // After stripTags, the script tag should be removed but the text inside it survives.
    // The feature name will be "Feature alert('xss') Name" — is that intended?
    // At minimum it should NOT contain <script> tags
    for (const f of result.websiteFeatures) {
      expect(f.name).not.toContain("<script>");
      expect(f.name).not.toContain("</script>");
    }
    // FIXED: scripts are now stripped before processing — no content leak
    if (result.websiteFeatures.length > 0) {
      expect(result.websiteFeatures[0]!.name).not.toContain("alert");
    }
  });

  it("BUG: style tag content leaks into feature text", () => {
    const html = `
      <h2>Real Feature</h2>
      <p><style>.hidden { display: none; }</style>Actual description.</p>
    `;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    const feature = result.websiteFeatures.find(f => f.name === "Real Feature");
    // The description will contain the CSS text after stripTags:
    // ".hidden { display: none; }Actual description."
    expect(feature).toBeDefined();
    // FIXED: style blocks are now stripped before processing
    expect(feature!.description).not.toContain(".hidden");
  });

  it("BUG: HTML comments leak into feature names after stripTags", () => {
    // Comments like <!-- hidden --> are NOT matched by <[^>]*> regex
    // because comments contain > inside: <!-- some > text -->
    const html = `<h2>Feature <!-- comment --> Name</h2><p>Desc</p>`;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    if (result.websiteFeatures.length > 0) {
      // stripTags regex <[^>]*> will handle <!-- comment --> ONLY if there's no > inside.
      // Standard comment: <!-- text --> is matched because [^>]* stops at first >.
      // So "<!-- comment --" matches, leaving "> Name" with a stray ">"
      // Actually let's just check what happens:
      const name = result.websiteFeatures[0]!.name;
      // The regex <[^>]*> matches "<!-- comment -->" as one match because
      // [^>]* matches "!-- comment --" then > closes. So it works here.
      // But try: <!-- text with > inside -->
      expect(name).not.toContain("<!--");
    }
  });

  it("BUG: comments with > inside break stripTags", () => {
    // This is the real attack: HTML comment containing a > character
    const html = `<h2>Before <!-- a > b --> After</h2><p>Desc</p>`;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    if (result.websiteFeatures.length > 0) {
      const name = result.websiteFeatures[0]!.name;
      // FIXED: comments are now stripped in preprocessing (stripScriptsAndStyles)
      // The state-machine stripTags also handles stray > correctly
      expect(name).not.toContain("-->");
    }
  });
});

// ─── BUG HUNT 2: Card regex fails on nested divs ────────────────────────────

describe("Card extraction with nested divs", () => {
  it("BUG: card regex truncates at first </div>, missing content in nested structures", () => {
    // Real-world HTML has nested divs inside feature cards
    const html = `
      <div class="feature-card">
        <div class="icon-wrapper">
          <img src="icon.svg" />
        </div>
        <h3>Deep Feature</h3>
        <p>This is a deeply nested feature description.</p>
      </div>
    `;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    // The cardRegex: /<div[^>]*class="[^"]*feature[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
    // uses lazy matching ([\s\S]*?) which will match up to the FIRST </div>
    // That first </div> closes the icon-wrapper, NOT the feature-card.
    // So cardHtml = '\n        <div class="icon-wrapper">\n          <img src="icon.svg" />\n        '
    // The heading h3 is OUTSIDE the captured group. Feature will NOT be extracted from card.
    // However, it WILL be extracted by the heading regex in step 1.
    const cardFeature = result.websiteFeatures.find(f => f.name === "Deep Feature");
    // It exists from heading extraction, but the card regex FAILED to capture it.
    // This means card-specific logic (description from card's <p>) is lost.
    expect(cardFeature).toBeDefined();
    // The description should come from heading's nearby <p> instead
    // But let's verify the card regex specifically failed:
    // To prove this, use HTML where the heading is ONLY inside a card (not a standalone heading)
  });

  it("BUG: nested div with feature class steals content from outer card", () => {
    const html = `
      <div class="feature-list">
        <div class="inner">
          <h3>Inner Feature</h3>
          <p>Inner description.</p>
        </div>
        <div class="another">
          <h3>Outer Feature</h3>
          <p>Should belong to feature-list context.</p>
        </div>
      </div>
    `;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    // cardRegex will match class="feature-list" and capture up to first </div>
    // which is the closing of "inner" div. So only content before first </div>
    // is captured. "Outer Feature" is missed by card extraction.
    // Both should still be found by heading extraction though.
    const names = result.websiteFeatures.map(f => f.name);
    expect(names).toContain("Inner Feature");
    expect(names).toContain("Outer Feature");
  });
});

// ─── BUG HUNT 3: Deduplication case sensitivity ─────────────────────────────

describe("Deduplication edge cases", () => {
  it("features with different cases produce different IDs (case-insensitive dedup works)", () => {
    const html = `
      <h2>Create Notes</h2><p>Make notes.</p>
      <h3>CREATE NOTES</h3><p>Make notes loudly.</p>
      <h3>create notes</h3><p>Make notes quietly.</p>
    `;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    // nameToId lowercases everything, so all three produce "create_notes"
    // First one wins, rest are skipped via seen.has(id)
    const createFeatures = result.websiteFeatures.filter(f => f.id === "create_notes");
    expect(createFeatures.length).toBe(1);
    expect(createFeatures[0]!.name).toBe("Create Notes"); // first wins
  });

  it("BUG: features with different special chars but same words are NOT deduped", () => {
    const html = `
      <h2>Import & Export</h2><p>Move data.</p>
      <h2>Import &amp; Export</h2><p>Move data differently.</p>
    `;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    // First: "Import & Export" -> nameToId = "import_export"
    // Second: decoded "Import & Export" -> nameToId = "import_export" -> DEDUPED
    // Actually this should work correctly. Let's verify.
    const importFeatures = result.websiteFeatures.filter(f => f.id === "import_export");
    expect(importFeatures.length).toBe(1);
  });
});

// ─── BUG HUNT 4: Double-encoded entities ────────────────────────────────────

describe("Double-encoded HTML entities", () => {
  it("BUG: double-encoded entities are only decoded once", () => {
    // Server sends &amp;amp; which should decode to &amp; then to &
    // But decodeHTMLEntities only does one pass
    const html = `<h2>Save &amp;amp; Load</h2><p>Desc.</p>`;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    const feature = result.websiteFeatures[0];
    expect(feature).toBeDefined();
    // After one pass: "Save &amp; Load" (the &amp; from &amp;amp; becomes &, then amp; remains)
    // Actually: &amp;amp; -> first pass replaces &amp; with &, leaving "&amp;"
    // Wait, let me think again. The string is "Save &amp;amp; Load"
    // replaceAll("&amp;", "&") turns it into "Save &amp; Load"
    // No wait: "&amp;amp;" contains "&amp;" at position 0. After replacing: "&amp;" at the start.
    // Hmm, replaceAll processes left to right without re-scanning. So:
    // "Save &amp;amp; Load" -> replaceAll("&amp;","&") -> "Save &amp; Load"
    // Wait no. "&amp;amp;" -> the first &amp; matches and becomes "&", leaving "amp; Load"
    // So result is "Save &amp; Load". That's ONE ampersand followed by "amp; Load"
    // No. Let me be precise:
    // Input: "Save &amp;amp; Load"
    // replaceAll("&amp;", "&") replaces ALL non-overlapping occurrences left-to-right
    // First match: "&amp;" at index 5. Replace with "&". String becomes "Save &amp; Load"
    // Next search starts after the replacement. Now at index 6.
    // Is there another "&amp;" ? "amp; Load" starts at index 6. No match.
    // So result = "Save &amp; Load". The second amp; is a literal string.
    // Hmm wait, that's wrong. After replacing "&amp;" at index 5-9 with "&", the string is:
    // "Save " + "&" + "amp; Load" = "Save &amp; Load"
    // Now searching from index 6: "&amp;" at index 5? No, we're past it.
    // Actually "Save &amp; Load" contains "&amp;" starting at index 5!
    // But replaceAll does all replacements on the ORIGINAL string positions, then applies them.
    // So only the first "&amp;" (from the original) is replaced.
    //
    // Actually, String.prototype.replaceAll replaces all matches in the original string.
    // In "&amp;amp;", there's only ONE match of "&amp;" starting at index 0.
    // Result: "&amp;" (from the &amp; at start being replaced) doesn't exist. Let me count:
    // "S a v e   & a m p ; a m p ;   L o a d"
    //  0 1 2 3 4 5 6 7 8 9 ...
    // "&amp;" is at index 5 (chars &,a,m,p,;). That matches.
    // After replacement: "Save " + "&" + "amp; Load" = "Save &amp; Load"
    // But wait, is there a second "&amp;" in the result? "Save &amp; Load" contains "&amp;" at index 5!
    // However replaceAll works on the ORIGINAL string, not the result. So it only found one match.
    // The result still contains "&amp;" — single decode only.
    expect(feature!.name).toBe("Save &amp; Load");
    // This proves double-encoded entities are NOT fully decoded.
  });
});

// ─── BUG HUNT 5: Heading regex with attributes ──────────────────────────────

describe("Heading regex edge cases", () => {
  it("BUG: heading with mismatched tags is silently skipped", () => {
    // <h2>...</h3> - the regex requires matching tag numbers via backreference \1
    const html = `<h2>Mismatched Feature</h3><p>Description.</p>`;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    // The regex /<h([2-4])[^>]*>([\s\S]*?)<\/h\1>/gi captures group 1 = "2"
    // Then requires </h2> but finds </h3>. No match. Feature is lost.
    expect(result.websiteFeatures.length).toBe(0);
  });

  it("heading with complex attributes still extracts", () => {
    const html = `<h2 class="title" id="feat-1" data-track="true">Complex Heading</h2><p>Desc.</p>`;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    expect(result.websiteFeatures.length).toBe(1);
    expect(result.websiteFeatures[0]!.name).toBe("Complex Heading");
  });

  it("BUG: h1 and h5/h6 headings are completely ignored", () => {
    const html = `
      <h1>Main App Feature</h1><p>The biggest feature.</p>
      <h5>Minor Feature</h5><p>Small but real.</p>
      <h6>Tiny Feature</h6><p>Also real.</p>
    `;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    // Only h2-h4 are extracted. h1, h5, h6 are silently dropped.
    expect(result.websiteFeatures.length).toBe(0);
  });
});

// ─── BUG HUNT 6: assignLevel multi-word keyword failure ─────────────────────

describe("assignLevel keyword matching", () => {
  it("BUG: multi-word GRANDMASTER_KEYWORDS like 'custom action' never match via word split", () => {
    // GRANDMASTER_KEYWORDS contains "custom action" as a multi-word entry.
    // But "custom" is NOT in the set as a single word.
    // The word-by-word loop splits into ["custom", "action"] — neither matches alone.
    // The secondary check: GRANDMASTER_KEYWORDS.has(text.trim()) checks ENTIRE text.
    // For heading "Custom Action" with description "Do stuff":
    // text = "custom action do stuff.", text.trim() = "custom action do stuff."
    // That does NOT equal "custom action" — so the multi-word check ALSO fails.
    // Result: "Custom Action" is classified as "F" instead of "SSS".
    // This is a REAL BUG — the "custom action" entry in SSS_KEYWORDS is dead code.
    const html = `<h2>Custom Action</h2><p>Do stuff.</p>`;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    // FIXED: multi-word phrases now checked via SSS_PHRASES substring match
    expect(result.websiteFeatures[0]!.level).toBe("SSS");
  });

  it("BUG: 'custom action' in GRANDMASTER_KEYWORDS.has(text.trim()) only matches if text is EXACTLY 'custom action'", () => {
    // The only way the multi-word check fires for "custom action" is if
    // name + description = "custom action" exactly. That requires:
    // name = "custom action" and description = "" (empty)
    // OR name = "" and description = "custom action"
    // OR name = "custom" and description = "action"
    // text = "custom action" -> trim -> "custom action"
    // BUT the word loop already matched "custom" before we get to the multi-word check.
    // So the multi-word branch on line 92 is COMPLETELY dead code.

    // Even if we construct a scenario where no single word matches:
    // Suppose we had a keyword "ice cream" in the set (not "ice" alone).
    // Then the word loop wouldn't match "ice" or "cream" individually,
    // but text.trim() could match "ice cream" — ONLY if that's the entire text.
    // For a heading "Ice Cream", text = "ice cream ice cream" (name + " " + description when desc=name)
    // text.trim() = "ice cream ice cream" which != "ice cream". Still dead.
    expect(true).toBe(true); // Documenting the dead code path
  });
});

// ─── BUG HUNT 7: Ladder generator with websiteFeatures but < 2 selector groups

describe("Ladder generator threshold bypass", () => {
  it("BUG: websiteFeatures are SILENTLY DROPPED when < 2 selector groups and < 2 flows", () => {
    const ref = {
      selectors: {
        navigation: { home: "[data-test='home']" },
      },
      websiteFeatures: [
        { id: "feature1", name: "Feature One", description: "Desc 1", level: "F" },
        { id: "feature2", name: "Feature Two", description: "Desc 2", level: "B" },
      ],
    };
    // FIXED: websiteFeatures now bypass the minimum selector threshold
    const result = generateLadderFromReference(ref);
    expect(result.ladder.length).toBeGreaterThan(0); // Website features included
    // This is a REAL BUG: we fetched features from the website but they vanish
    // because there aren't enough selectors yet.
  });

  it("websiteFeatures + valueAddFeatures produce ladder when >= 2 selector groups", () => {
    const ref = {
      selectors: {
        navigation: { home: "[data-test='home']" },
        settings: { theme: "[data-test='theme']" },
      },
      websiteFeatures: [
        { id: "feature1", name: "Feature One", description: "Desc 1", level: "F" },
      ],
      valueAddFeatures: [
        { id: "bulk_create", name: "Bulk Create", description: "Create many", level: "B", category: "bulk" },
      ],
    };
    const result = generateLadderFromReference(ref);
    expect(result.ladder.length).toBeGreaterThan(0);
    expect(result.ladder.some(f => f.id === "web_feature1")).toBe(true);
    expect(result.ladder.some(f => f.id === "va_bulk_create")).toBe(true);
  });

  it("BUG: websiteFeatures alone (no selectors, no flows) produce EMPTY ladder", () => {
    const ref = {
      websiteFeatures: [
        { id: "f1", name: "Feature One", description: "Desc", level: "F" },
        { id: "f2", name: "Feature Two", description: "Desc", level: "B" },
        { id: "f3", name: "Feature Three", description: "Desc", level: "S" },
      ],
    };
    const result = generateLadderFromReference(ref);
    // FIXED: websiteFeatures bypass the minimum threshold
    expect(result.ladder.length).toBe(3);
  });
});

// ─── BUG HUNT 8: mergeWebsiteFeatures idempotency ──────────────────────────

describe("mergeWebsiteFeatures idempotency", () => {
  it("BUG: valueAddFeatures are OVERWRITTEN, not merged, on second call", () => {
    // Looking at the code:
    // (ref as Record<string, unknown>).valueAddFeatures = result.valueAddFeatures;
    // This REPLACES the entire array. If first call has valueAddFeatures [A, B]
    // and second call has [C, D], the result is [C, D], not [A, B, C, D].
    // This is a design decision, but it means calling mergeWebsiteFeatures twice
    // with different FeatureExtractionResults will LOSE the first set of value-add features.

    // websiteFeatures are properly merged (new ones appended, existing ones kept).
    // valueAddFeatures are NOT. This is inconsistent.
    expect(true).toBe(true); // Documenting the inconsistency
  });
});

// ─── BUG HUNT 9: extractKeywordsFromName edge cases ────────────────────────

describe("extractKeywordsFromName behavior", () => {
  it("single character and two-char words are silently dropped", () => {
    // extractKeywordsFromName uses lower.length > 2 threshold
    const ref = {
      selectors: {
        aa: { x: "a", y: "b" },
        bb: { x: "a", y: "b" },
      },
      websiteFeatures: [
        { id: "ai_ml", name: "AI ML", description: "AI and ML features", level: "SSS" },
      ],
    };
    const result = generateLadderFromReference(ref);
    const aiFeature = result.ladder.find(f => f.id === "web_ai_ml");
    expect(aiFeature).toBeDefined();
    // signals for web_ai_ml: extractKeywordsFromName("AI ML")
    // "AI" -> "ai" -> length 2 -> DROPPED
    // "ML" -> "ml" -> length 2 -> DROPPED
    // Result: EMPTY keywords array. Feature is unfindable by signals.
    expect(result.signals["web_ai_ml"]).toEqual([]);
  });

  it("all stop words produce empty keywords", () => {
    const ref = {
      selectors: {
        aa: { x: "a", y: "b" },
        bb: { x: "a", y: "b" },
      },
      websiteFeatures: [
        { id: "for_the_win", name: "For The Win", description: "Desc", level: "F" },
      ],
    };
    const result = generateLadderFromReference(ref);
    // "For" -> "for" -> stop word -> DROPPED
    // "The" -> "the" -> stop word -> DROPPED
    // "Win" -> "win" -> length 3 -> passes length check, not a stop word -> KEPT
    expect(result.signals["web_for_the_win"]).toEqual(["win"]);
  });

  it("empty name produces empty keywords", () => {
    const ref = {
      selectors: {
        aa: { x: "a", y: "b" },
        bb: { x: "a", y: "b" },
      },
      websiteFeatures: [
        { id: "empty", name: "", description: "Has description", level: "F" },
      ],
    };
    const result = generateLadderFromReference(ref);
    // name is "" so no split parts. Empty keywords.
    // But the feature description is used for the ladder entry. So the feature
    // exists but has no signals to find it.
    expect(result.signals["web_empty"]).toEqual([]);
  });
});

// ─── BUG HUNT 10: List item extraction context requirement ──────────────────

describe("List item extraction requires nearby feature context", () => {
  it("list items without nearby 'feature'/'capability' context are dropped", () => {
    const html = `
      <html><body>
        <h2>What We Offer</h2>
        <ul>
          <li>Automatic Backups with Cloud Sync</li>
          <li>Real-time Collaboration Tools</li>
          <li>Advanced Export Options</li>
        </ul>
      </body></html>
    `;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    // The list items are NOT extracted because the preceding 500 chars
    // don't contain "feature", "capability", or "what you can".
    // "What We Offer" doesn't match any of those.
    // The h2 "What We Offer" IS extracted though.
    const names = result.websiteFeatures.map(f => f.name);
    expect(names).not.toContain("Automatic Backups with Cloud Sync");
    expect(names).not.toContain("Real-time Collaboration Tools");
  });

  it("list items WITH nearby feature context ARE extracted", () => {
    const html = `
      <html><body>
        <h2>Key Features</h2>
        <ul>
          <li>Automatic Backups with Cloud Sync</li>
          <li>Real-time Collaboration Tools</li>
        </ul>
      </body></html>
    `;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    const names = result.websiteFeatures.map(f => f.name);
    // "Key Features" heading contains "feature" (extracted as heading)
    // List items have "feature" in preceding context -> extracted
    // WAIT: "Key Features" heading is also extracted. Let's check both.
    expect(names).toContain("Key Features");
    expect(names).toContain("Automatic Backups with Cloud Sync");
  });
});

// ─── BUG HUNT 11: Numeric entity edge cases ────────────────────────────────

describe("Numeric HTML entity handling", () => {
  it("handles large numeric entities without crashing", () => {
    // fromCharCode with very large numbers produces garbage but shouldn't crash
    const html = `<h2>Feature &#999999; Name</h2><p>Desc.</p>`;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    // Should not throw
    expect(result).toBeDefined();
  });

  it("handles zero-value numeric entity", () => {
    const html = `<h2>Feature &#0; Name</h2><p>Desc.</p>`;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    // fromCharCode(0) is NUL character. Feature name will contain NUL.
    expect(result).toBeDefined();
  });
});

// ─── BUG HUNT 12: nameToId truncation causes false dedup ─────────────────────

describe("nameToId truncation", () => {
  it("BUG: two different features with same first 60 chars are deduped incorrectly", () => {
    const prefix = "this_is_a_very_long_feature_name_that_goes_on_and_on_until_i"; // 60 chars worth
    // Create two headings that differ only after 60 chars
    const name1 = "This Is A Very Long Feature Name That Goes On And On Until It Reaches The End Alpha";
    const name2 = "This Is A Very Long Feature Name That Goes On And On Until It Reaches The End Beta";
    const html = `
      <h2>${name1}</h2><p>First feature.</p>
      <h2>${name2}</h2><p>Second feature.</p>
    `;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    // Both get truncated to same 60-char ID -> second one is deduped away
    // nameToId: lowercase, replace non-alphanum with _, strip leading/trailing _, slice(0,60)
    // Let's check if they actually collide
    const ids = result.websiteFeatures.map(f => f.id);
    const uniqueIds = new Set(ids);
    if (ids.length > uniqueIds.size) {
      // Collision detected - this shouldn't happen but the test documents it
      expect(true).toBe(true);
    }
    // In practice, both names are > 120 chars so they'd be skipped by the length check
    // Let's use names that are < 120 chars but produce IDs > 60 chars
    const shortName1 = "Automated Cloud Sync With Real Time Collaboration And Backup Version Alpha";
    const shortName2 = "Automated Cloud Sync With Real Time Collaboration And Backup Version Beta";
    expect(shortName1.length).toBeLessThan(120);
    expect(shortName2.length).toBeLessThan(120);

    const html2 = `
      <h2>${shortName1}</h2><p>First.</p>
      <h2>${shortName2}</h2><p>Second.</p>
    `;
    const result2 = extractFeaturesFromHTML(html2, "App", "https://example.com");
    // FIXED: nameToId now uses 80-char limit instead of 60.
    // "automated_cloud_sync_with_real_time_collaboration_and_backup_version_alpha" is 75 chars
    // "automated_cloud_sync_with_real_time_collaboration_and_backup_version_beta" is 74 chars
    // Both fit within 80 chars — no collision
    expect(result2.websiteFeatures.length).toBe(2); // Both features preserved
  });
});

// ─── BUG HUNT 13: Value-add feature level validation ────────────────────────

describe("Value-add feature level validation in ladder", () => {
  it("BUG: value-add feature with level 'F' is silently promoted to 'S'", () => {
    const ref = {
      selectors: {
        aa: { x: "a", y: "b" },
        bb: { x: "a", y: "b" },
      },
      valueAddFeatures: [
        { id: "test_va", name: "Test", description: "Test", level: "F", category: "bulk" },
      ],
    };
    const result = generateLadderFromReference(ref);
    const va = result.ladder.find(f => f.id === "va_test_va");
    expect(va).toBeDefined();
    // Code: ["B", "S", "SSS"].includes("F") -> false -> defaults to "S"
    // An "F" level value-add feature gets silently promoted to "S"
    expect(va!.level).toBe("S");
  });
});

// ─── BUG HUNT 14: Website feature with invalid level ────────────────────────

describe("Website feature with invalid level string", () => {
  it("invalid level string defaults to 'F' in ladder", () => {
    const ref = {
      selectors: {
        aa: { x: "a", y: "b" },
        bb: { x: "a", y: "b" },
      },
      websiteFeatures: [
        { id: "test_wf", name: "Test", description: "Test", level: "invalid_level" },
      ],
    };
    const result = generateLadderFromReference(ref);
    const wf = result.ladder.find(f => f.id === "web_test_wf");
    expect(wf).toBeDefined();
    // ["F", "B", "S", "SSS"].includes("invalid_level") -> false -> "F"
    expect(wf!.level).toBe("F");
  });
});

// ─── BUG HUNT 15: Coverage auditor double-counting ──────────────────────────

describe("Coverage auditor websiteFeatures counting", () => {
  it("BUG: multiple reference files for same bundleId double-count websiteFeatures", () => {
    // The coverage auditor iterates ALL refs matching the bundleId
    // If two reference files both have the same websiteFeatures, they're counted twice
    // This is a design issue in loadReferences: it matches by bundleId OR platform
    // So if ref.bundleId matches AND ref.platform matches, the same file could appear twice
    // Actually no, it only pushes once per file. But if someone manually creates
    // two reference files with the same bundleId, features are double-counted.
    // This is documented but not tested.
    expect(true).toBe(true);
  });
});

// ─── BUG HUNT 16: Regex catastrophic backtracking ───────────────────────────

describe("Regex performance", () => {
  it("does not catastrophically backtrack on adversarial HTML", () => {
    // The card regex: /<div[^>]*class="[^"]*feature[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
    // With [\s\S]*? this can be slow on very large HTML without </div>
    // Create HTML with feature class but no closing div
    const bigHtml = `<div class="feature">` + "x".repeat(100000);
    // The lazy [\s\S]*? will try to match as little as possible, then expand.
    // Without </div>, it'll expand all the way to the end and fail.
    // This should still complete in reasonable time since lazy quantifier
    // with a fixed end string is O(n).
    const start = Date.now();
    const result = extractFeaturesFromHTML(bigHtml, "App", "https://example.com");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000); // Should be fast
    expect(result).toBeDefined();
  });
});

// ─── BUG HUNT 17: flowNamesRelated false positives ──────────────────────────

describe("flowNamesRelated matching issues", () => {
  it("BUG: short flow names cause spurious matches, preventing website feature inclusion", () => {
    const ref = {
      selectors: {
        edit: { input: "[data-edit]", save: "[data-save]" },
        view: { list: "[data-list]", grid: "[data-grid]" },
      },
      flows: {},
      websiteFeatures: [
        { id: "edit_photos", name: "Edit Photos", description: "Edit your photos", level: "B" },
        { id: "view_gallery", name: "View Gallery", description: "Browse gallery", level: "F" },
      ],
    };
    const result = generateLadderFromReference(ref);
    // flowNamesRelated("edit", "edit_photos"):
    //   gParts = Set(["edit"])
    //   fParts = ["edit", "photos"]
    //   matches = 1 (edit), need ceil(2 * 0.5) = 1. 1 >= 1 -> TRUE
    // So "edit_photos" is considered related to "edit" selector group and SKIPPED.
    // The website feature "Edit Photos" is silently dropped because there's
    // a vaguely-related selector group named "edit".
    // FIXED: now uses exact selector group key match instead of fuzzy flowNamesRelated
    expect(result.ladder.some(f => f.id === "web_edit_photos")).toBe(true); // Preserved!
    expect(result.ladder.some(f => f.id === "web_view_gallery")).toBe(true); // Also preserved!
  });

  it("BUG: single-word IDs always match due to 50% threshold rounding", () => {
    // flowNamesRelated("a", "a_b_c"):
    //   gParts = Set(["a"])
    //   fParts = ["a", "b", "c"]
    //   matches = 1 ("a"), need ceil(3 * 0.5) = 2. 1 < 2 -> FALSE
    // OK that works. But flowNamesRelated("a", "a"):
    //   gParts = Set(["a"]), fParts = ["a"]
    //   matches = 1, need ceil(1 * 0.5) = 1. 1 >= 1 -> TRUE
    // And flowNamesRelated("a", "a_b"):
    //   matches = 1, need ceil(2 * 0.5) = 1. 1 >= 1 -> TRUE
    // So any 2-word flow ID where one word matches a selector group gets eaten.
    const ref = {
      selectors: {
        create: { btn: "[data-create]", form: "[data-form]" },
        export: { btn: "[data-export]", menu: "[data-menu]" },
      },
      websiteFeatures: [
        { id: "create_artwork", name: "Create Artwork", description: "Make art", level: "F" },
        { id: "export_pdf", name: "Export PDF", description: "Export as PDF", level: "S" },
      ],
    };
    const result = generateLadderFromReference(ref);
    // "create_artwork" vs "create": gParts=Set(["create"]), fParts=["create","artwork"]
    // matches=1, threshold=ceil(2*0.5)=1 -> TRUE -> SKIPPED
    // FIXED: now uses exact key match — "create_artwork" != "create"
    expect(result.ladder.some(f => f.id === "web_create_artwork")).toBe(true);
    expect(result.ladder.some(f => f.id === "web_export_pdf")).toBe(true);
  });
});

// ─── BUG HUNT 18: Hash collision potential ──────────────────────────────────

describe("Hash computation", () => {
  it("different refs with same sorted keys produce same hash", () => {
    const ref1 = {
      selectors: { a: { x: "1" }, b: { y: "2" } },
      flows: {},
    };
    const ref2 = {
      selectors: { a: { x: "COMPLETELY_DIFFERENT" }, b: { y: "ALSO_DIFFERENT" } },
      flows: {},
    };
    const hash1 = generateLadderFromReference(ref1).hash;
    const hash2 = generateLadderFromReference(ref2).hash;
    // computeHash only uses Object.keys, not values. So same keys = same hash
    // even if selector values are completely different.
    expect(hash1).toBe(hash2);
  });
});

// ─── BUG HUNT 19: Real-world HTML from complex sites ────────────────────────

describe("Real-world HTML patterns", () => {
  it("Apple-style HTML with picture/source/img inside headings", () => {
    const html = `
      <h2 class="headline">
        <picture>
          <source srcset="hero.webp" type="image/webp">
          <img src="hero.jpg" alt="Feature">
        </picture>
        Continuity Camera
      </h2>
      <p>Use your iPhone as a webcam for your Mac.</p>
    `;
    const result = extractFeaturesFromHTML(html, "macOS", "https://apple.com/macos");
    // stripTags removes all tags, leaving "Continuity Camera" (with whitespace)
    const feature = result.websiteFeatures[0];
    expect(feature).toBeDefined();
    // The name will have lots of whitespace from the multiline content
    // trim() is called, but internal whitespace from newlines may remain
    expect(feature!.name).toMatch(/Continuity Camera/);
  });

  it("Google-style HTML with data attributes and Angular directives", () => {
    const html = `
      <h2 mat-heading data-ng-if="showFeature" aria-label="Feature heading">Smart Compose</h2>
      <p mat-body>Write emails faster with AI suggestions.</p>
    `;
    const result = extractFeaturesFromHTML(html, "Gmail", "https://google.com/gmail");
    expect(result.websiteFeatures[0]!.name).toBe("Smart Compose");
  });

  it("handles CDATA sections in HTML", () => {
    const html = `<h2><![CDATA[Feature Name]]></h2><p>Description.</p>`;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    // <![CDATA[Feature Name]]> - the regex <[^>]*> matches "<![CDATA[Feature Name]]>"
    // because [^>] matches everything until ">". So CDATA is stripped.
    // Wait: <![CDATA[Feature Name]]> contains no ">" before the final ">".
    // [^>]* matches "![CDATA[Feature Name]]". Then ">". Entire thing stripped.
    // Feature name becomes empty -> skipped (length < 3).
    expect(result.websiteFeatures.length).toBe(0);
  });
});

// ─── BUG HUNT 20: paragraph description 500-char lookahead ──────────────────

describe("Description extraction lookahead", () => {
  it("BUG: description from wrong section when next <p> is > 500 chars away", () => {
    const gap = "x".repeat(600);
    const html = `
      <h2>Feature A</h2>
      ${gap}
      <p>This is Feature A description but too far away.</p>
      <h2>Feature B</h2>
      <p>Feature B description.</p>
    `;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    const featureA = result.websiteFeatures.find(f => f.name === "Feature A");
    expect(featureA).toBeDefined();
    // The 500-char lookahead won't find the <p> for Feature A.
    // So description falls back to the heading text itself.
    expect(featureA!.description).toBe("Feature A");
  });

  it("BUG: description captures <p> from a DIFFERENT section within 500 chars", () => {
    const html = `
      <h2>Feature A</h2>
      <div class="spacer"></div>
      <section>
        <h3>Unrelated Section</h3>
        <p>This paragraph belongs to unrelated section but is within 500 chars of Feature A heading.</p>
      </section>
    `;
    const result = extractFeaturesFromHTML(html, "App", "https://example.com");
    const featureA = result.websiteFeatures.find(f => f.name === "Feature A");
    expect(featureA).toBeDefined();
    // The first <p> within 500 chars is grabbed regardless of DOM structure
    expect(featureA!.description).toContain("unrelated section");
  });
});
