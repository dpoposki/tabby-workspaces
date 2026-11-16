import { Injectable, NgZone } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { Subject } from 'rxjs'
import {
    AppService, BaseTabComponent, ConfigService, HostAppService, HostWindowService,
    NotificationsService, PlatformService, PromptModalComponent,
    SelectorService, TabRecoveryService,
} from 'tabby-core'
import { EXPORT_FORMAT, ExportFile, newId, PinMeta, PinRecord, plural, Workspace, WORKSPACE_COLORS } from './models'
import { workspacesSettings } from './config'
import { WorkspaceStore } from './store'
import { ErrorReporter } from './errors'
import { patchMethod } from './patch'
import { WindowRegistry } from './registry'
import { TaskbarIdentity } from './taskbar'
import {
    buildTmuxCommand, getTerminal, getWslTarget, killTmuxSession, lookupWslCwds, stripWslTagFromEnv,
    tagWslShells, tmuxSessionName, waitForPrompt, waitForSession, wslUncPath,
} from './terminal'

const SAVE_DEBOUNCE_MS = 800
/** Periodic save so working directories stay fresh */
const SAVE_INTERVAL_MS = 10_000
/** Set once the plugin has given back Tabby's "restore tabs" setting, which older versions switched off */
/** Lets Tabby finish its own startup before a handed-off workspace is restored */
const STARTUP_DELAY_MS = 300
const STRIPE_HEIGHT_PX = 3
const RECOVER_TABS_RESTORED_KEY = 'tabbyWorkspaces.recoverTabsRestored'

@Injectable({ providedIn: 'root' })
export class WorkspacesService {
    /** Workspace shown in this window, or null for a plain (unsaved) window */
    current: Workspace | null = null
    /** Fires when a workspace is loaded into this window */
    readonly attached$ = new Subject<Workspace>()

    private meta = new WeakMap<BaseTabComponent, PinMeta>()
    /** Pins that could not be restored (e.g. their profile is gone); kept so they aren't silently lost */
    private unrestorable: PinRecord[] = []
    private restoring = false
    private closing = false
    private saveTimer: any = null
    private styleElement: HTMLStyleElement | null = null
    private initialized = false
    private taskbar: TaskbarIdentity

    constructor (
        private app: AppService,
        private config: ConfigService,
        private hostApp: HostAppService,
        private hostWindow: HostWindowService,
        private tabRecovery: TabRecoveryService,
        private selector: SelectorService,
        private platform: PlatformService,
        private notifications: NotificationsService,
        private ngbModal: NgbModal,
        private store: WorkspaceStore,
        private registry: WindowRegistry,
        private zone: NgZone,
        private errors: ErrorReporter,
    ) {
        this.taskbar = new TaskbarIdentity(hostApp, hostWindow, platform)
    }

    init (): void {
        if (this.initialized) {
            return
        }
        this.initialized = true

        // Each patch is independent: if a Tabby update removes what one relies on, only that feature stops
        const failed = [
            ['WSL working directories', () => tagWslShells()],
            ['saving pins', () => this.patchAppService()],
            ['window titles', () => this.patchWindowTitle()],
            ['multi-window tab recovery', () => this.disableBuiltinTabRecovery()],
        ].filter(([, install]) => !this.tryInstall(install as () => boolean)).map(([name]) => name)
        if (failed.length) {
            setTimeout(() => this.notifications.error(
                'Workspaces: not fully compatible with this Tabby version',
                `Disabled: ${failed.join(', ')}.`,
            ), 3000)
        }

        this.app.tabOpened$.subscribe(tab => this.watchTab(tab))
        this.app.tabsChanged$.subscribe(() => this.scheduleSave())
        this.app.tabClosed$.subscribe(() => this.scheduleSave())
        this.config.changed$.subscribe(() => this.applyWindowChrome())
        setInterval(() => this.scheduleSave(), SAVE_INTERVAL_MS)

        this.registry.focusRequested$.subscribe(() => this.zone.run(() => this.hostWindow.bringToFront()))
        this.store.listChangedElsewhere$.subscribe(() => this.zone.run(() => this.onListChangedElsewhere()))
        this.store.corrupted$.subscribe(({ key, backupKey }) => this.zone.run(() => this.notifications.error(
            'Workspaces: stored data was unreadable',
            `It was set aside under "${backupKey}" in Tabby's local storage (was "${key}").`,
        )))

        this.app.ready$.subscribe(() => {
            setTimeout(() => this.onAppReady().catch(error => this.errors.report('Workspaces: startup failed', error)), STARTUP_DELAY_MS)
        })
    }

