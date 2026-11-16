import { execFile } from 'child_process'
import { BaseTabComponent } from 'tabby-core'

/**
 * Helpers for talking to the terminal inside a (split) tab, and for running
 * tmux inside WSL.
 */

/** The terminal pane inside a top-level tab (Tabby wraps every tab in a split container). */
export function getTerminal (tab: BaseTabComponent): any | null {
    const anyTab = tab as any
    if (typeof anyTab.getAllTabs === 'function') {
        return anyTab.getAllTabs()[0] ?? null
    }
    return anyTab
}

/** Resolves once the tab's terminal has a running session, or null after a timeout. */
export async function waitForSession (tab: BaseTabComponent, timeoutMs = 15_000): Promise<any | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const terminal = getTerminal(tab)
        if (terminal?.session?.output$) {
            return terminal
        }
        await sleep(100)
    }
    return null
}

/** Waits until the shell has printed something and then gone quiet (i.e. shows its prompt). */
export function waitForPrompt (session: any, quietMs = 600, maxMs = 6_000): Promise<void> {
    return new Promise(resolve => {
        let quietTimer: any = null
        const finish = () => {
            clearTimeout(quietTimer)
            clearTimeout(maxTimer)
            sub.unsubscribe()
            resolve()
        }
        const maxTimer = setTimeout(finish, maxMs)
        const sub = session.output$.subscribe(() => {
            clearTimeout(quietTimer)
            quietTimer = setTimeout(finish, quietMs)
        })
    })
}

/**
 * For a local WSL tab, returns the wsl.exe path and the distro arguments
 * (e.g. ['-d', 'Ubuntu']). Returns null for any other kind of tab.
 */
export function getWslTarget (terminal: any): { command: string, args: string[] } | null {
    const options = terminal?.profile?.options
    const command: string | undefined = options?.command
    if (!command || !/(^|[\\/])wsl(\.exe)?$/i.test(command)) {
        return null
    }
    const args: string[] = options.args ?? []
    const index = args.findIndex(x => x === '-d' || x === '--distribution')
    return {
        command,
        args: index !== -1 && args[index + 1] ? [args[index], args[index + 1]] : [],
    }
}

export function isWslTab (tab: BaseTabComponent): boolean {
    return !!getWslTarget(getTerminal(tab))
}

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

export function killTmuxSession (target: { command: string, args: string[] }, name: string): void {
    execFile(target.command, [...target.args, '--', 'tmux', 'kill-session', '-t', `=${name}`], { windowsHide: true }, () => null)
}

function shellQuote (value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}

function sleep (ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
