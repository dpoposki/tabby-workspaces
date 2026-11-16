/*
 * Web Locks shared by all Tabby windows (they load from the same file:// origin, like
 * the localStorage and BroadcastChannel the plugin already shares). A lock is released
 * automatically when its window closes or crashes, which is what makes it a reliable
 * "this workspace is open in a window" marker. Callers fall back to slower, racier
 * means when the API isn't available.
 */

const PREFIX = 'tabby-workspaces:'

export function locksSupported (): boolean {
    return typeof navigator !== 'undefined' && !!navigator.locks
}

/**
 * Takes the lock if nobody holds it, and keeps it until `release()` or until this window
 * goes away. Resolves to the release function, or null if another window holds it.
 */
export function holdLock (name: string): Promise<(() => void) | null> {
    return new Promise(resolve => {
        navigator.locks.request(PREFIX + name, { ifAvailable: true }, lock => {
            if (!lock) {
                resolve(null)
                return undefined
            }
            // The lock is held for as long as this promise is pending
            return new Promise<void>(release => resolve(release))
        }).catch(() => resolve(null))
    })
}

/** Names (without prefix) of the locks currently held by any window */
export async function heldLocks (): Promise<string[]> {
    const state = await navigator.locks.query()
    return (state.held ?? [])
        .map(lock => lock.name ?? '')
        .filter(name => name.startsWith(PREFIX))
        .map(name => name.slice(PREFIX.length))
}

/** Runs `action` while holding the lock exclusively, waiting for other windows if needed */
export function withLock<T> (name: string, action: () => T | Promise<T>): Promise<T> {
    if (!locksSupported()) {
        return Promise.resolve(action())
    }
    return navigator.locks.request(PREFIX + name, async () => action()) as Promise<T>
}
