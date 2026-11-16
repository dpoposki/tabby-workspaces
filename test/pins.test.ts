import { describe, expect, it } from 'vitest'
import { isPosixShell, pinKindOf } from '../src/pins'

const local = (command?: string, args: string[] = []) => ({ profile: { type: 'local', options: { command, args } } })

describe('pinKindOf', () => {
    it('recognises WSL tabs on Windows, with tmux', () => {
        const kind = pinKindOf(local('C:\\Windows\\System32\\wsl.exe', ['-d', 'Ubuntu']), 'win32')
        expect(kind.name).toBe('wsl')
        expect(kind.tmux).toBe(true)
    })

    it('gives SSH tabs tmux on every platform', () => {
        for (const platform of ['win32', 'darwin', 'linux']) {
            expect(pinKindOf({ profile: { type: 'ssh', options: { host: 'x' } } }, platform).name).toBe('ssh')
        }
    })

    it('gives shells on macOS and Linux tmux', () => {
        expect(pinKindOf(local('/bin/zsh', ['--login']), 'darwin').name).toBe('local')
        expect(pinKindOf(local('/usr/bin/bash'), 'linux').tmux).toBe(true)
        expect(pinKindOf(local(), 'linux').tmux).toBe(true)
    })

    it('gives no tmux to Windows shells, non-shell commands, serial and telnet', () => {
        expect(pinKindOf(local('powershell.exe'), 'win32').tmux).toBe(false)
        expect(pinKindOf(local('C:\\Program Files\\Git\\bin\\bash.exe'), 'win32').tmux).toBe(false)
        expect(pinKindOf(local('/usr/bin/htop'), 'linux').tmux).toBe(false)
        expect(pinKindOf({ profile: { type: 'serial', options: {} } }, 'linux').tmux).toBe(false)
        expect(pinKindOf({ profile: { type: 'telnet', options: {} } }, 'linux').name).toBe('other')
        expect(pinKindOf(null, 'linux').name).toBe('other')
    })
})

describe('isPosixShell', () => {
    it('matches shells by their file name', () => {
        expect(isPosixShell('/opt/homebrew/bin/fish')).toBe(true)
        expect(isPosixShell('-zsh')).toBe(true)
        expect(isPosixShell('/usr/bin/tcsh')).toBe(false)
        expect(isPosixShell('pwsh')).toBe(false)
    })
})
