import { execFile } from 'child_process'
import { BaseTabComponent } from 'tabby-core'
import { TerminalTabComponent } from 'tabby-local'

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
    if (!isWslCommand(command)) {
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

function isWslCommand (command?: string | null): command is string {
    return !!command && /(^|[\\/])wsl(\.exe)?$/i.test(command)
}

// ---------------------------------------------------------------- WSL working directory

/*
 * Tabby can't see where a WSL shell has cd'd: the process it owns is wsl.exe, whose
 * Windows cwd never changes. So every WSL tab's shell gets a unique id in its
 * environment (passed into Linux via WSLENV), and on save we ask the distro which
 * process carries that id and read its cwd from /proc. No shell setup needed.
 */

const TAG_VAR = 'TABBY_WORKSPACES_TAB'
const tags = new WeakMap<any, string>()

/** Patches local terminal tabs so WSL shells are started with their id. Call before any tab opens. */
export function tagWslShells (): void {
    const proto = TerminalTabComponent?.prototype
    if (!proto?.initializeSession || proto.__workspacesTagged) {
        return
    }
    proto.__workspacesTagged = true
    const original = proto.initializeSession
    proto.initializeSession = function (this: any, ...args: any[]) {
        const profile = this.profile
        const options = profile?.options
        if (!isWslCommand(options?.command)) {
            return original.apply(this, args)
        }
        const tag = crypto.randomUUID()
        const wslenv = [options.env?.WSLENV ?? process.env.WSLENV, `${TAG_VAR}/u`].filter(Boolean).join(':')
        // Swap the profile only while the session starts, so the id never ends up in a saved profile
        const tagged = { ...profile, options: { ...options, env: { ...options.env, [TAG_VAR]: tag, WSLENV: wslenv } } }
        this.profile = tagged
        try {
            return original.apply(this, args)
        } finally {
            // "Run as administrator" replaces the profile with a patched copy of the tagged one
            this.profile = this.profile === tagged ? profile : withoutWslTag(this.profile)
            tags.set(this, tag)
        }
    }
}

/** A copy of the profile with this plugin's tab id removed from its environment. */
function withoutWslTag (profile: any): any {
    const options = profile?.options
    if (!options?.env?.[TAG_VAR]) {
        return profile
    }
    return { ...profile, options: { ...options, env: stripWslTagFromEnv(options.env) } }
}

/** Removes the tab id (and its WSLENV entry) from an env object; used on saved tokens too. */
export function stripWslTagFromEnv (env: Record<string, string>): Record<string, string> {
    const { [TAG_VAR]: _tag, ...rest } = env
    if (rest.WSLENV !== undefined) {
        const wslenv = rest.WSLENV.split(':').filter(x => x && x.split('/')[0] !== TAG_VAR).join(':')
        if (wslenv) {
            rest.WSLENV = wslenv
        } else {
            delete rest.WSLENV
        }
    }
    return rest
}

/*
 * Lists "tab <id> <cwd>" for every process carrying an id whose parent doesn't carry the
 * same one, i.e. the tab's top-level shell rather than its children. No double quotes, so
 * it survives the Windows command line intact.
 */
const LOOKUP_SCRIPT = [
    `for f in $(grep -lsa ${TAG_VAR}= /proc/[0-9]*/environ); do`,
    `d=\${f%/environ};`,
    `t=$(tr '\\0' '\\n' 2>/dev/null < $f | grep -m1 ^${TAG_VAR}=) || continue;`,
    `pp=$(sed -n 's/^PPid:[[:space:]]*//p' $d/status 2>/dev/null);`,
    `[ x$(tr '\\0' '\\n' 2>/dev/null < /proc/$pp/environ | grep -m1 ^${TAG_VAR}=) = x$t ] && continue;`,
    `printf 'tab\\t%s\\t' \${t#*=}; readlink $d/cwd || echo;`,
    `done;`,
    `printf 'distro\\t%s\\n' $WSL_DISTRO_NAME`,
].join(' ')

/**
 * Current working directories (as \\wsl.localhost\... paths) of the given WSL terminals,
 * with one wsl.exe call per distro. Terminals that can't be resolved are left out.
 */
export async function lookupWslCwds (terminals: any[], timeoutMs = 3_000): Promise<Map<any, string>> {
    const groups = new Map<string, { target: { command: string, args: string[] }, terminals: any[] }>()
    for (const terminal of terminals) {
        const target = getWslTarget(terminal)
        if (!target || !tags.has(terminal)) {
            continue
        }
        const key = JSON.stringify(target)
        if (!groups.has(key)) {
            groups.set(key, { target, terminals: [] })
        }
        groups.get(key)!.terminals.push(terminal)
    }

    const result = new Map<any, string>()
    await Promise.all([...groups.values()].map(async group => {
        const output = await new Promise<string>(resolve => {
            execFile(
                group.target.command,
                [...group.target.args, '--exec', 'sh', '-c', LOOKUP_SCRIPT],
                { windowsHide: true, timeout: timeoutMs },
                (error, stdout) => resolve(error ? '' : String(stdout)),
            )
        })
        const cwds = new Map<string, string>()
        let distro = group.target.args[1] ?? ''
        for (const line of output.split(/\r?\n/)) {
            const [kind, a, b] = line.split('\t')
            if (kind === 'tab' && a && b?.startsWith('/') && !cwds.has(a)) {
                cwds.set(a, b)
            } else if (kind === 'distro' && a) {
                distro = a
            }
        }
        for (const terminal of group.terminals) {
            const cwd = cwds.get(tags.get(terminal)!)
            if (cwd && distro) {
                result.set(terminal, wslUncPath(distro, cwd))
            }
        }
    }))
    return result
}

/** /home/x in distro Ubuntu -> \\wsl.localhost\Ubuntu\home\x */
export function wslUncPath (distro: string, posixPath: string): string {
    return `\\\\wsl.localhost\\${distro}${posixPath.replace(/\//g, '\\')}`
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
