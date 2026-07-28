# MEMORY INDEX

<!-- One line per durable fact, pointing at where the detail lives. This file is
     an index, not a store — if an entry needs a paragraph, it belongs in its own
     file next to this one, with a single line here pointing at it.

     Keep it short on purpose. An index nobody can scan is an index nobody
     reads, and some tools load only the first part of it.

     Format: `- [Title](file.md) — the hook that tells you when to open it`

     One fact per file. Give each file frontmatter naming what it is:

     ---
     name: <short-kebab-case-slug>
     description: <one line — this is what gets scanned to decide relevance>
     type: user | project | reference | feedback
     ---

     - user      — who this person is: role, expertise, how they like to work.
     - project   — goals and constraints not derivable from code or history.
     - reference — pointers outward: URLs, dashboards, ticket numbers.
     - feedback  — guidance on how to work, with the reason it was given.

     Before adding anything, check whether a file already covers it and update
     that one instead. Delete entries that turn out to be wrong. Do not record
     what the repository already tells you — code structure, git history, and
     existing docs are not memories, and duplicating them makes the index harder
     to scan.

     Convert relative dates to absolute ones. "Last Tuesday" means nothing to
     the session that reads this a month from now.

     If your tool keeps its own automatic memory, that is a separate store in a
     separate directory. This file is the one you and the agent curate by hand.
-->

## Index
