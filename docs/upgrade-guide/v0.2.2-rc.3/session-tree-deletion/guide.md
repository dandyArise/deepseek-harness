---
kind: upgrade-guide
description: Session deletion now includes dependent conversations, and workspace deletion in the client includes its conversation history.
---

# Conversation deletion scope

English | [中文](guide.zh.md)

## Change

Deleting a session previously failed when its stored history had dependent sessions. The confirmed client action and `WorkspaceRegistry.deleteSession` now delete its descendant conversations before deleting the parent, including subagent conversations and derived branches. Active conversations prevent deletion before any history is removed. Project files remain on disk.

The client workspace delete action now requests `deleteSessions: true`. Direct workspace delete requests that omit this option still remove only the registration. A workspace with dependencies outside its group is refused.

## Migration

1. Update integrations that call `deleteSession` to ask for confirmation covering the parent and all descendant histories. Do not use it to remove only a parent while retaining its children.
2. For workspace API calls, omit `deleteSessions` to retain conversation history, or set it to `true` only after confirming permanent removal.
3. Verify on a temporary conversation family that deletion removes the parent and descendants from the list after restarting. Keep project files outside session storage; deletion preserves those files.

No session format migration is required. If an I/O error interrupts deletion, already deleted histories remain deleted; retry after resolving the error.
