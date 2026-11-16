import { Injectable, Injector, NgZone } from '@angular/core'
import { AppService, ConfigService, HostAppService, MenuItemOptions, PlatformService } from 'tabby-core'
import { TerminalService } from 'tabby-local'
import { initialOf, NAME_MAX_LENGTH, plural, safeColor, Workspace, WORKSPACE_COLORS } from './models'
import { WorkspaceStore } from './store'
import { WindowRegistry } from './registry'
import { WorkspacesService } from './workspaces.service'
import { WorkspaceSession } from './session'
import { WorkspaceDialogs } from './dialogs'
import { ErrorReporter } from './errors'
import { workspacesSettings } from './config'

import STYLES from './launcher.css'

const ROOT_ID = 'tabby-workspaces-launcher'
/** Fade-out duration; passed to the CSS as --wl-hide-duration */
const HIDE_MS = 160
/** Cards that get a 1–9 key */
const SHORTCUT_CARDS = 9

/** Cards fade in one after another, the first dozen staggered */
function cardDelay (index: number): string {
    return `${Math.min(index, 12) * 30}ms`
}

/**
 * Full-window workspace chooser, like Chrome's profile picker: one big card per
 * workspace, an "Add" card, "Guest mode" (a plain window) and a "Show on startup" switch.
 * Shown over the first window at startup and from the toolbar badge; plain DOM so it
 * can appear before anything else.
 */
@Injectable({ providedIn: 'root' })
export class WorkspacesLauncher {
    private root: HTMLElement | null = null
    private grid: HTMLElement | null = null
    private subscribed = false

    constructor (
        private app: AppService,
        private config: ConfigService,
        private hostApp: HostAppService,
        private injector: Injector,
        private platform: PlatformService,
        private registry: WindowRegistry,
        private service: WorkspacesService,
        private session: WorkspaceSession,
        private dialogs: WorkspaceDialogs,
        private store: WorkspaceStore,
        private zone: NgZone,
        private errors: ErrorReporter,
    ) { }

    get showOnStartup (): boolean {
        return workspacesSettings(this.config).showLauncher
    }

    show (): void {
        if (this.root) {
            return
        }
        if (!this.subscribed) {
            this.subscribed = true
            // Anything that fills this window (a workspace, a hotkey-opened tab) dismisses the launcher
            this.session.attached$.subscribe(() => this.hide())
            this.app.tabsChanged$.subscribe(() => this.app.tabs.length && this.hide())
            // Renamed, recolored, added or deleted in another window: never show stale cards
            this.store.listChangedElsewhere$.subscribe(() => this.refresh())
        }
        installStyles()
        this.root = this.build()
        document.body.appendChild(this.root)
        this.root.querySelector<HTMLElement>('.wl-card')?.focus()
        this.markOpenElsewhere().catch(() => null)
    }

    hide (): void {
        const root = this.root
        if (!root) {
            return
        }
        this.root = null
        this.grid = null
        root.classList.add('wl-leaving')
        setTimeout(() => root.remove(), HIDE_MS)
    }

    // ---------------------------------------------------------------- actions

    /** On this window's own card it simply closes the launcher (openWorkspace does nothing then) */
    private open (workspace: Workspace): void {
        this.hide()
        this.run(() => this.service.openWorkspace(workspace))
    }

    private create (name: string, color: string): void {
        this.hide()
        this.run(() => this.service.createWorkspace(name, color))
    }

    /** Plain Tabby: a terminal with no workspace, nothing saved */
    private guest (): void {
        this.hide()
        this.run(async () => {
            if (this.session.current || this.app.tabs.length) {
                this.hostApp.newWindow()
            } else {
                await this.injector.get(TerminalService).openTab()
            }
        })
    }

    private setShowOnStartup (value: boolean): void {
        this.zone.run(() => {
            workspacesSettings(this.config).showLauncher = value
            this.config.save()
        })
    }

    /** Chrome-like "⋯" on a card: edit or delete that workspace without leaving the launcher */
    private async showCardMenu (workspace: Workspace, event: MouseEvent): Promise<void> {
        const deletable = await this.service.canDelete(workspace.id)
        const edit = (action: () => Promise<boolean>) => () => this.run(async () => {
            if (await action()) {
                this.refresh()
            }
        })
        const items: MenuItemOptions[] = [
            { label: 'Rename…', click: edit(() => this.dialogs.rename(workspace)) },
            { label: 'Change color…', click: edit(() => this.dialogs.changeColor(workspace)) },
            { type: 'separator' },
            {
                label: deletable ? 'Delete…' : 'Delete… (close its window first)',
                enabled: deletable,
                click: edit(() => this.dialogs.delete(workspace)),
            },
        ]
        this.platform.popupContextMenu(items, event)
    }

