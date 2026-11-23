/** Copy for the global Markdown settings section. */
export const instructionsEnglish = {
  title: 'Global instructions',
  description: 'Instructions shared by projects and models. Edit Markdown, then save explicitly.',
  activation: 'Used by new sessions and reconciled on session resume. Saving does not restart Harness or guarantee immediate application to an active conversation. Other global and project instructions still apply.',
  save: 'Save', busy: 'Please wait…', saved: 'Saved', dirty: 'Unsaved changes', error: 'Unable to complete the operation:',
}
/** Supported keys shared by global-instruction translations. */
export type InstructionsKey = keyof typeof instructionsEnglish
/** French copy for the global-instruction editor. */
export const instructionsFrench: Record<InstructionsKey, string> = {
  title: 'Consignes globales',
  description: 'Consignes communes aux projets et aux modèles. Édite le Markdown, puis enregistre explicitement.',
  activation: 'Lues par les nouvelles sessions et réévaluées à la reprise des sessions. Enregistrer ne redémarre pas Harness et ne garantit pas une application immédiate à une conversation active. Les autres consignes globales et celles du projet restent applicables.',
  save: 'Enregistrer', busy: 'Veuillez patienter…', saved: 'Enregistré', dirty: 'Modifications non enregistrées', error: 'Impossible de terminer l’opération :',
}
