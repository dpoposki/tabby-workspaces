import { execFile } from 'child_process'

/** tmux sessions that keep a pinned tab's shell alive across window closes (WSL only for now). */

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
