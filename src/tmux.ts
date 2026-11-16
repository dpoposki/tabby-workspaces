import { execFile } from 'child_process'

/**
 * tmux sessions that keep a pinned tab's shell alive across window closes. The attach
 * command is typed into the tab's own shell, so tmux is found on that shell's PATH.
 */

export function tmuxSessionName (workspaceId: string, pinId: string): string {
    return `tabby-${workspaceId.slice(0, 8)}-${pinId.slice(0, 8)}`
}

/** Shell command that attaches to the pin's tmux session, creating it (and running the startup command) if needed. */
export function buildTmuxCommand (name: string, startupCommand?: string): string {
    let create = `tmux new-session -s ${name}`
    if (startupCommand) {
        create += ` \\; send-keys -t ${name} ${shellQuote(startupCommand)} Enter`
    }
    return `tmux has-session -t =${name} 2>/dev/null && tmux attach-session -t =${name} || ${create}`
}

/** The command line that ends the session, as an argument list */
export function tmuxKillArgs (name: string): string[] {
    return ['tmux', 'kill-session', '-t', `=${name}`]
}

/** The same, as one shell command (for a remote shell) */
export function tmuxKillCommand (name: string): string {
    return tmuxKillArgs(name).map(shellQuote).join(' ')
}

/**
 * Where tmux is usually installed. Tabby started from the Dock, Finder or a desktop menu
 * has a minimal PATH without them (Homebrew, MacPorts, Nix, Linuxbrew), though the shell
 * in its tabs finds tmux fine.
 */
export const EXTRA_TMUX_PATHS = [
    '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin',
    '/home/linuxbrew/.linuxbrew/bin', '/run/current-system/sw/bin', '/nix/var/nix/profiles/default/bin',
]

/** PATH for running tmux from Tabby itself: the given one, then the usual install folders */
export function tmuxSearchPath (path: string | undefined, home: string | undefined): string {
    const extra = [...EXTRA_TMUX_PATHS, ...home ? [`${home}/.nix-profile/bin`, `${home}/.local/bin`] : []]
    const parts = (path ?? '').split(':').filter(Boolean)
    return [...parts, ...extra.filter(x => !parts.includes(x))].join(':')
}

/** Ends a tmux session on this machine (macOS, Linux) */
export function killLocalTmuxSession (name: string): void {
    const [command, ...args] = tmuxKillArgs(name)
    const env = { ...process.env, PATH: tmuxSearchPath(process.env.PATH, process.env.HOME) }
    execFile(command, args, { env }, () => null)
}

export function shellQuote (value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}
