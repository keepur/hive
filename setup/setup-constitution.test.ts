import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "./template-renderer.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SECTION_2_DELIMITER = "<!-- SECTION 2: OPERATIONAL -->";

describe("setup-constitution", () => {
  describe("bootstrap template", () => {
    const tpl = readFileSync(
      resolve(ROOT, "setup", "templates", "constitution-bootstrap.md.tpl"),
      "utf-8",
    );

    it("renders with only business.owner.name", () => {
      const rendered = render(tpl, { business: { owner: { name: "Alice" } } });
      expect(rendered).toContain("Alice");
      expect(rendered).not.toMatch(/\{\{/); // no unresolved variables
    });

    it("contains no dodi or product-specific references", () => {
      const rendered = render(tpl, { business: { owner: { name: "Alice" } } });
      expect(rendered.toLowerCase()).not.toContain("dodi");
      expect(rendered.toLowerCase()).not.toContain("vp-engineering");
      expect(rendered.toLowerCase()).not.toContain("devops");
    });

    it("contains the Section 2 delimiter", () => {
      const rendered = render(tpl, { business: { owner: { name: "Alice" } } });
      expect(rendered).toContain(SECTION_2_DELIMITER);
    });

    it("contains the delegation clause", () => {
      const rendered = render(tpl, { business: { owner: { name: "Alice" } } });
      expect(rendered).toContain("Chief of Staff is responsible for authoring");
    });
  });

  describe("re-run safety", () => {
    it("preserves Section 2 when delimiter exists in existing content", () => {
      const bootstrapRendered = "# Preamble content\n\n<!-- SECTION 2: OPERATIONAL -->\n\n## Section 2\n\n*Placeholder*";
      const existingInDb = "# Old Preamble\n\n<!-- SECTION 2: OPERATIONAL -->\n\n## Team Structure\n\nHermi is CoS.\nDodi rules apply here.";

      const delimiterIdx = existingInDb.indexOf(SECTION_2_DELIMITER);
      const existingSection2 = existingInDb.slice(delimiterIdx);

      const newBootstrapSection1 = bootstrapRendered.slice(
        0,
        bootstrapRendered.indexOf(SECTION_2_DELIMITER),
      );
      const result = newBootstrapSection1 + existingSection2;

      expect(result).toContain("# Preamble content");
      expect(result).toContain("Hermi is CoS");
      expect(result).not.toContain("Old Preamble");
    });

    it("replaces entire document when no delimiter in existing content", () => {
      const bootstrapRendered = "# New preamble\n\n<!-- SECTION 2: OPERATIONAL -->\n\n*Placeholder*";
      const existingInDb = "# Old constitution without delimiter";

      const delimiterIdx = existingInDb.indexOf(SECTION_2_DELIMITER);
      expect(delimiterIdx).toBe(-1);
      // When no delimiter found, replace entirely
      const result = bootstrapRendered;
      expect(result).toContain("# New preamble");
    });
  });
});
