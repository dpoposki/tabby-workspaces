import { normalizeWslCwd, stripWslTagFromEnv } from './wsl'

/** Recovery tokens: Tabby's description of a tab, which a pin stores to reopen it. */

/**
 * Makes a recovery token fit for storing as a pin: marked pinned, without this plugin's
 * WSL tab id, with the WSL working directory as a \\wsl.localhost\... path, and with the
 * folder an SSH shell reported (Tabby then cd's there after connecting).
 */
export function prepareToken (token: any, found: {
    wslTarget?: { args: string[] } | null
    wslCwd?: string | null
    reportedCwd?: string | null
}): void {
    token.tabPinned = true
    const leaf = terminalTokenOf(token)
    if (!leaf?.profile?.options) {
        return
    }
    // Some tabs (SSH) put their live profile into the token: change a copy, never the profile
    leaf.profile = { ...leaf.profile, options: { ...leaf.profile.options } }
    const options = leaf.profile.options
    if (options.env) {
        options.env = stripWslTagFromEnv(options.env)
    }
    if (found.wslCwd) {
        options.cwd = found.wslCwd
    } else if (found.reportedCwd) {
        options.cwd = found.reportedCwd
    } else {
        normalizeWslCwd(options, found.wslTarget ?? null)
    }
}

/** The folder the shell last reported (OSC 1337 CurrentDir), if it reports one */
export async function reportedCwd (terminal: any): Promise<string | null> {
    try {
        return await terminal?.session?.getWorkingDirectory?.() ?? null
    } catch {
        return null
    }
}

/**
 * A top-level tab's token is a split container ({ type: 'app:split-tab', children: [...] });
 * the terminal's own token (with the profile and cwd) is its first leaf, matching getTerminal().
 */
export function terminalTokenOf (token: any): any | null {
    if (!token) {
        return null
    }
    if (token.profile) {
        return token
    }
    for (const child of token.children ?? []) {
        const leaf = terminalTokenOf(child)
        if (leaf) {
            return leaf
        }
    }
    return null
}
