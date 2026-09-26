# Product help for the assistant

Each `.md` file here (other than this one) is indexed into Qdrant at startup and
searched by the assistant's `search_help` tool.

- Front-matter `permission:` is the permission the page is about. A person only
  ever gets help about features they hold that permission for. Omit it for help
  that applies to everyone.
- Each `## ` heading becomes one searchable chunk, so keep one task per heading.
- Describe what is on screen, using the product's own button labels. Unchanged
  chunks are not re-embedded, so edits are cheap.
