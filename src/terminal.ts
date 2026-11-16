import { BaseTabComponent } from 'tabby-core'

/** Helpers for talking to the terminal inside a (split) tab. */

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

function sleep (ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
