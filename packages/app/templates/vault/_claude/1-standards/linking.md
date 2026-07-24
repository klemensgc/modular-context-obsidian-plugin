---
title: Linking Standard — Wiki-Links
updated: 2026-06-12
status: stable
cadence: frozen
depends-on: "[[frontmatter]]"
---

# Linking Standard — Wiki-Links

Wiki-links make the dependency graph of the vault visible. Every meaningful relation between two files should be a `[[link]]` — that is what lets agents trace what breaks when something changes.

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

```yaml
sources: "[[_transcripts/meetings/weekly-sync-2026-06-10]]"
```

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
- [ ] Does `depends-on:` use wiki-links?
- [ ] No topic mentioned without a `[[link]]` when its file exists?

---

## Related

- [[frontmatter]] — frontmatter standard
