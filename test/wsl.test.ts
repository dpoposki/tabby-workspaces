import { describe, expect, it } from 'vitest'
import { getWslTarget, isWslCommand, normalizeWslCwd, stripWslTagFromEnv, wslUncPath } from '../src/wsl'

describe('WSL', () => {
    it('finds the distro arguments of a WSL tab', () => {
        const terminal = { profile: { options: { command: 'C:\\Windows\\system32\\wsl.exe', args: ['--distribution', 'Debian', '--cd', '~'] } } }
        expect(getWslTarget(terminal)).toEqual({ command: 'C:\\Windows\\system32\\wsl.exe', args: ['--distribution', 'Debian'] })
        expect(getWslTarget({ profile: { options: { command: 'wsl' } } })?.args).toEqual([])
        expect(getWslTarget({ profile: { options: { command: 'pwsh.exe' } } })).toBeNull()
    })

    it('recognises wsl.exe only as the whole file name', () => {
        expect(isWslCommand('wsl.exe')).toBe(true)
        expect(isWslCommand('/mnt/c/WINDOWS/system32/wsl.exe')).toBe(true)
        expect(isWslCommand('notwsl.exe')).toBe(false)
        expect(isWslCommand(undefined)).toBe(false)
    })

    it('removes the tab id and its WSLENV entry from an environment', () => {
        expect(stripWslTagFromEnv({ TABBY_WORKSPACES_TAB: 'x', WSLENV: 'FOO/u:TABBY_WORKSPACES_TAB/u', A: '1' }))
            .toEqual({ WSLENV: 'FOO/u', A: '1' })
        expect(stripWslTagFromEnv({ TABBY_WORKSPACES_TAB: 'x', WSLENV: 'TABBY_WORKSPACES_TAB/u' })).toEqual({})
    })

    it('turns Linux paths into \\\\wsl.localhost paths', () => {
        expect(wslUncPath('Ubuntu', '/home/me/src')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\src')
        const options = { cwd: '/home/me' }
        normalizeWslCwd(options, { args: ['-d', 'Ubuntu'] })
        expect(options.cwd).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me')
    })

    it('leaves a cwd alone when it is already a Windows path or the distro is unknown', () => {
        const windowsPath = { cwd: 'C:\\Users\\me' }
        normalizeWslCwd(windowsPath, { args: ['-d', 'Ubuntu'] })
        expect(windowsPath.cwd).toBe('C:\\Users\\me')
        const noDistro = { cwd: '/home/me' }
        normalizeWslCwd(noDistro, { args: [] })
        expect(noDistro.cwd).toBe('/home/me')
    })
})
