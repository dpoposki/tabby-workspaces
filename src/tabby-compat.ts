import { Injectable } from '@angular/core'
import * as fs from 'fs'
import * as path from 'path'
import { AppService, BaseTabComponent, HostAppService, HostWindowService, TabRecoveryService } from 'tabby-core'
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
 * - writeSavedWindowState: Tabby's window.json (`windowBoundaries`, `maximized`), which its
 *   main process reads for every new window and rewrites whenever a window closes
 */

/** The parts of Electron's BrowserWindow the plugin uses (Windows/Linux only) */
export interface NativeWindow {
    setIcon (icon: string): void
    setAppDetails (details: { appId?: string, appIconPath?: string, appIconIndex?: number, relaunchCommand?: string, relaunchDisplayName?: string }): void
    getBounds (): Bounds
    /** The size and place the window has when it's not maximized */
    getNormalBounds (): Bounds
    setBounds (bounds: Bounds): void
    isMaximized (): boolean
    isMinimized (): boolean
    isFullScreen (): boolean
    maximize (): void
    unmaximize (): void
    /** 0–1; Windows and macOS only */
    setOpacity (opacity: number): void
}

export interface Bounds {
    x: number
    y: number
    width: number
    height: number
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
    /** Right before the window closes for good (its tabs are gone); the close waits for it */
    beforeWindowGoes (): Promise<void>
    /** Before Tabby's main process opens another window */
    beforeNewWindow (): void
}

@Injectable({ providedIn: 'root' })
export class TabbyCompat {
    private installed = false

    constructor (
        private app: AppService,
        private hostApp: HostAppService,
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
            ['startup window size', () => this.patchWindowLifecycle(hooks)],
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

    /**
     * Both of Tabby's close paths (closeWindow, and the last tab closing with
     * "lastTabClosesWindow") end in hostWindow.close(), after the tabs are gone; every
     * new window (hotkey, launcher, second instance) goes through hostApp.newWindow().
     */
    private patchWindowLifecycle (hooks: TabbyHooks): boolean {
        if (typeof (this.hostWindow as any).close !== 'function' || typeof (this.hostApp as any).newWindow !== 'function') {
            return false
        }
        patchMethod(this.hostWindow, 'close', original => () => {
            hooks.beforeWindowGoes().catch(() => undefined).finally(() => original())
        })
        patchMethod(this.hostApp, 'newWindow', original => () => {
            try {
                hooks.beforeNewWindow()
            } finally {
                original()
            }
        })
        return true
    }

    /**
     * Rewrites the window size in Tabby's window.json (same format as Tabby's electron-store),
     * keeping any other keys. Tabby gives it to the next window it opens.
     */
    writeSavedWindowState (state: { bounds: Bounds, maximized: boolean }): void {
        const file = path.join(require('@electron/remote').app.getPath('userData'), 'window.json')
        let saved: Record<string, unknown> = {}
        try {
            saved = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}
        } catch { }
        saved.windowBoundaries = state.bounds
        saved.maximized = state.maximized
        const temp = `${file}.workspaces-tmp`
        fs.writeFileSync(temp, JSON.stringify(saved, null, '\t'))
        fs.renameSync(temp, file)
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