    // ---------------------------------------------------------------- startup

    private tryInstall (install: () => boolean | void): boolean {
        try {
            return install() !== false
        } catch (error) {
            this.errors.log('patch failed', error)
            return false
        }
    }

    private async onAppReady (): Promise<void> {
        await this.config.ready$.toPromise()
        this.restoreRecoverTabsSetting()

        const handoffId = this.store.takeHandoff()
        const handoff = handoffId ? this.store.get(handoffId) : null
        if (handoff) {
            const openElsewhere = await this.registry.openElsewhere()
            if (openElsewhere.has(handoff.id)) {
                this.registry.requestFocus(handoff.id)
                this.closeWindowIfEmpty()
            } else {
                await this.attach(handoff.id)
            }
        }
        // Otherwise the window starts as a plain window; the start page entries and the
        // toolbar badge open the launcher (the first window shows it via the CLI handler).
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

    /** Earlier versions of the plugin turned the setting off in the user's config; turn it back on once. */
    private restoreRecoverTabsSetting (): void {
        if (window.localStorage.getItem(RECOVER_TABS_RESTORED_KEY)) {
            return
        }
        window.localStorage.setItem(RECOVER_TABS_RESTORED_KEY, '1')
        if (this.config.store.recoverTabs === false) {
            this.config.store.recoverTabs = true
            this.config.save()
        }
    }

    // ---------------------------------------------------------------- workspace actions

    /**
     * Loads the workspace into this window if it has none yet, opens it in a new window
     * otherwise, or brings its window to the front if it's already open somewhere.
     * `workspace` may be a stale copy (e.g. a launcher card); only its id is used.
     */
    async openWorkspace (workspace: Workspace): Promise<void> {
        if (workspace.id === this.current?.id) {
            return
        }
        if (!this.store.get(workspace.id)) {
            this.notifications.info(`Workspace "${workspace.name}" no longer exists`, 'It was deleted in another window.')
            return
        }
        const openElsewhere = await this.registry.openElsewhere()
        if (openElsewhere.has(workspace.id)) {
            this.registry.requestFocus(workspace.id)
            if (!this.current) {
                this.closeWindowIfEmpty()
            }
            return
        }
        if (!this.current) {
            await this.attach(workspace.id)
        } else {
            this.store.setHandoff(workspace.id)
            this.hostApp.newWindow()
        }
    }

    async createWorkspace (name: string, color: string): Promise<void> {
        const workspace: Workspace = { id: newId(), name, color, createdAt: Date.now() }
        this.store.upsert(workspace)
        if (!this.current) {
            await this.attach(workspace.id)
        } else {
            await this.openWorkspace(workspace)
        }
    }

    /** Other windows showing this workspace pick the change up through the storage event. */
    async renameWorkspace (workspace: Workspace): Promise<boolean> {
        const name = await this.prompt('Rename workspace', workspace.name)
        if (!name || name === workspace.name) {
            return false
        }
        this.updateWorkspace(workspace.id, { name })
        return true
    }

    async changeColor (workspace: Workspace): Promise<boolean> {
        const color = await this.pickColor(workspace.color)
        if (color === workspace.color) {
            return false
        }
        this.updateWorkspace(workspace.id, { color })
        return true
    }

    private updateWorkspace (id: string, changes: Partial<Workspace>): void {
        const updated = this.store.update(id, changes)
        if (updated && this.current?.id === id) {
            this.current = updated
            this.applyWindowChrome()
        }
    }

    /** Workspaces open in a window (this one or another) can't be deleted */
    async canDelete (workspace: Workspace): Promise<boolean> {
        const openElsewhere = await this.registry.openElsewhere()
        return workspace.id !== this.current?.id && !openElsewhere.has(workspace.id)
    }

    /** Asks for confirmation; returns whether it was deleted. */
    async deleteWorkspace (workspace: Workspace): Promise<boolean> {
        if (!await this.canDelete(workspace)) {
            this.notifications.info('Workspace is open', 'Close its window before deleting it.')
            return false
        }
        const pinCount = this.store.getPins(workspace.id).length
        const answer = await this.platform.showMessageBox({
            type: 'warning',
            message: `Delete workspace "${workspace.name}"?`,
            detail: `Its ${plural(pinCount, 'pinned tab')} will be forgotten. This cannot be undone.`,
            buttons: ['Delete', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
        })
        if (answer.response !== 0) {
            return false
        }
        // It may have been opened somewhere while the question was up
        if (!await this.canDelete(workspace)) {
            this.notifications.info('Workspace is open', 'It was opened while you were deciding; close its window first.')
            return false
        }
        this.store.remove(workspace.id)
        this.notifications.notice(`Workspace "${workspace.name}" deleted`)
        return true
    }

    // ---------------------------------------------------------------- attach & restore

    /** Loads the workspace as it is stored now (never a caller's copy, which may be stale). */
    private async attach (id: string): Promise<void> {
        const workspace = this.store.update(id, { lastOpenedAt: Date.now() })
        if (!workspace) {
            this.notifications.info('That workspace no longer exists', 'It was deleted in another window.')
            return
        }
        this.current = workspace
        this.registry.currentId = workspace.id
        this.applyWindowChrome()
        this.attached$.next(this.current)

        this.restoring = true
        this.unrestorable = []
        try {
            for (const pin of this.store.getPins(workspace.id)) {
                const tab = await this.restorePin(pin)
                if (!tab) {
                    this.unrestorable.push(pin)
                }
            }
        } finally {
            this.restoring = false
        }
        if (this.unrestorable.length) {
            this.notifications.error(
                `${plural(this.unrestorable.length, 'pinned tab')} could not be restored`,
                'They are kept in the workspace and will be retried next time.',
            )
        }
        const firstPinned = this.app.tabs.find(x => x.pinned)
        if (firstPinned) {
            this.app.selectTab(firstPinned)
        }
        this.scheduleSave()
    }

    private async restorePin (pin: PinRecord): Promise<BaseTabComponent | null> {
        try {
            const params = await this.tabRecovery.recoverTab(pin.token)
            if (!params) {
                return null
            }
            const tab = this.app.openNewTabRaw(params)
            if (!tab.pinned) {
                this.app.pinTab(tab)
            }
            const { token: _token, ...meta }: PinRecord = pin
            this.meta.set(tab, meta)
            this.runStartup(tab, meta).catch(error => this.errors.log('startup command failed', error))
            return tab
        } catch (error) {
            this.errors.log(`could not restore pin ${pin.id}`, error)
            return null
        }
    }

    /** Types the pin's tmux attach and/or startup command into a freshly restored tab. */
    private async runStartup (tab: BaseTabComponent, meta: PinMeta): Promise<void> {
        if (!meta.startupCommand && !meta.tmux) {
            return
        }
        const terminal = await waitForSession(tab)
        if (!terminal) {
            return
        }
        await waitForPrompt(terminal.session)
        const command = meta.tmux && this.current && getWslTarget(terminal)
            ? buildTmuxCommand(tmuxSessionName(this.current.id, meta.id), meta.startupCommand)
            : meta.startupCommand
        if (command) {
            terminal.sendInput(command + '\r')
        }
    }

    // ---------------------------------------------------------------- pin settings (used by the tab context menu)

    getMeta (tab: BaseTabComponent): PinMeta {
        let meta = this.meta.get(tab)
        if (!meta) {
            meta = { id: newId() }
            this.meta.set(tab, meta)
        }
        return meta
    }

    async editStartupCommand (tab: BaseTabComponent): Promise<void> {
        const meta = this.getMeta(tab)
        const value = await this.prompt('Command to run when this tab is restored (leave empty for none)', meta.startupCommand ?? '', true)
        if (value === null) {
            return
        }
        meta.startupCommand = value || undefined
        this.scheduleSave()
    }

    async setTmux (tab: BaseTabComponent, enabled: boolean): Promise<void> {
        const meta = this.getMeta(tab)
        const terminal = getTerminal(tab)
        const target = getWslTarget(terminal)
        if (!this.current || !target) {
            return
        }
        const name = tmuxSessionName(this.current.id, meta.id)
        if (enabled) {
            meta.tmux = true
            this.scheduleSave()
            const answer = await this.platform.showMessageBox({
                type: 'warning',
                message: 'Start the tmux session in this tab now?',
                detail: 'The session survives closing the window. If you choose "Next time", tmux starts when this workspace is opened again.\n\nOnly start now if the tab is at a shell prompt.',
                buttons: ['Start now', 'Next time'],
                defaultId: 0,
                cancelId: 1,
            })
            if (answer.response === 0) {
                terminal.sendInput(buildTmuxCommand(name, meta.startupCommand) + '\r')
            }
        } else {
            const answer = await this.platform.showMessageBox({
                type: 'warning',
                message: 'Stop the persistent session?',
                detail: 'The tmux session for this tab is ended now, along with anything running in it.',
                buttons: ['Stop session', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
            })
            if (answer.response !== 0) {
                return
            }
            meta.tmux = false
            killTmuxSession(target, name)
            this.scheduleSave()
        }
    }

    // ---------------------------------------------------------------- saving

    private watchTab (tab: BaseTabComponent): void {
        tab.recoveryStateChangedHint$.subscribe(() => this.scheduleSave())
        tab.destroyed$.subscribe(() => this.onTabDestroyed(tab))
    }

    private onTabDestroyed (tab: BaseTabComponent): void {
        const meta = this.meta.get(tab)
        // A pinned tab closing with its window keeps its session; anything else means the pin is gone.
        if (!meta?.tmux || !this.current || (this.closing && tab.pinned)) {
            return
        }
        const target = getWslTarget(getTerminal(tab))
        if (target) {
            killTmuxSession(target, tmuxSessionName(this.current.id, meta.id))
        }
    }

    private scheduleSave (): void {
        if (!this.current || this.restoring || this.closing) {
            return
        }
        clearTimeout(this.saveTimer)
        this.saveTimer = setTimeout(() => this.save().catch(error => this.errors.reportOnce('Workspaces: pinned tabs could not be saved', error)), SAVE_DEBOUNCE_MS)
    }

    async save (): Promise<void> {
        const workspace = this.current
        if (!workspace || this.restoring || this.closing) {
            return
        }
        const pinnedTabs = this.app.tabs.filter(x => x.pinned)
        const wslCwds = await lookupWslCwds(pinnedTabs.map(x => getTerminal(x)))
        const pins: PinRecord[] = []
        for (const tab of pinnedTabs) {
            const meta = this.getMeta(tab)
            const token = await this.tabRecovery.getFullRecoveryToken(tab, { includeState: false })
            if (!token) {
                continue
            }
            token.tabPinned = true
            const terminal = getTerminal(tab)
            const options = terminalTokenOf(token)?.profile?.options
            if (options?.env) {
                options.env = stripWslTagFromEnv(options.env)
            }
            const wslCwd = wslCwds.get(terminal)
            if (wslCwd && options) {
                options.cwd = wslCwd
            } else {
                normalizeWslCwd(options, getWslTarget(terminal))
            }
            pins.push({ ...meta, token })
        }
        // The window may have started closing while tokens were collected
        if (this.closing || this.current?.id !== workspace.id) {
            return
        }
        this.store.setPins(workspace.id, [...pins, ...this.unrestorable])
    }

    // ---------------------------------------------------------------- patches on Tabby internals

    /** Returns false if this Tabby lacks what the workspaces need (tab pinning, closeWindow). */
    private patchAppService (): boolean {
        const app = this.app
        if (typeof app.pinTab !== 'function' || typeof app.unpinTab !== 'function' || typeof app.closeWindow !== 'function') {
            return false
        }

        // Every pin path (context menu, hotkey) goes through pinTab, so this is where we ask for a name
        patchMethod(app, 'pinTab', original => (tab: BaseTabComponent) => {
            const wasPinned = tab.pinned
            original(tab)
            if (!wasPinned && tab.pinned && this.current && !this.restoring) {
                this.getMeta(tab)
                setTimeout(() => app.renameTab(tab))
            }
            this.scheduleSave()
        })

        patchMethod(app, 'unpinTab', original => (tab: BaseTabComponent) => {
            original(tab)
            this.scheduleSave()
        })

        // Closing the window must not be mistaken for "the user removed all pins"
        patchMethod(app, 'closeWindow', original => async () => {
            clearTimeout(this.saveTimer)
            await this.save().catch(error => this.errors.log('save on close failed', error))
            this.closing = true
            try {
                await original()
            } finally {
                if (app.tabs.length) {
                    this.closing = false // close was cancelled
                }
            }
        })
        return true
    }

    /** Prefixes the OS window title with the workspace name, so windows are easy to tell apart in the taskbar. */
    private patchWindowTitle (): boolean {
        return patchMethod(this.hostWindow, 'setTitle', original => (title?: string) => {
            if (!this.current) {
                return original(title)
            }
            return original(title ? `[${this.current.name}] ${title}` : this.current.name)
        })
    }

    private applyWindowChrome (): void {
        if (!this.styleElement) {
            this.styleElement = document.createElement('style')
            document.head.appendChild(this.styleElement)
        }
        const settings = workspacesSettings(this.config)
        const color = settings.colorStripe ? this.current?.color : undefined
        this.styleElement.textContent = color
            ? `body::after { content: ''; position: fixed; left: 0; right: 0; top: 0; height: ${STRIPE_HEIGHT_PX}px;
                 background: ${color}; z-index: 100000; pointer-events: none; }`
            : ''
        const tab = this.app.activeTab
        this.hostWindow.setTitle(tab ? tab.customTitle || tab.title : undefined)
        this.taskbar.apply(this.current, settings.taskbarIcon)
            .catch(error => this.errors.log('taskbar icon failed', error))
    }

    private onListChangedElsewhere (): void {
        if (!this.current) {
            return
        }
        const fresh = this.store.get(this.current.id)
        if (!fresh) {
            // Removed elsewhere (e.g. an import with "Replace") while open here: this window still
            // has its pins, so put it back rather than lose them when the window closes
            this.store.upsert(this.current)
            return
        }
        if (fresh.name !== this.current.name || fresh.color !== this.current.color) {
            this.current = fresh
            this.applyWindowChrome()
        }
    }

    // ---------------------------------------------------------------- export / import

    async exportWorkspaces (): Promise<void> {
        await this.save()
        const data: ExportFile = {
            format: EXPORT_FORMAT,
            version: 1,
            exportedAt: new Date().toISOString(),
            workspaces: this.store.list().map(x => ({ ...x, pins: this.store.getPins(x.id) })),
        }
        const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2))
        const date = new Date().toISOString().slice(0, 10)
        const download = await this.platform.startDownload(`tabby-workspaces-${date}.json`, 0o600, bytes.length)
        if (!download) {
            return
        }
        await download.write(bytes)
        download.close()
        this.notifications.notice(`Exported ${plural(data.workspaces.length, 'workspace')}`)
    }

    async importWorkspaces (): Promise<void> {
        const [file] = await this.platform.startUpload({ multiple: false })
        if (!file) {
            return
        }
        const chunks: Uint8Array[] = []
        for (;;) {
            const chunk = await file.read()
            if (!chunk.length) {
                break
            }
            chunks.push(chunk)
        }
        file.close()

        let data: ExportFile
        try {
            data = JSON.parse(new TextDecoder().decode(concat(chunks)))
        } catch {
            this.notifications.error('Import failed', 'The file is not valid JSON.')
            return
        }
        if (data?.format !== EXPORT_FORMAT || !Array.isArray(data.workspaces)) {
            this.notifications.error('Import failed', 'This is not a Tabby workspaces export.')
            return
        }

        let mode: 'merge' | 'replace'
        try {
            mode = await this.selector.show(`Import ${plural(data.workspaces.length, 'workspace')}`, [
                { name: 'Merge', description: 'Add them to your workspaces; ones from an earlier export of this machine are updated', result: 'merge' as const },
                { name: 'Replace', description: 'Delete all existing workspaces first', result: 'replace' as const },
            ])
        } catch {
            return
        }

        const open = await this.registry.openElsewhere()
        if (this.current) {
            open.add(this.current.id)
        }
        if (mode === 'replace') {
            for (const existing of this.store.list()) {
                if (!open.has(existing.id)) {
                    this.store.remove(existing.id)
                }
            }
        }
        const skipped: string[] = []
        let imported = 0
        for (const { pins, ...workspace } of data.workspaces) {
            if (!workspace.id || !workspace.name) {
                continue
            }
            if (open.has(workspace.id)) {
                skipped.push(workspace.name)
                continue
            }
            this.store.upsert({ ...workspace, color: workspace.color || WORKSPACE_COLORS[0].value })
            this.store.setPins(workspace.id, Array.isArray(pins) ? pins : [])
            imported++
        }
        if (skipped.length) {
            this.notifications.info(`Imported ${plural(imported, 'workspace')}`, `Skipped because they are open right now: ${skipped.join(', ')}`)
        } else {
            this.notifications.notice(`Imported ${plural(imported, 'workspace')}`)
        }
    }

    // ---------------------------------------------------------------- helpers

    /** Default color for the next new workspace, cycling through the palette */
    nextColor (): string {
        return WORKSPACE_COLORS[this.store.list().length % WORKSPACE_COLORS.length].value
    }

    sortedWorkspaces (): Workspace[] {
        return this.store.list().sort((a, b) => (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt))
    }

    private async pickColor (current: string): Promise<string> {
        try {
            return await this.selector.show('Workspace color', WORKSPACE_COLORS.map(x => ({
                name: x.name,
                description: x.value === current ? 'Current' : undefined,
                color: x.value,
                icon: 'fas fa-circle',
                result: x.value,
            })))
        } catch {
            return current
        }
    }

    /** Returns the entered text, '' if emptied (when allowEmpty), or null if cancelled. */
    private async prompt (text: string, value = '', allowEmpty = false): Promise<string | null> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = text
        modal.componentInstance.value = value
        const result = await modal.result.catch(() => null)
        if (!result) {
            return null
        }
        const trimmed = (result.value ?? '').trim()
        return trimmed || allowEmpty ? trimmed : null
    }

    private closeWindowIfEmpty (): void {
        if (!this.app.tabs.length) {
            this.hostWindow.close()
        }
    }
}

/**
 * A top-level tab's token is a split container ({ type: 'app:split-tab', children: [...] });
 * the terminal's own token (with the profile and cwd) is its first leaf, matching getTerminal().
 */
function terminalTokenOf (token: any): any | null {
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

/**
 * Fallback when the /proc lookup can't resolve a tab: a shell that reports its cwd itself
 * (OSC 1337 CurrentDir) reports a Linux path, which Tabby only maps to a Windows path when
 * the profile has an fsBase. Store it as \\wsl.localhost\<distro>\... so it survives restore.
 */
function normalizeWslCwd (options: any, target: { args: string[] } | null): void {
    const cwd: unknown = options?.cwd
    const distro = target?.args[1]
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || options.fsBase || !distro) {
        return
    }
    options.cwd = wslUncPath(distro, cwd)
}

function concat (chunks: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(chunks.reduce((sum, x) => sum + x.length, 0))
    let offset = 0
    for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
    }
    return result
}
