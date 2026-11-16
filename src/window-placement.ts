import { Injectable } from '@angular/core'
import { AppService } from 'tabby-core'
import { Bounds, NativeWindow, TabbyCompat } from './tabby-compat'
import { WorkspaceSession } from './session'
import { ErrorReporter } from './errors'

/** Size of the window while the launcher is shown at startup, like Chrome's profile picker */
export const COMPACT_SIZE = { width: 900, height: 620 }
/** At least this much of a saved window must be on a screen, or it isn't put back there */
const MIN_VISIBLE_PX = 120
const SAVE_INTERVAL_MS = 10_000

const PLACEMENT_PREFIX = 'tabbyWorkspaces.window.'
/** The window's own size before it was made compact, to go back to for a plain window */
const BEFORE_COMPACT_KEY = 'tabbyWorkspaces.window.beforeCompact'
/** Set while the window is compact: Tabby saves that size if it's closed from the launcher */
const COMPACT_ACTIVE_KEY = 'tabbyWorkspaces.window.compactActive'
/** Set when a window closed at the launcher's size, so Tabby saved that size for its next window */
const SAVED_COMPACT_KEY = 'tabbyWorkspaces.window.savedCompact'
/** Platforms where an invisible window can be resized: Electron's setOpacity does nothing on Linux */
const RESIZE_UNSEEN_PLATFORMS = ['win32', 'darwin']
/** Time for Tabby's main process to take in the new size before the window closes */
const RESIZE_SETTLE_MS = 100
/** A window this close to the compact size and place counts as already compact */
const SAME_BOUNDS_PX = 8

export interface Placement {
    bounds: Bounds
    maximized: boolean
}

/**
 * Where each workspace's window goes: its size, position and maximized state are saved
 * while it's open and put back when it opens again, like Chrome does per profile. Also
 * makes the window small and centered while the launcher is shown at startup.
 */
@Injectable({ providedIn: 'root' })
export class WindowPlacement {
    private compact = false

    constructor (
        private app: AppService,
        private compat: TabbyCompat,
        private session: WorkspaceSession,
        private errors: ErrorReporter,
    ) { }

    init (): void {
        this.session.attached$.subscribe(workspace => this.safely(() => this.restore(workspace.id)))
        // The last tab closing can close the window without beforeClose (see WorkspaceSession.saveEmpty)
        this.app.tabClosed$.subscribe(() => this.app.tabs.length || this.save())
        setInterval(() => this.save(), SAVE_INTERVAL_MS)
    }

    /** Remembers this workspace window's placement; call before the window closes */
    save (): void {
        const id = this.session.current?.id
        const win = this.nativeWindow()
        if (!id || this.compact || !win) {
            return
        }
        this.safely(() => {
            // Minimized or full screen, the window doesn't tell whether it was maximized
            if (!win.isMinimized() && !win.isFullScreen()) {
                writeJson(PLACEMENT_PREFIX + id, placementOf(win))
            }
        })
    }

    forget (workspaceId: string): void {
        localStorage.removeItem(PLACEMENT_PREFIX + workspaceId)
    }

    /** Shrinks the window to a small, centered one for the startup launcher */
    enterCompact (): void {
        this.safely(() => {
            const win = this.nativeWindow()
            const area = win && screen()?.getDisplayMatching(win.getBounds()).workArea
            if (this.compact || !win || !area || win.isFullScreen()) {
                return
            }
            // If Tabby saved the compact size at the last close, it opened at that size, and
            // the real one from before is stored already
            if (!readJson(COMPACT_ACTIVE_KEY) && !readJson(SAVED_COMPACT_KEY)) {
                writeJson(BEFORE_COMPACT_KEY, placementOf(win))
            }
            const compactBounds = centeredIn(area, COMPACT_SIZE)
            if (win.isMaximized()) {
                win.unmaximize()
            }
            // Opened at the compact size already: leave it alone rather than nudge it
            if (!sameBounds(win.getBounds(), compactBounds)) {
                win.setBounds(compactBounds)
            }
            writeJson(COMPACT_ACTIVE_KEY, true)
            this.compact = true
        })
    }

