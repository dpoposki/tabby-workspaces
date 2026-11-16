import { Injectable, NgZone } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import {
    AppService, BaseTabComponent, ConfigService, HostAppService, HostWindowService,
    NotificationsService, PlatformService, PromptModalComponent, SelectorOption,
    SelectorService, TabRecoveryService,
} from 'tabby-core'
import { ExportFile, newId, PinMeta, PinRecord, Workspace, WORKSPACE_COLORS } from './models'
import { LIST_KEY, WorkspaceStore } from './store'
import { WindowRegistry } from './registry'
import {
    buildTmuxCommand, getTerminal, getWslTarget, killTmuxSession,
    tmuxSessionName, waitForPrompt, waitForSession,
} from './terminal'

const SAVE_DEBOUNCE_MS = 800
/** Periodic save so working directories stay fresh */
const SAVE_INTERVAL_MS = 10_000

@Injectable({ providedIn: 'root' })
export class WorkspacesService {
    /** Workspace shown in this window, or null for a plain (unsaved) window */
    current: Workspace | null = null

    private meta = new WeakMap<BaseTabComponent, PinMeta>()
    /** Pins that could not be restored (e.g. their profile is gone); kept so they aren't silently lost */
    private unrestorable: PinRecord[] = []
    private restoring = false
    private closing = false
    private saveTimer: any = null
    private styleElement: HTMLStyleElement | null = null
    private initialized = false

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
    ) { }

    init (): void {
        if (this.initialized) {
            return
        }
        this.initialized = true

        this.patchAppService()
        this.patchWindowTitle()

        this.app.tabOpened$.subscribe(tab => this.watchTab(tab))
        this.app.tabsChanged$.subscribe(() => this.scheduleSave())
        this.app.tabClosed$.subscribe(() => this.scheduleSave())
        setInterval(() => this.scheduleSave(), SAVE_INTERVAL_MS)

        this.registry.focusRequested$.subscribe(() => this.zone.run(() => this.hostWindow.bringToFront()))
        window.addEventListener('storage', event => {
            if (event.key === LIST_KEY) {
                this.zone.run(() => this.onListChangedElsewhere())
            }
        })

        this.app.ready$.subscribe(() => {
            // Let Tabby finish its own startup before showing the picker
            setTimeout(() => this.onAppReady().catch(error => console.error('[workspaces] startup failed', error)), 300)
        })
    }

    // ---------------------------------------------------------------- startup

    private async onAppReady (): Promise<void> {
        await this.config.ready$.toPromise()
        this.disableBuiltinTabRecovery()

        const handoffId = this.store.takeHandoff()
        const handoff = handoffId ? this.store.get(handoffId) : null
        if (handoff) {
            const openElsewhere = await this.registry.openElsewhere()
            if (openElsewhere.has(handoff.id)) {
                this.registry.requestFocus(handoff.id)
                this.closeWindowIfEmpty()
            } else {
                await this.attach(handoff)
            }
            return
        }
        await this.showPicker('startup')
    }

    /** Tabby's own "restore tabs" only works for a single window and would fight with workspaces. */
    private disableBuiltinTabRecovery (): void {
        if (this.config.store.recoverTabs !== false) {
            this.config.store.recoverTabs = false
            this.config.save()
        }
    }

    // ---------------------------------------------------------------- picker & menu

    /**
     * startup: shown when a window opens without a workspace; picking one loads it here.
     * open:    "open another workspace"; picking one opens it in a new window
     *          (or here, if this window has no workspace yet).
     */
    async showPicker (mode: 'startup' | 'open'): Promise<void> {
        const openElsewhere = await this.registry.openElsewhere()
        const workspaces = this.sortedWorkspaces()
        type Choice = { kind: 'workspace', workspace: Workspace } | { kind: 'none' }

        const options: SelectorOption<Choice>[] = workspaces.map(workspace => {
            const isHere = workspace.id === this.current?.id
            const isOpen = openElsewhere.has(workspace.id)
            const pinCount = this.store.getPins(workspace.id).length
            return {
                name: workspace.name,
                description: isHere ? 'This window' : isOpen ? 'Already open, switch to its window' : `${pinCount} pinned tab${pinCount === 1 ? '' : 's'}`,
                color: workspace.color,
                icon: 'fas fa-circle',
                result: { kind: 'workspace', workspace },
            }
        })
        options.push({
            name: 'New workspace',
            freeInputPattern: 'Create workspace "%s"',
            icon: 'fas fa-plus',
            callback: name => {
                if (name?.trim()) {
                    this.createWorkspace(name.trim(), mode).catch(e => this.notifications.error('Could not create workspace', String(e)))
                }
            },
        })
        if (mode === 'startup') {
            options.push({
                name: 'Continue without a workspace',
                description: 'Tabs in this window will not be saved',
                icon: 'fas fa-times',
                result: { kind: 'none' },
            })
        }

        const title = mode === 'startup' ? 'Open workspace (type a name to create one)' : 'Open another workspace'
        let choice: Choice | undefined
        try {
            choice = await this.selector.show(title, options)
        } catch {
            return // dismissed
        }
        if (choice?.kind !== 'workspace') {
            return
        }
        await this.openWorkspace(choice.workspace, openElsewhere)
    }

    async openWorkspace (workspace: Workspace, openElsewhere?: Set<string>): Promise<void> {
        if (workspace.id === this.current?.id) {
            return
        }
        openElsewhere ??= await this.registry.openElsewhere()
        if (openElsewhere.has(workspace.id)) {
            this.registry.requestFocus(workspace.id)
            if (!this.current) {
                this.closeWindowIfEmpty()
            }
            return
        }
        if (!this.current) {
            await this.attach(workspace)
        } else {
            this.store.setHandoff(workspace.id)
            this.hostApp.newWindow()
        }
    }

    async showMenu (): Promise<void> {
        const options: SelectorOption<() => Promise<void>>[] = [
            { name: 'Open another workspace…', icon: 'fas fa-window-restore', result: () => this.showPicker('open') },
            { name: 'New workspace…', icon: 'fas fa-plus', result: () => this.promptNewWorkspace() },
        ]
        if (this.current) {
            options.push(
                { name: 'Rename this workspace…', icon: 'fas fa-pen', result: () => this.renameCurrent() },
                { name: 'Change color…', icon: 'fas fa-palette', result: () => this.changeCurrentColor() },
            )
        }
        options.push(
            { name: 'Delete a workspace…', icon: 'fas fa-trash', result: () => this.promptDelete() },
            { name: 'Export workspaces…', icon: 'fas fa-file-export', result: () => this.exportWorkspaces() },
            { name: 'Import workspaces…', icon: 'fas fa-file-import', result: () => this.importWorkspaces() },
        )
        let action: (() => Promise<void>) | undefined
        try {
            action = await this.selector.show(this.current ? `Workspace: ${this.current.name}` : 'Workspaces', options)
        } catch {
            return
        }
        await action?.().catch(error => this.notifications.error('Workspace action failed', String(error)))
    }

    // ---------------------------------------------------------------- workspace CRUD

    private async promptNewWorkspace (): Promise<void> {
        const name = await this.prompt('Workspace name')
        if (name) {
            await this.createWorkspace(name, 'open')
        }
    }

    private async createWorkspace (name: string, mode: 'startup' | 'open'): Promise<void> {
        const color = await this.pickColor(WORKSPACE_COLORS[this.store.list().length % WORKSPACE_COLORS.length].value)
        const workspace: Workspace = { id: newId(), name, color, createdAt: Date.now() }
        this.store.upsert(workspace)
        if (mode === 'startup' || !this.current) {
            await this.attach(workspace)
        } else {
            await this.openWorkspace(workspace)
        }
    }

    private async renameCurrent (): Promise<void> {
        if (!this.current) {
            return
        }
        const name = await this.prompt('Rename workspace', this.current.name)
        if (name) {
            this.current = { ...this.current, name }
            this.store.upsert(this.current)
            this.applyWindowChrome()
        }
    }

    private async changeCurrentColor (): Promise<void> {
        if (!this.current) {
            return
        }
        this.current = { ...this.current, color: await this.pickColor(this.current.color) }
        this.store.upsert(this.current)
        this.applyWindowChrome()
    }

    private async promptDelete (): Promise<void> {
        const openElsewhere = await this.registry.openElsewhere()
        const deletable = this.sortedWorkspaces().filter(x => x.id !== this.current?.id && !openElsewhere.has(x.id))
        if (!deletable.length) {
            this.notifications.info('No workspace can be deleted', 'Close a workspace\'s window before deleting it.')
            return
        }
        let workspace: Workspace
        try {
            workspace = await this.selector.show('Delete workspace (open workspaces are not listed)', deletable.map(x => ({
                name: x.name, color: x.color, icon: 'fas fa-circle', result: x,
            })))
        } catch {
            return
        }
        const pinCount = this.store.getPins(workspace.id).length
        const answer = await this.platform.showMessageBox({
            type: 'warning',
            message: `Delete workspace "${workspace.name}"?`,
            detail: `Its ${pinCount} pinned tab${pinCount === 1 ? '' : 's'} will be forgotten. This cannot be undone.`,
            buttons: ['Delete', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
        })
        if (answer.response === 0) {
            this.store.remove(workspace.id)
            this.notifications.notice(`Workspace "${workspace.name}" deleted`)
        }
    }

    // ---------------------------------------------------------------- attach & restore

    private async attach (workspace: Workspace): Promise<void> {
        this.current = { ...workspace, lastOpenedAt: Date.now() }
        this.registry.currentId = workspace.id
        this.store.upsert(this.current)
        this.applyWindowChrome()

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
                `${this.unrestorable.length} pinned tab(s) could not be restored`,
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
            const meta: PinMeta = { id: pin.id, startupCommand: pin.startupCommand, tmux: pin.tmux }
            this.meta.set(tab, meta)
            this.runStartup(tab, meta).catch(error => console.warn('[workspaces] startup command failed', error))
            return tab
        } catch (error) {
            console.warn('[workspaces] could not restore pin', pin, error)
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
        this.saveTimer = setTimeout(() => this.save().catch(error => console.error('[workspaces] save failed', error)), SAVE_DEBOUNCE_MS)
    }

    async save (): Promise<void> {
        const workspace = this.current
        if (!workspace || this.restoring || this.closing) {
            return
        }
        const pins: PinRecord[] = []
        for (const tab of this.app.tabs.filter(x => x.pinned)) {
            const meta = this.getMeta(tab)
            const token = await this.tabRecovery.getFullRecoveryToken(tab, { includeState: false })
            if (!token) {
                continue
            }
            token.tabPinned = true
            pins.push({ id: meta.id, token, startupCommand: meta.startupCommand, tmux: meta.tmux })
        }
        // The window may have started closing while tokens were collected
        if (this.closing || this.current?.id !== workspace.id) {
            return
        }
        this.store.setPins(workspace.id, [...pins, ...this.unrestorable])
    }

    // ---------------------------------------------------------------- patches on Tabby internals

    private patchAppService (): void {
        const app = this.app
        const originalPinTab = app.pinTab.bind(app)
        const originalUnpinTab = app.unpinTab.bind(app)
        const originalCloseWindow = app.closeWindow.bind(app)

        // Every pin path (context menu, hotkey) goes through pinTab, so this is where we ask for a name
        app.pinTab = (tab: BaseTabComponent) => {
            const wasPinned = tab.pinned
            originalPinTab(tab)
            if (!wasPinned && tab.pinned && this.current && !this.restoring) {
                this.getMeta(tab)
                setTimeout(() => app.renameTab(tab))
            }
            this.scheduleSave()
        }

        app.unpinTab = (tab: BaseTabComponent) => {
            originalUnpinTab(tab)
            this.scheduleSave()
        }

        // Closing the window must not be mistaken for "the user removed all pins"
        app.closeWindow = async () => {
            clearTimeout(this.saveTimer)
            await this.save().catch(() => null)
            this.closing = true
            try {
                await originalCloseWindow()
            } finally {
                if (app.tabs.length) {
                    this.closing = false // close was cancelled
                }
            }
        }
    }

    /** Prefixes the OS window title with the workspace name, so windows are easy to tell apart in the taskbar. */
    private patchWindowTitle (): void {
        const hostWindow = this.hostWindow
        const originalSetTitle = hostWindow.setTitle.bind(hostWindow)
        hostWindow.setTitle = (title?: string) => {
            if (!this.current) {
                return originalSetTitle(title)
            }
            return originalSetTitle(title ? `[${this.current.name}] ${title}` : this.current.name)
        }
    }

    private applyWindowChrome (): void {
        if (!this.styleElement) {
            this.styleElement = document.createElement('style')
            document.head.appendChild(this.styleElement)
        }
        const color = this.current?.color
        this.styleElement.textContent = color
            ? `body::after { content: ''; position: fixed; left: 0; right: 0; top: 0; height: 3px;
                 background: ${color}; z-index: 100000; pointer-events: none; }`
            : ''
        const tab = this.app.activeTab
        this.hostWindow.setTitle(tab ? tab.customTitle || tab.title : undefined)
    }

    private onListChangedElsewhere (): void {
        if (!this.current) {
            return
        }
        const fresh = this.store.get(this.current.id)
        if (fresh && (fresh.name !== this.current.name || fresh.color !== this.current.color)) {
            this.current = { ...this.current, name: fresh.name, color: fresh.color }
            this.applyWindowChrome()
        }
    }

    // ---------------------------------------------------------------- export / import

    private async exportWorkspaces (): Promise<void> {
        await this.save()
        const data: ExportFile = {
            format: 'tabby-workspaces',
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
        this.notifications.notice(`Exported ${data.workspaces.length} workspace(s)`)
    }

    private async importWorkspaces (): Promise<void> {
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
        if (data?.format !== 'tabby-workspaces' || !Array.isArray(data.workspaces)) {
            this.notifications.error('Import failed', 'This is not a Tabby workspaces export.')
            return
        }

        let mode: 'merge' | 'replace'
        try {
            mode = await this.selector.show(`Import ${data.workspaces.length} workspace(s)`, [
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
            this.notifications.info(`Imported ${imported} workspace(s)`, `Skipped because they are open right now: ${skipped.join(', ')}`)
        } else {
            this.notifications.notice(`Imported ${imported} workspace(s)`)
        }
    }

    // ---------------------------------------------------------------- helpers

    private sortedWorkspaces (): Workspace[] {
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

function concat (chunks: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(chunks.reduce((sum, x) => sum + x.length, 0))
    let offset = 0
    for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
    }
    return result
}
