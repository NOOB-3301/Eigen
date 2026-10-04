// Run with: node --test src/components/editors/*.test.ts   (from app/; Node 22.18+ strips the types)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_SKILL_TEXT, hasBlankBody, starterBody, validateSkillDraft, withStarterBody } from "./skill-rules.ts";

const skill = (fm: string, body = "Do the thing.\n") => `---\n${fm}\n---\n${body}`;
const GOOD = "description: Turns a pile of meeting notes into a decision log. Use after any meeting.";

describe("validateSkillDraft", () => {
  it("accepts a well-formed skill", () => {
    assert.deepEqual(validateSkillDraft("meeting-notes", skill(`name: meeting-notes\n${GOOD}`)), { errors: [], warnings: [] });
  });

  it("needs frontmatter", () => {
    const r = validateSkillDraft("pdf", "# Just a body\n");
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!, /frontmatter/);
    assert.equal(validateSkillDraft("pdf", "---\n---\nbody").errors.length, 1);
  });

  it("requires name to equal the folder", () => {
    assert.match(validateSkillDraft("pdf", skill(`name: pdfs\n${GOOD}`)).errors[0]!, /"pdfs" must match the folder name "pdf"/);
    assert.match(validateSkillDraft("pdf", skill(GOOD)).errors[0]!, /name: missing/);
    assert.deepEqual(validateSkillDraft("pdf", skill(`name: "pdf"\n${GOOD}`)).errors, []);
    assert.deepEqual(validateSkillDraft("pdf", skill(`name: 'pdf'  # the folder\n${GOOD}`)).errors, []);
  });

  it("compares against the last path segment for an owner/slug folder", () => {
    assert.deepEqual(validateSkillDraft("@acme/pdf", skill(`name: pdf\n${GOOD}`)).errors, []);
  });

  it("does not mistake a nested key for the top-level one", () => {
    const text = skill(`metadata:\n  name: other\nname: pdf\n${GOOD}`);
    assert.deepEqual(validateSkillDraft("pdf", text).errors, []);
  });

  it("requires a description and caps its length", () => {
    assert.match(validateSkillDraft("pdf", skill("name: pdf")).errors[0]!, /description: missing/);
    assert.match(validateSkillDraft("pdf", skill("name: pdf\ndescription:")).errors[0]!, /description: missing/);
    assert.match(validateSkillDraft("pdf", skill("name: pdf\ndescription:   ")).errors[0]!, /description: missing/);
    assert.match(validateSkillDraft("pdf", skill(`name: pdf\ndescription: ${"x".repeat(1025)}`)).errors[0]!, /description: 1025 characters; at most 1024/);
    assert.deepEqual(validateSkillDraft("pdf", skill(`name: pdf\ndescription: ${"x".repeat(1024)}`)).errors, []);
  });

  it("reads folded, literal and quoted descriptions", () => {
    const long = "Extracts text from PDFs and fills in forms when the user attaches one";
    assert.deepEqual(validateSkillDraft("pdf", skill(`name: pdf\ndescription: >\n  Extracts text from PDFs and fills\n  in forms when the user attaches one\n`)), { errors: [], warnings: [] });
    assert.deepEqual(validateSkillDraft("pdf", skill(`name: pdf\ndescription: |-\n  ${long}\n`)), { errors: [], warnings: [] });
    assert.deepEqual(validateSkillDraft("pdf", skill(`name: pdf\ndescription: "${long}: yes"`)), { errors: [], warnings: [] });
    assert.deepEqual(validateSkillDraft("pdf", skill(`name: pdf\ndescription: ${long}\n  and then some more words`)), { errors: [], warnings: [] });
    assert.deepEqual(validateSkillDraft("pdf", skill("name: pdf\ndescription: >\n\nlicense: MIT")).errors.length, 1);
  });

  it("warns, without blocking, about a short description and an empty body", () => {
    const r = validateSkillDraft("pdf", skill("name: pdf\ndescription: PDFs", ""));
    assert.deepEqual(r.errors, []);
    assert.equal(r.warnings.length, 2);
    assert.match(r.warnings[0]!, /very short/);
    assert.match(r.warnings[1]!, /body is empty/);
  });

  it("caps the file size", () => {
    const r = validateSkillDraft("pdf", skill(`name: pdf\n${GOOD}`, "x".repeat(MAX_SKILL_TEXT)));
    assert.match(r.errors[0]!, /over 100,000 characters/);
  });

  it("handles CRLF files", () => {
    assert.deepEqual(validateSkillDraft("pdf", `---\r\nname: pdf\r\n${GOOD}\r\n---\r\nBody\r\n`), { errors: [], warnings: [] });
  });
});

describe("starter body", () => {
  it("is only offered when the body is blank", () => {
    assert.ok(hasBlankBody(skill("name: pdf", "")));
    assert.ok(hasBlankBody(skill("name: pdf", "\n  \n")));
    assert.ok(!hasBlankBody(skill("name: pdf", "x")));
    assert.ok(!hasBlankBody("no frontmatter"));
  });

  it("is appended after the frontmatter and leaves it alone", () => {
    const text = skill(`name: pdf\n${GOOD}`, "");
    const out = withStarterBody("pdf", text);
    assert.ok(out.startsWith(text.trimEnd()));
    assert.ok(out.endsWith(starterBody("pdf")));
    assert.match(out, /# Pdf\n/);
    assert.deepEqual(validateSkillDraft("pdf", out).errors, []);
    assert.ok(!hasBlankBody(out));
  });

  it("copes with a missing newline after the closing dashes, and with an owner folder", () => {
    const out = withStarterBody("@acme/pdf-tools", `---\nname: pdf-tools\n${GOOD}\n---`);
    assert.match(out, /---\n\n# Pdf tools\n/);
  });

  it("returns text without frontmatter untouched", () => {
    assert.equal(withStarterBody("pdf", "hello"), "hello");
  });
});
