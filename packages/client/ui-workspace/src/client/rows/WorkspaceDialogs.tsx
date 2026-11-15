/** Workspace rename and removal dialogs, keyed by their captured request. */
import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceActionRequest, WorkspaceBrowserProps } from '../contract/slots.ts'
import css from './WorkspaceBrowser.module.css'

type Props = Pick<WorkspaceBrowserProps, 'renameWorkspace' | 'deleteWorkspace' | 'deleteSession' | 'settleWorkspaceAction' | 't'> & {
  request: WorkspaceActionRequest
  workspaces: readonly WorkspaceView[]
}

/** @param props - captured request, current Workspace list, and existing mutations. @returns the active dialog. */
export function WorkspaceDialogs({
  request, workspaces, renameWorkspace, deleteWorkspace, deleteSession, settleWorkspaceAction, t,
}: Props) {
  const composingRef = useRef(false)
  const renameTarget = request.action === 'rename' ? request : null
  const [renameDraft, setRenameDraft] = useState(request.displayTitle)
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const renameTrimmed = renameDraft.trim()
  // Self is excluded by identity, not by title: the draft is seeded with the
  // localized label, which for an automatically titled Workspace equals its
  // own displayed title without being a conflict with itself.
  const renameDuplicate = renameTarget !== null && renameTrimmed !== ''
    && workspaces.some(w => w.workspaceId !== renameTarget.workspaceId && w.title === renameTrimmed)
  const renameBlocked = renaming || renameTrimmed === ''
    || renameTarget === null || renameTrimmed === renameTarget.storedTitle || renameDuplicate
  const closeRename = () => {
    if (renaming) return
    settleWorkspaceAction()
    setRenameError(null)
  }
  const confirmRename = () => {
    if (renameBlocked) return
    setRenaming(true)
    setRenameError(null)
    renameWorkspace(renameTarget.workspaceId, renameTrimmed).then(() => {
      setRenaming(false)
      settleWorkspaceAction()
    }).catch((reason: unknown) => {
      setRenaming(false)
      setRenameError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const deleteTarget = request.action === 'rename' ? null : request
  const deleteLabel = t(request.action === 'deleteSession' ? 'delete.session' : 'delete.workspace')
  const [deleting, setDeleting] = useState(false)
  const [deleteCommittedId, setDeleteCommittedId] = useState<WorkspaceId | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  useEffect(() => {
    if (deleteCommittedId === null
      || workspaces.some(workspace => workspace.workspaceId === deleteCommittedId)) return
    setDeleting(false)
    setDeleteCommittedId(null)
    settleWorkspaceAction()
  }, [deleteCommittedId, workspaces, settleWorkspaceAction])
  const closeDelete = () => {
    if (deleting) return
    settleWorkspaceAction()
    setDeleteError(null)
  }
  const confirmDelete = () => {
    /* v8 ignore next -- the Modal is absent without a target and its button is disabled while deleting. */
    if (deleting || deleteTarget === null) return
    setDeleting(true)
    setDeleteCommittedId(null)
    setDeleteError(null)
    const operation = deleteTarget.action === 'deleteSession'
      ? deleteSession(deleteTarget.sessionId)
      : deleteWorkspace(deleteTarget.workspaceId)
    operation.then(() => {
      if (deleteTarget.action === 'deleteSession') {
        settleWorkspaceAction()
        return
      }
      // Keep the confirmation pending until this component has rendered the
      // committed list projection without the deleted id. Closing earlier
      // exposes one stale React frame to the next Create Workspace gesture.
      setDeleteCommittedId(deleteTarget.workspaceId)
    }).catch((reason: unknown) => {
      setDeleting(false)
      setDeleteError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return <>
    <Modal
      open={renameTarget !== null}
      onClose={closeRename}
      closeLabel={t('close')}
      title={t('rename.workspace.title')}
      footer={(
        <>
          <Button variant="outline" disabled={renaming} onClick={closeRename}>{t('cancel')}</Button>
          <Button variant="primary" disabled={renameBlocked} onClick={confirmRename}>{t('rename')}</Button>
        </>
      )}
    >
      <input
        className={css.renameInput}
        value={renameDraft}
        aria-label={t('field.workspaceName')}
        data-modal-autofocus
        disabled={renaming}
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { setRenameDraft(e.target.value); setRenameError(null) }}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !composingRef.current) {
            e.preventDefault()
            confirmRename()
          }
        }}
      />
      {renameDuplicate && (
        <div className={css.renameError} role="alert">{t('conflict.named', { name: renameTrimmed })}</div>
      )}
      {renameError !== null && <div className={css.renameError} role="alert">{renameError}</div>}
    </Modal>

    <Modal
      open={deleteTarget !== null}
      onClose={closeDelete}
      closeLabel={t('close')}
      title={deleteLabel}
      {...deleteTarget === null
        ? {}
        : { description: t(deleteTarget.action === 'deleteSession' ? 'delete.sessionDesc' : 'delete.desc', { name: deleteTarget.displayTitle }) }}
      footer={(
        <>
          <Button variant="outline" data-modal-autofocus disabled={deleting} onClick={closeDelete}>{t('cancel')}</Button>
          <Button
            variant="outline"
            className={css.deleteAction}
            disabled={deleting}
            onClick={confirmDelete}
          >
            {deleteLabel}
          </Button>
        </>
      )}
    >
      {deleting && <div className={css.deleteStatus} role="status">{t(request.action === 'deleteSession' ? 'delete.sessionPending' : 'delete.pending')}</div>}
      {deleteError !== null && <div className={css.renameError} role="alert">{deleteError}</div>}
    </Modal>
  </>
}
