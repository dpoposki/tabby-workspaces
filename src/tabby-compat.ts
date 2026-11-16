import { Injectable } from '@angular/core'
import { AppService, BaseTabComponent, HostWindowService, TabRecoveryService } from 'tabby-core'
import { tagWslShells } from './wsl'

/*
 * Every place the plugin reaches into Tabby (or Electron) beyond its public plugin API.
 * Tabby has no hooks for these, so they are patches; keeping them in one file means one
 * file to re-check after a Tabby upgrade. Each patch checks that its target exists, and a
 * missing one disables only its own feature.
 *
 * Elsewhere, read-only reliance on Tabby internals:
 * - terminal.ts: a tab's terminal (`getAllTabs()[0]`, `session.output$`, `sendInput`)
 * - wsl.ts: a terminal's `profile.options` (command, args, env, cwd)
 * - session.ts: the shape of recovery tokens (split container → leaf with `profile`)
 * - taskbar.ts: Tabby's logo at `<resources>/app.asar/assets/logo.svg`
 * - providers.ts: CLI handler priorities relative to Tabby's own (-999 and -1000)
 */

/** The parts of Electron's BrowserWindow the plugin uses (Windows/Linux only) */
export interface NativeWindow {
    setIcon (icon: string): void
    setAppDetails (details: { appId?: string, appIconPath?: string, appIconIndex?: number, relaunchCommand?: string, relaunchDisplayName?: string }): void
}

/** What the patches call back into */
export interface TabbyHooks {
    /** After any pin (context menu, hotkey, restore); `wasPinned` is the state before */
    afterPin (tab: BaseTabComponent, wasPinned: boolean): void
    afterUnpin (tab: BaseTabComponent): void
    /** Before Tabby closes the window; its tabs are still there */
    beforeCloseWindow (): Promise<void>
    /** After Tabby's close; `cancelled` if the window stayed open (e.g. the user said no) */
    afterCloseWindow (cancelled: boolean): void
    /** The OS window title for a tab title (undefined when no tab is active) */
    decorateTitle (title: string | undefined): string | undefined
}

@Injectable({ providedIn: 'root' })
export class TabbyCompat {
    private installed = false

    constructor (
        private app: AppService,
        private hostWindow: HostWindowService,
        private tabRecovery: TabRecoveryService,
    ) { }

    /** Installs all patches; returns the names of the features that couldn't be. */
    install (hooks: TabbyHooks): string[] {
        if (this.installed) {
            return []
        }
        this.installed = true
        const features: [string, () => boolean][] = [
            ['WSL working directories', () => tagWslShells()],
            ['saving pins', () => this.patchAppService(hooks)],
            ['window titles', () => this.patchWindowTitle(hooks)],
            ['multi-window tab recovery', () => this.disableBuiltinTabRecovery()],
        ]
        return features.filter(([, install]) => !tryInstall(install)).map(([name]) => name)
    }

    /** The Electron window behind this Tabby window (via @electron/remote), if available */
    getNativeWindow (): NativeWindow | null {
        return (this.hostWindow as any).getWindow?.() ?? null
    }

    /**
     * Moves one provider to the front of an Angular multi-provider array. Tabby's
     * CommandService holds the same array instance and sorts its commands stably by
     * weight, so this decides the order among equal weights (e.g. on the start page).
     */
    static putFirst<T> (array: T[], predicate: (item: T) => boolean): void {
        const index = array.findIndex(predicate)
        if (index > 0) {
            array.unshift(...array.splice(index, 1))
        }
    }

    private patchAppService (hooks: TabbyHooks): boolean {
        const app = this.app
        if (typeof app.pinTab !== 'function' || typeof app.unpinTab !== 'function' || typeof app.closeWindow !== 'function') {
            return false
        }
        // Every pin path (context menu, hotkey) goes through pinTab
        patchMethod(app, 'pinTab', original => (tab: BaseTabComponent) => {
            const wasPinned = tab.pinned
            original(tab)
            hooks.afterPin(tab, wasPinned)
        })
        patchMethod(app, 'unpinTab', original => (tab: BaseTabComponent) => {
            original(tab)
            hooks.afterUnpin(tab)
        })
        // The OS close button and the close-window hotkey both end up here
        patchMethod(app, 'closeWindow', original => async () => {
            await hooks.beforeCloseWindow()
            try {
                await original()
            } finally {
                hooks.afterCloseWindow(app.tabs.length > 0)
            }
        })
        return true
    }

    private patchWindowTitle (hooks: TabbyHooks): boolean {
        return patchMethod(this.hostWindow, 'setTitle', original => (title?: string) => original(hooks.decorateTitle(title)))
    }

    /**
     * Tabby's own "restore tabs" only knows one window and would fight with workspaces,
     * so it's switched off while the plugin runs, without touching the user's setting
     * (which takes effect again if the plugin is removed). Runs during bootstrap, before
     * Tabby's config has loaded and it tries to recover anything.
     */
    private disableBuiltinTabRecovery (): boolean {
        const recovery = this.tabRecovery as any
        return patchMethod(recovery, 'recoverTabs', () => async () => [])
            && patchMethod(recovery, 'saveTabs', () => async () => undefined)
    }
}

function tryInstall (install: () => boolean): boolean {
    try {
        return install()
    } catch (error) {
        console.warn('[workspaces] patch failed', error)
        return false
    }
}

/**
 * Replaces `target[name]` with `replace(original)`, where `original` is bound to `target`.
 * Returns false (and changes nothing) if the method doesn't exist.
 */
function patchMethod<T extends object> (
    target: T,
    name: keyof T & string,
    replace: (original: (...args: any[]) => any) => (...args: any[]) => any,
): boolean {
    const original = (target as any)[name]
    if (typeof original !== 'function') {
        console.warn(`[workspaces] cannot patch ${name}: not found in this Tabby version`)
        return false
    }
    (target as any)[name] = replace(original.bind(target))
    return true
}
