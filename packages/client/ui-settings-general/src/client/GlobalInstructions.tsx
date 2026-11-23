/** Markdown editor for the Host-owned global instruction document. */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './GlobalInstructions.module.css'

export interface InstructionsDocument {
  path: string
  content: string
  revision: string
}
export interface GlobalInstructionsInjected {
  readDocument: () => Promise<InstructionsDocument>
  saveDocument: (content: string, revision: string) => Promise<InstructionsDocument>
}
type Props = PropsRuntime<'settings.section'> & PropsLocale<'globalInstructions'> & InjectFace<GlobalInstructionsInjected>

/** Keep a failed save's draft visible; edits only reach disk on explicit Save. */
export function GlobalInstructions({ readDocument, saveDocument, t }: Props) {
  const [document, setDocument] = useState<InstructionsDocument>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let active = true
    void readDocument().then((value) => {
      if (active) { setDocument(value); setDraft(value.content) }
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [readDocument])
  const save = async () => {
    if (!document || busy) return
    setBusy(true); setError(''); setSaved(false)
    try {
      const value = await saveDocument(draft, document.revision)
      setDocument(value); setSaved(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setBusy(false) }
  }
  return <section className={css.editor}>
    <h2>{t('title')}</h2>
    <p>{t('description')}</p>
    {document && <code className={css.path}>{document.path}</code>}
    <label htmlFor="global-instructions-markdown">AGENTS.md — Markdown</label>
    <textarea id="global-instructions-markdown" className={css.input} value={draft}
      disabled={busy || !document} spellCheck={false}
      onChange={(event) => { setDraft(event.target.value); setSaved(false) }} />
    <p>{t('activation')}</p>
    {error && <p role="alert">{t('error')} {error}</p>}
    <div className={css.actions}>
      <Button disabled={busy || !document || draft === document.content} onClick={() => { void save() }}>{busy ? t('busy') : t('save')}</Button>
      <span role="status">{saved ? t('saved') : document && draft !== document.content ? t('dirty') : ''}</span>
    </div>
  </section>
}
