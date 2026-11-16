import { describe, expect, it } from 'vitest'
import { buildTmuxCommand, shellQuote, tmuxKillCommand, tmuxSearchPath, tmuxSessionName } from '../src/tmux'

describe('tmux', () => {
    it('names a session after the first 8 characters of the workspace and pin ids', () => {
        expect(tmuxSessionName('0123456789abcdef', 'fedcba9876543210')).toBe('tabby-01234567-fedcba98')
    })

    it('attaches to the session, or creates it', () => {
        expect(buildTmuxCommand('tabby-a-b')).toBe(
            'tmux has-session -t =tabby-a-b 2>/dev/null && tmux attach-session -t =tabby-a-b || tmux new-session -s tabby-a-b',
        )
    })

    it('types the startup command only into a new session, quoted for the shell', () => {
        const command = buildTmuxCommand('s', `echo 'hi'`)
        const [attach, create] = command.split(' || ')
        expect(attach).not.toContain('echo')
        expect(create).toBe(String.raw`tmux new-session -s s \; send-keys -t s 'echo '\''hi'\''' Enter`)
    })

    it('quotes the kill command for a remote shell', () => {
        expect(tmuxKillCommand('tabby-a-b')).toBe(`'tmux' 'kill-session' '-t' '=tabby-a-b'`)
        expect(shellQuote(`it's`)).toBe(`'it'\\''s'`)
    })

    it('adds the usual tmux install folders to PATH once, after the existing ones', () => {
        const path = tmuxSearchPath('/usr/bin:/opt/homebrew/bin', '/Users/me').split(':')
        expect(path.slice(0, 2)).toEqual(['/usr/bin', '/opt/homebrew/bin'])
        expect(path.filter(x => x === '/opt/homebrew/bin')).toHaveLength(1)
        expect(path).toContain('/usr/local/bin')
        expect(path).toContain('/Users/me/.nix-profile/bin')
    })

    it('works without a PATH or home folder', () => {
        expect(tmuxSearchPath(undefined, undefined).split(':')[0]).toBe('/opt/homebrew/bin')
    })
})