    /**
     * Right before the window closes. Tabby's main process saves the size the window has
     * when it closes and opens the next window (also at the next start) at that size,
     * before any plugin runs. So with the launcher at startup the window is made invisible
     * and given the launcher's size first: the next start opens small, without a full-size
     * window first. `forLauncher` is false when the next start doesn't show the launcher.
     */
    async beforeWindowGoes (forLauncher: boolean): Promise<void> {
        this.save()
        const win = this.nativeWindow()
        const area = win && screen()?.getDisplayMatching(win.getBounds()).workArea
        if (!forLauncher || !win || !area || !RESIZE_UNSEEN_PLATFORMS.includes(process.platform)
            || win.isMinimized() || win.isFullScreen()) {
            // Tabby saves this window's own size
            localStorage.removeItem(SAVED_COMPACT_KEY)
            return
        }
        this.safely(() => {
            // The size to grow back to when the next launcher is left without a workspace
            if (!this.compact) {
                writeJson(BEFORE_COMPACT_KEY, placementOf(win))
            }
            writeJson(SAVED_COMPACT_KEY, true)
            win.setOpacity(0)
            if (win.isMaximized()) {
                win.unmaximize()
            }
            win.setBounds(centeredIn(area, COMPACT_SIZE))
        })
        await new Promise(resolve => setTimeout(resolve, RESIZE_SETTLE_MS))
    }

    /**
     * Another window is about to open. If Tabby saved the launcher's size at a close, the
     * new window would open small; give it the real size from before, as Tabby would.
     */
    beforeNewWindow (): void {
        const placement = readJson(SAVED_COMPACT_KEY) ? readPlacement(BEFORE_COMPACT_KEY) : null
        if (placement) {
            this.safely(() => {
                this.compat.writeSavedWindowState(placement)
                localStorage.removeItem(SAVED_COMPACT_KEY)
            })
        }
    }

    /** Back to full size after the launcher, when no workspace was picked (guest mode, Esc) */
    leaveCompact (): void {
        if (this.compact) {
            this.safely(() => this.apply(readPlacement(BEFORE_COMPACT_KEY)))
        }
    }

    /** A workspace was loaded: put its window where it was last time */
    private restore (workspaceId: string): void {
        const saved = readPlacement(PLACEMENT_PREFIX + workspaceId)
        if (saved || this.compact) {
            this.apply(saved ?? readPlacement(BEFORE_COMPACT_KEY))
        }
    }

    private apply (placement: Placement | null): void {
        const win = this.nativeWindow()
        const wasCompact = this.compact
        this.compact = false
        if (wasCompact) {
            localStorage.removeItem(COMPACT_ACTIVE_KEY)
        }
        if (!win || win.isFullScreen()) {
            return
        }
        const areas = screen()?.getAllDisplays().map(x => x.workArea) ?? []
        if (!placement || !isVisibleOn(placement.bounds, areas)) {
            // Nothing to go back to, or its screen is gone: a compact window fills its screen
            if (wasCompact) {
                win.maximize()
            }
            return
        }
        if (win.isMaximized()) {
            win.unmaximize()
        }
        win.setBounds(placement.bounds)
        if (placement.maximized) {
            win.maximize()
        }
    }

    private nativeWindow (): NativeWindow | null {
        return this.compat.getNativeWindow()
    }

    private safely (action: () => void): void {
        try {
            action()
        } catch (error) {
            this.errors.log('window placement failed', error)
        }
    }
}

function placementOf (win: NativeWindow): Placement {
    return { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
}

/** A size centered in the area, shrunk to fit it */
export function centeredIn (area: Bounds, size: { width: number, height: number }): Bounds {
    const width = Math.min(size.width, area.width)
    const height = Math.min(size.height, area.height)
    return {
        x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(area.y + (area.height - height) / 2),
        width,
        height,
    }
}

/** Whether two window rectangles are the same, give or take a few pixels of frame */
export function sameBounds (a: Bounds, b: Bounds): boolean {
    return Math.abs(a.x - b.x) <= SAME_BOUNDS_PX && Math.abs(a.y - b.y) <= SAME_BOUNDS_PX
        && Math.abs(a.width - b.width) <= SAME_BOUNDS_PX && Math.abs(a.height - b.height) <= SAME_BOUNDS_PX
}

/** Whether enough of the window is on one of the screens to grab it */
export function isVisibleOn (bounds: Bounds, areas: Bounds[]): boolean {
    return areas.some(area => {
        const width = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
        const height = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
        return width >= MIN_VISIBLE_PX && height >= MIN_VISIBLE_PX / 2
    })
}

export function parsePlacement (value: unknown): Placement | null {
    const bounds = (value as any)?.bounds
    const valid = bounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))
        && bounds.width > 0 && bounds.height > 0
    return valid ? { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, maximized: !!(value as any).maximized } : null
}

function readPlacement (key: string): Placement | null {
    return parsePlacement(readJson(key))
}

function readJson (key: string): unknown {
    try {
        return JSON.parse(localStorage.getItem(key) ?? 'null')
    } catch {
        return null
    }
}

function writeJson (key: string, value: unknown): void {
    localStorage.setItem(key, JSON.stringify(value))
}

function screen (): typeof import('@electron/remote').screen | null {
    try {
        return require('@electron/remote').screen
    } catch {
        return null
    }
}