    /** Re-render the cards after an edit, keeping the launcher open */
    private refresh (): void {
        if (!this.grid) {
            return
        }
        this.renderCards(this.grid)
        this.grid.querySelectorAll<HTMLElement>('.wl-card').forEach(card => card.style.animation = 'none')
        this.markOpenElsewhere().catch(() => null)
    }

    private run (action: () => Promise<unknown>): void {
        this.errors.run('Workspaces: that didn\'t work', action)
    }

    // ---------------------------------------------------------------- DOM

    private build (): HTMLElement {
        const root = el('div', 'wl-root')
        root.id = ROOT_ID
        root.style.setProperty('--wl-hide-duration', `${HIDE_MS}ms`)
        root.tabIndex = -1
        root.addEventListener('keydown', event => this.onKeyDown(event))

        root.appendChild(el('div', 'wl-drag'))
        if (this.session.current || this.app.tabs.length) {
            // Opened over a window that has content: make the way back obvious
            const close = el('button', 'wl-close') as HTMLButtonElement
            close.innerHTML = CLOSE_ICON
            close.title = 'Back to this window (Esc)'
            close.addEventListener('click', () => this.hide())
            root.appendChild(close)
        }

        const main = el('div', 'wl-main')
        main.appendChild(el('h1', 'wl-title', 'Choose a workspace'))
        main.appendChild(el('p', 'wl-subtitle', 'Each workspace opens with its own pinned tabs, right where you left them.'))

        this.grid = el('div', 'wl-grid')
        this.renderCards(this.grid)
        main.appendChild(this.grid)
        root.appendChild(main)

        const footer = el('div', 'wl-footer')
        const guest = el('button', 'wl-guest')
        guest.innerHTML = GUEST_ICON
        guest.appendChild(el('span', '', 'Guest mode'))
        guest.title = 'Plain Tabby window: no workspace, nothing is saved'
        guest.addEventListener('click', () => this.guest())
        footer.appendChild(guest)

        const toggle = el('label', 'wl-toggle')
        const checkbox = el('input') as HTMLInputElement
        checkbox.type = 'checkbox'
        checkbox.checked = this.showOnStartup
        checkbox.addEventListener('change', () => this.setShowOnStartup(checkbox.checked))
        toggle.appendChild(checkbox)
        toggle.appendChild(el('span', 'wl-switch'))
        toggle.appendChild(el('span', '', 'Show on startup'))
        toggle.title = 'When off, Tabby starts with a plain terminal as usual'
        footer.appendChild(toggle)
        root.appendChild(footer)

        return root
    }

    private renderCards (grid: HTMLElement): void {
        const workspaces = this.service.sortedWorkspaces()
        grid.replaceChildren(...workspaces.map((workspace, index) => this.workspaceCard(workspace, index)), this.addCard(workspaces.length))
    }

    private workspaceCard (workspace: Workspace, index: number): HTMLElement {
        const card = el('button', 'wl-card')
        card.dataset.id = workspace.id
        card.style.setProperty('--wl-color', safeColor(workspace.color))
        card.style.setProperty('--wl-delay', cardDelay(index))
        if (index < SHORTCUT_CARDS) {
            card.appendChild(el('span', 'wl-key', String(index + 1)))
        }
        // A span, not a nested <button> (invalid inside the card button)
        const more = el('span', 'wl-more')
        more.innerHTML = MORE_ICON
        more.title = 'Edit or delete'
        more.setAttribute('role', 'button')
        const menu = (event: MouseEvent) => {
            event.preventDefault()
            event.stopPropagation()
            this.run(() => this.showCardMenu(workspace, event))
        }
        more.addEventListener('click', menu)
        card.appendChild(more)
        card.addEventListener('contextmenu', menu)
        card.appendChild(el('span', 'wl-avatar', initialOf(workspace.name)))
        card.appendChild(el('span', 'wl-name', workspace.name))
        const isCurrent = workspace.id === this.session.current?.id
        card.classList.toggle('wl-current', isCurrent)
        const meta = isCurrent
            ? 'This window'
            : `${plural(this.store.getPins(workspace.id).length, 'pinned tab')} · ${timeAgo(workspace.lastOpenedAt ?? workspace.createdAt)}`
        card.appendChild(el('span', 'wl-meta', meta))
        card.title = workspace.name
        card.addEventListener('click', () => this.open(workspace))
        return card
    }

