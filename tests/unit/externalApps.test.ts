import { describe, expect, it } from 'vitest'
import { isStoreAppId, parseStartApps } from '../../src/main/services/externalApps'
import { isAllowedExternalUrl } from '../../src/main/services/pathGuard'
import { isChatGptStartUrl, isChatGptViewUrl } from '../../src/main/chatgptView'

describe('ChatGPT panel navigation', () => {
  it('only starts on chatgpt.com over https', () => {
    expect(isChatGptStartUrl('https://chatgpt.com/')).toBe(true)
    expect(isChatGptStartUrl('https://chatgpt.com.evil.example/')).toBe(false)
    expect(isChatGptStartUrl('http://chatgpt.com/')).toBe(false)
    expect(isChatGptStartUrl('https://example.com/')).toBe(false)
  })

  it('stays on ChatGPT and the official sign-in pages', () => {
    expect(isChatGptViewUrl('https://chatgpt.com/c/123')).toBe(true)
    expect(isChatGptViewUrl('https://auth.openai.com/log-in')).toBe(true)
    expect(isChatGptViewUrl('https://accounts.google.com/o/oauth2/auth')).toBe(true)
    expect(isChatGptViewUrl('https://login.microsoftonline.com/common')).toBe(true)
    expect(isChatGptViewUrl('https://appleid.apple.com/auth')).toBe(true)
    expect(isChatGptViewUrl('https://evilopenai.com/')).toBe(false)
    expect(isChatGptViewUrl('https://github.com/')).toBe(false)
    expect(isChatGptViewUrl('http://chatgpt.com/')).toBe(false)
  })
})

describe('ChatGPT launcher', () => {
  it('reads the Start menu entry (one object or an array)', () => {
    expect(parseStartApps('{"Name":"ChatGPT","AppID":"OpenAI.Codex_2p2nqsd0c76g0!App"}')).toEqual([{ name: 'ChatGPT', appId: 'OpenAI.Codex_2p2nqsd0c76g0!App' }])
    expect(parseStartApps('[{"Name":"ChatGPT","AppID":"A.B_2p2nqsd0c76g0!App"},{"Name":"Other","AppID":"x"}]')).toHaveLength(2)
    expect(parseStartApps('')).toEqual([])
    expect(parseStartApps('not json')).toEqual([])
  })

  it('only launches Microsoft Store app ids', () => {
    expect(isStoreAppId('OpenAI.Codex_2p2nqsd0c76g0!App')).toBe(true)
    expect(isStoreAppId('C:\\Windows\\System32\\cmd.exe')).toBe(false)
    expect(isStoreAppId('OpenAI.Codex_2p2nqsd0c76g0!App & calc')).toBe(false)
    expect(isStoreAppId('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\cmd.exe')).toBe(false)
  })

  it('allows chatgpt.com as the browser fallback', () => {
    expect(isAllowedExternalUrl('https://chatgpt.com/')).toBe(true)
    expect(isAllowedExternalUrl('http://chatgpt.com/')).toBe(false)
  })
})
