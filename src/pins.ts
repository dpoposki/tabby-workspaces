import { BaseTabComponent } from 'tabby-core'
import { getTerminal, waitForPrompt, waitForSession } from './terminal'
import { getWslTarget, killWslTmuxSession } from './wsl'
import { killLocalTmuxSession, tmuxKillCommand } from './tmux'

/**
 * What differs between the kinds of tab a pin can hold: whether it can have a persistent
 * tmux session, when it's ready for its startup command, and how its tmux session ends.
 */
export interface PinKind {
    readonly name: 'wsl' | 'local' | 'ssh' | 'other'
    /** The pin can attach to a persistent tmux session */
    readonly tmux: boolean
    /** The terminal once it can take a typed command (shell prompt showing), or null if it never got there */
    waitUntilReady (tab: BaseTabComponent): Promise<any | null>
    /** Ends the pin's tmux session; the terminal may be closing */
    killTmuxSession (terminal: any, name: string): void
}

/** Shells that understand the typed tmux command (`2>/dev/null`, `&&`, `||`) */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'mksh', 'ash'])

/** Connecting can include typing a password or accepting a host key */
const SSH_CONNECT_TIMEOUT_MS = 120_000

const WSL: PinKind = {
    name: 'wsl',
    tmux: true,
    waitUntilReady: readyAtPrompt(),
    killTmuxSession (terminal, name) {
        const target = getWslTarget(terminal)
        if (target) {
            killWslTmuxSession(target, name)
        }
    },
}

/** A shell on this Mac or Linux machine */
const LOCAL_SHELL: PinKind = {
    name: 'local',
    tmux: true,
    waitUntilReady: readyAtPrompt(),
    killTmuxSession: (_terminal, name) => killLocalTmuxSession(name),
}

const SSH: PinKind = {
    name: 'ssh',
    tmux: true,
    waitUntilReady: readyAtPrompt(SSH_CONNECT_TIMEOUT_MS),
    killTmuxSession (terminal, name) {
        runOverSsh(terminal?.sshSession, tmuxKillCommand(name)).catch(() => null)
    },
}

/** Serial, telnet, PowerShell, cmd, ...: a startup command, no tmux */
const OTHER: PinKind = {
    name: 'other',
    tmux: false,
    waitUntilReady: readyAtPrompt(SSH_CONNECT_TIMEOUT_MS),
    killTmuxSession: () => null,
}

export function pinKindOf (terminal: any, platform: string = process.platform): PinKind {
    const profile = terminal?.profile
    if (getWslTarget(terminal)) {
        return WSL
    }
    if (profile?.type === 'ssh') {
        return SSH
    }
    if (profile?.type === 'local' && platform !== 'win32' && isPosixShell(profile.options?.command)) {
        return LOCAL_SHELL
    }
    return OTHER
}

export function pinKindOfTab (tab: BaseTabComponent): PinKind {
    return pinKindOf(getTerminal(tab))
}

/** No command means the user's default shell */
export function isPosixShell (command?: string | null): boolean {
    if (!command) {
        return true
    }
    const name = command.split(/[\\/]/).pop()!.replace(/^-/, '')
    return POSIX_SHELLS.has(name)
}

function readyAtPrompt (connectTimeoutMs?: number): PinKind['waitUntilReady'] {
    return async tab => {
        const terminal = await waitForSession(tab, connectTimeoutMs)
        if (terminal) {
            await waitForPrompt(terminal.session)
        }
        return terminal
    }
}

/**
 * Runs a command on the SSH server over its own channel, next to the tab's shell. Holds a
 * reference to the connection meanwhile, so it stays up even if the tab just closed.
 */
async function runOverSsh (connection: any, command: string, timeoutMs = 10_000): Promise<void> {
    const client = connection?.ssh
    if (!connection?.open || typeof client?.openSessionChannel !== 'function') {
        return
    }
    connection.ref()
    try {
        const channel = await client.activateChannel(await client.openSessionChannel())
        await new Promise<void>(resolve => {
            let sub: any = null
            const done = () => {
                clearTimeout(timer)
                sub?.unsubscribe()
                resolve()
            }
            const timer = setTimeout(done, timeoutMs)
            sub = channel.closed$?.subscribe(done) ?? null
            channel.requestExec(command).catch(done)
        })
    } finally {
        connection.unref()
    }
}
