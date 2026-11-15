import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

type Metadata = NonNullable<LlmDiscoveredModel['lmStudio']>
const fields = [
  ['text', 'lmText'], ['vision', 'lmVision'], ['tools', 'lmTools'],
  ['reasoning', 'lmReasoning'], ['effort', 'lmEffort'],
] as const

/** Keep provider declarations visible while editing independent, removable overrides. */
export function LmStudioCapabilitiesEditor({ metadata, t, disabled, onChange }: {
  metadata: Metadata
  t: (key: ModelsKey) => string
  disabled: boolean
  onChange: (next: Metadata) => void
}) {
  return <fieldset className={styles['modelInputTypes']}>
    <legend>{`LM Studio · ${metadata.source}`}</legend>
    {fields.map(([field, key]) => {
      const reported = metadata[field]
      const override = metadata.overrides?.[field]
      return <label key={field} className={styles['modelField']}>
        <span>{t(key)}</span>
        <select className={`${styles['input']} ${styles['selectInput']}`} disabled={disabled} value={override === undefined ? '' : String(override)}
          onChange={(event) => {
            const overrides = { ...metadata.overrides }
            if (event.target.value === '') Reflect.deleteProperty(overrides, field)
            else overrides[field] = event.target.value === 'true'
            onChange({ ...metadata, overrides })
          }}>
          <option value="">{t('lmDeclared')} · {t(reported === undefined ? 'lmUnknown' : reported ? 'lmYes' : 'lmNo')}</option>
          <option value="true">{t('lmManual')} · {t('lmYes')}</option>
          <option value="false">{t('lmManual')} · {t('lmNo')}</option>
        </select>
      </label>
    })}
    <p>{t('lmMax')} · {metadata.maxContext?.toLocaleString() ?? t('lmUnknown')}</p>
    <p>{t('lmLoaded')} · {metadata.loadedContext?.toLocaleString() ?? t('lmUnknown')}</p>
  </fieldset>
}