    private addCard (index: number): HTMLElement {
        const card = el('button', 'wl-card wl-add')
        card.style.setProperty('--wl-delay', cardDelay(index))
        card.appendChild(el('span', 'wl-avatar', '+'))
        card.appendChild(el('span', 'wl-name', 'Add'))
        card.appendChild(el('span', 'wl-meta', 'New workspace'))
        card.addEventListener('click', () => card.replaceWith(this.addForm()))
        return card
    }

    /** The Add card flips into a small form: name + color, no modal on top of the launcher */
    private addForm (): HTMLElement {
        let color = this.service.nextColor()
        const form = el('form', 'wl-card wl-form')
        form.style.setProperty('--wl-color', color)
        const avatar = el('span', 'wl-avatar', '+')
        form.appendChild(avatar)

        const input = el('input', 'wl-input') as HTMLInputElement
        input.placeholder = 'Workspace name'
        input.maxLength = NAME_MAX_LENGTH
        input.addEventListener('input', () => { avatar.textContent = initialOf(input.value, '+') })
        form.appendChild(input)

        const swatches = el('div', 'wl-swatches')
        for (const option of WORKSPACE_COLORS) {
            const swatch = el('button', 'wl-swatch') as HTMLButtonElement
            swatch.type = 'button'
            swatch.title = option.name
            swatch.style.background = option.value
            swatch.classList.toggle('wl-selected', option.value === color)
            swatch.addEventListener('click', () => {
                color = option.value
                form.style.setProperty('--wl-color', color)
                swatches.querySelectorAll('.wl-swatch').forEach(x => x.classList.toggle('wl-selected', x === swatch))
                input.focus()
            })
            swatches.appendChild(swatch)
        }
        form.appendChild(swatches)

        const create = el('button', 'wl-create', 'Create') as HTMLButtonElement
        create.type = 'submit'
        form.appendChild(create)

        form.addEventListener('submit', event => {
            event.preventDefault()
            const name = input.value.trim()
            if (name) {
                this.create(name, color)
            } else {
                input.focus()
            }
        })
        form.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.stopPropagation()
                form.replaceWith(this.addCard(0))
                this.grid?.querySelector<HTMLElement>('.wl-add')?.focus()
            }
        })
        setTimeout(() => input.focus())
        return form
    }

    private onKeyDown (event: KeyboardEvent): void {
        if ((event.target as HTMLElement).tagName === 'INPUT' && (event.target as HTMLInputElement).type !== 'checkbox') {
            return
        }
        if (event.key === 'Escape') {
            this.hide() // leaves the regular start page
            return
        }
        const cards = Array.from(this.grid?.querySelectorAll<HTMLElement>('.wl-card') ?? [])
        const digit = /^[1-9]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey ? Number(event.key) : 0
        if (digit) {
            cards.filter(x => x.dataset.id)[digit - 1]?.click()
            event.preventDefault()
            return
        }
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
        if (step && cards.length) {
            const index = cards.indexOf(document.activeElement as HTMLElement)
            cards[(index + step + cards.length) % cards.length].focus()
            event.preventDefault()
        }
    }

    private async markOpenElsewhere (): Promise<void> {
        const open = await this.registry.openElsewhere()
        for (const id of open) {
            if (id === this.session.current?.id) {
                continue
            }
            const card = this.grid?.querySelector<HTMLElement>(`.wl-card[data-id="${CSS.escape(id)}"]`)
            const meta = card?.querySelector('.wl-meta')
            if (meta) {
                card!.classList.add('wl-open')
                meta.textContent = 'Open in another window'
            }
        }
    }
}

function el (tag: string, className = '', text?: string): HTMLElement {
    const node = document.createElement(tag)
    if (className) {
        node.className = className
    }
    if (text !== undefined) {
        node.textContent = text
    }
    return node
}

function timeAgo (at: number): string {
    const minutes = Math.round((Date.now() - at) / 60_000)
    if (minutes < 1) {
        return 'just now'
    }
    if (minutes < 60) {
        return `${minutes}m ago`
    }
    const hours = Math.round(minutes / 60)
    if (hours < 24) {
        return `${hours}h ago`
    }
    const days = Math.round(hours / 24)
    return days < 30 ? `${days}d ago` : new Date(at).toLocaleDateString()
}

const MORE_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
    <circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/>
</svg>`

const CLOSE_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
    <path d="M4 4l8 8M12 4l-8 8"/>
</svg>`

const GUEST_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3">
    <circle cx="8" cy="5.5" r="2.8"/><path d="M2.5 14.5c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6" stroke-linecap="round"/>
</svg>`

function installStyles (): void {
    if (document.getElementById(`${ROOT_ID}-styles`)) {
        return
    }
    const style = document.createElement('style')
    style.id = `${ROOT_ID}-styles`
    style.textContent = STYLES
    document.head.appendChild(style)
}
