---
title: Linking Standard — Wiki-Links
status: stable
updated: 2026-06-12
---

# Linking Standard — Wiki-Links

Wiki-links make the graph of the vault visible. Every meaningful relation between two files should be a `[[link]]` — that is what lets agents trace what breaks when something changes.

There are exactly two kinds of edge: **body links** (`[[name]]` in prose) and **entity edges** in frontmatter (`owner:`, `osoby:`, `uczestnicy:`, `dotyczy:`). Both use wiki-link syntax. Nothing else creates a relation — see [[frontmatter]].

---

## Format

```markdown
[[file-name]]              # simple link
[[folder/file-name]]       # with path
[[file-name|Alias]]        # with alias
[[folder/file|Alias]]      # path + alias
```

---

## When to use full paths

**In index files:** always paths relative to the project folder

```markdown
# Good (inside 1_project/1_project_index.md)
- [[2-architecture/backend]]
- [[4-go-to-market/playbook]]
```

**Inside folders:** relative links are fine

```markdown
# Inside 1_project/2-architecture/backend.md
- [[frontend]]              # OK — same folder
- [[../1-product/vision]]   # OK — sibling folder
```

**Across projects:** always full paths from the vault root

```markdown
[[2_project/2_project_index]]
[[1_project/1-product/vision]]
```

---

## Links to transcripts

A transcript summary declares what it was built from — and it is the only file that may carry `sources:`:

```yaml
# inside _transcripts/meetings/weekly-sync-2026-06-10-summary.md
sources: "[[_transcripts/meetings/weekly-sync-2026-06-10]]"
```

Modules do not list their sources. The link runs summary → module, not back.

## Entity edges

```yaml
owner: "[[osoby/alex-doe]]"
uczestnicy: "[[osoby/alex-doe]], [[osoby/sam-roe]]"
dotyczy: "[[1_project/1-product/roadmap]]"
uczestnicy-nierozpoznani: Dana Ruiz (dana@atlas.example)
```

Person edges point at the people folder and nowhere else — never at a project module that mentions someone.

A person with no card gets **no edge**. Their name goes into `uczestnicy-nierozpoznani:` as plain text and stays there until a card exists; writing `uczestnicy: "[[osoby/dana-ruiz]]"` before `osoby/dana-ruiz.md` exists creates exactly the dangling link this document forbids. Creating the card is the fix and it is usually the right one for anyone who recurs — but it is a deliberate act, not something you do implicitly while filing a transcript.

## External links (URLs)

Standard markdown:

```markdown
[Link text](https://example.com)
```

---

## Moving files — preserve links!

1. Move with `git mv old/path new/path`
2. Find all links to the old name: `grep -r "\[\[old-name" --include="*.md"`
3. Update the links
4. Update the relevant index files

## Broken links check

```bash
# List all wiki-links
grep -roh "\[\[[^]]*\]\]" --include="*.md" . | sort | uniq

# Verify a target exists
ls path/to/file.md
```

---

## Checklist

- [ ] Do index files link every module in their folder?
- [ ] Are cross-project links full paths?
- [ ] Do entity edges use wiki-links into the people folder?
- [ ] No topic mentioned without a `[[link]]` when its file exists?

---

## Related

- [[frontmatter]] — frontmatter standard
