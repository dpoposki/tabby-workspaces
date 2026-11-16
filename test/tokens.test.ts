import { describe, expect, it } from 'vitest'
import { prepareToken, terminalTokenOf } from '../src/tokens'

function splitToken (options: Record<string, any>) {
    return {
        type: 'app:split-tab',
        children: [{ type: 'app:local-tab', profile: { type: 'local', options } }],
    }
}

describe('prepareToken', () => {
    it('marks the token pinned and finds the terminal inside the split', () => {
        const token: any = splitToken({ cwd: 'C:\\' })
        prepareToken(token, {})
        expect(token.tabPinned).toBe(true)
        expect(terminalTokenOf(token)?.profile.options.cwd).toBe('C:\\')
    })

    it('stores the looked-up WSL folder and strips the tab id', () => {
        const token: any = splitToken({ cwd: 'C:\\', env: { TABBY_WORKSPACES_TAB: 'id', WSLENV: 'TABBY_WORKSPACES_TAB/u' } })
        prepareToken(token, { wslTarget: { args: ['-d', 'Ubuntu'] }, wslCwd: '\\\\wsl.localhost\\Ubuntu\\srv' })
        expect(terminalTokenOf(token)?.profile.options).toEqual({ cwd: '\\\\wsl.localhost\\Ubuntu\\srv', env: {} })
    })

    it('stores the folder an SSH shell reported', () => {
        const token: any = { type: 'app:ssh-tab', profile: { type: 'ssh', options: { host: 'h', cwd: null } } }
        prepareToken(token, { reportedCwd: '/var/www' })
        expect(token.profile.options.cwd).toBe('/var/www')
    })

    it('never changes the profile object the tab itself uses', () => {
        const profile = { type: 'ssh', options: { host: 'h', cwd: null as string | null, env: { A: '1' } } }
        const token: any = { type: 'app:ssh-tab', profile }
        prepareToken(token, { reportedCwd: '/tmp' })
        expect(profile.options.cwd).toBeNull()
        expect(token.profile).not.toBe(profile)
    })

    it('copes with tokens without a terminal', () => {
        const token: any = { type: 'app:settings-tab' }
        prepareToken(token, {})
        expect(token.tabPinned).toBe(true)
        expect(terminalTokenOf(null)).toBeNull()
    })
})
