import { expect, it, vi } from 'vitest'
import { recoverDgx, waitForDgx } from '../src/dgx.ts'

it('attend la fin du chargement sans relancer le serveur', async () => {
  const probe = vi.fn().mockResolvedValueOnce('loading').mockResolvedValueOnce('ready')
  const repair = vi.fn()
  await waitForDgx(new AbortController().signal, probe, repair, 1)
  expect(repair).not.toHaveBeenCalled()
})

it('ne répare qu’une fois même si le tunnel met plusieurs sondes à répondre', async () => {
  const probe = vi.fn().mockResolvedValueOnce('offline').mockResolvedValueOnce('offline')
    .mockResolvedValueOnce('loading').mockResolvedValueOnce('ready')
  const repair = vi.fn()
  await waitForDgx(new AbortController().signal, probe, repair, 1)
  expect(repair).toHaveBeenCalledTimes(1)
})

it('borne la durée d’attente', async () => {
  await expect(waitForDgx(AbortSignal.timeout(30), async () => 'loading', vi.fn(), 5)).rejects.toThrow()
})

it('partage la récupération et vérifie le modèle annoncé', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ status: 'ok' }))
    .mockResolvedValueOnce(Response.json({ data: [] }))
  vi.stubGlobal('fetch', fetch)
  try {
    const first = recoverDgx()
    expect(recoverDgx()).toBe(first)
    await expect(first).rejects.toThrow('qwen38-flash')
    expect(fetch).toHaveBeenCalledTimes(2)
  } finally {
    vi.unstubAllGlobals()
  }
})
