import { Injectable, Injector, NgZone } from '@angular/core'
import { AppService, ConfigService, HostAppService, MenuItemOptions, PlatformService } from 'tabby-core'
import { TerminalService } from 'tabby-local'
import { initialOf, NAME_MAX_LENGTH, plural, safeColor, Workspace, WORKSPACE_COLORS } from './models'
import { WorkspaceStore } from './store'
import { WindowRegistry } from './registry'
import { WorkspacesService } from './workspaces.service'
import { ErrorReporter } from './errors'
import { workspacesSettings } from './config'

const ROOT_ID = 'tabby-workspaces-launcher'
/** Fade-out duration; the CSS transition uses the same value */
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
            this.service.attached$.subscribe(() => this.hide())
            this.app.tabsChanged$.subscribe(() => this.app.tabs.length && this.hide())
            // Renamed, recolored, added or deleted in another window: never show stale cards
            this.store.listChangedElsewhere$.subscribe(() => this.zone.run(() => this.refresh()))
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
            if (this.service.current || this.app.tabs.length) {
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
        const deletable = await this.service.canDelete(workspace)
        const edit = (action: () => Promise<boolean>) => () => this.run(async () => {
            if (await action()) {
                this.refresh()
            }
        })
        const items: MenuItemOptions[] = [
            { label: 'Rename…', click: edit(() => this.service.renameWorkspace(workspace)) },
            { label: 'Change color…', click: edit(() => this.service.changeColor(workspace)) },
            { type: 'separator' },
            {
                label: deletable ? 'Delete…' : 'Delete… (close its window first)',
                enabled: deletable,
                click: edit(() => this.service.deleteWorkspace(workspace)),
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
        root.tabIndex = -1
        root.addEventListener('keydown', event => this.onKeyDown(event))

        root.appendChild(el('div', 'wl-drag'))
        if (this.service.current || this.app.tabs.length) {
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
        const isCurrent = workspace.id === this.service.current?.id
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
            if (id === this.service.current?.id) {
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

const STYLES = `
.wl-root {
    --wl-fg: var(--theme-fg, #e6e6e6);
    --wl-bg: var(--theme-bg, #1b1d23);
    --wl-card: color-mix(in srgb, var(--wl-fg) 6%, transparent);
    --wl-card-hover: color-mix(in srgb, var(--wl-fg) 11%, transparent);
    --wl-muted: color-mix(in srgb, var(--wl-fg) 58%, transparent);
    --wl-line: color-mix(in srgb, var(--wl-fg) 14%, transparent);
    position: fixed; inset: 0; z-index: 1040;
    display: flex; flex-direction: column;
    color: var(--wl-fg);
    background:
        radial-gradient(1200px 600px at 50% -10%, color-mix(in srgb, var(--theme-primary, #3b82f6) 14%, transparent), transparent 70%),
        var(--wl-bg);
    font-family: inherit;
    outline: none;
    animation: wl-fade .2s ease-out;
}
.wl-root.wl-leaving { animation: wl-fade-out ${HIDE_MS}ms ease-in forwards; pointer-events: none; }
.wl-drag { flex: none; height: 38px; -webkit-app-region: drag; }
.wl-main {
    flex: auto; overflow-y: auto; padding: 24px 32px 40px;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.wl-title { margin: 0 0 8px; font-size: 30px; font-weight: 500; letter-spacing: -.01em; text-align: center; }
.wl-subtitle { margin: 0 0 44px; color: var(--wl-muted); font-size: 14px; text-align: center; }
.wl-grid {
    display: flex; flex-wrap: wrap; justify-content: center; gap: 20px;
    max-width: 1000px;
}
.wl-card {
    position: relative; box-sizing: border-box;
    width: 176px; height: 196px; padding: 22px 14px 16px;
    display: flex; flex-direction: column; align-items: center;
    border: 1px solid transparent; border-radius: 8px;
    background: var(--wl-card); color: inherit; font: inherit; text-align: center;
    cursor: pointer; outline: none;
    transition: background .15s, border-color .15s, transform .15s, box-shadow .15s;
    animation: wl-rise .28s ease-out backwards; animation-delay: var(--wl-delay, 0ms);
}
.wl-card:hover, .wl-card:focus-visible {
    background: var(--wl-card-hover);
    border-color: color-mix(in srgb, var(--wl-color, var(--wl-fg)) 70%, transparent);
    transform: translateY(-3px);
    box-shadow: 0 10px 28px -12px color-mix(in srgb, var(--wl-color, #000) 60%, transparent);
}
.wl-card:active { transform: translateY(-1px); }
.wl-avatar {
    flex: none; width: 84px; height: 84px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: var(--wl-color, #6b7280); color: #fff;
    font-size: 36px; font-weight: 600; line-height: 1;
    box-shadow: inset 0 -6px 14px rgba(0,0,0,.18);
    margin-bottom: 16px;
}
.wl-name {
    max-width: 100%; font-size: 15px; font-weight: 500;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wl-meta { margin-top: 5px; font-size: 12px; color: var(--wl-muted); white-space: nowrap; }
.wl-open .wl-meta::before {
    content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 6px; vertical-align: 1px;
    border-radius: 50%; background: var(--theme-success, #22c55e);
}
.wl-key {
    position: absolute; top: 10px; left: 12px;
    font-size: 11px; color: var(--wl-muted); opacity: 0; transition: opacity .15s;
}
.wl-card:hover .wl-key, .wl-card:focus-visible .wl-key { opacity: 1; }
.wl-more {
    position: absolute; top: 6px; right: 6px; width: 26px; height: 26px; border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    color: var(--wl-muted); opacity: 0; transition: opacity .15s, background .15s;
}
.wl-card:hover .wl-more, .wl-card:focus-visible .wl-more { opacity: 1; }
.wl-more:hover { background: var(--wl-card-hover); color: var(--wl-fg); }
.wl-current { border-color: color-mix(in srgb, var(--wl-color) 45%, transparent); }
.wl-current .wl-meta { color: var(--wl-fg); }
.wl-current .wl-meta::before {
    content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 6px; vertical-align: 1px;
    border-radius: 50%; background: var(--wl-color);
}
.wl-close {
    position: absolute; top: 46px; right: 20px; z-index: 1; width: 32px; height: 32px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    border: none; background: transparent; color: var(--wl-muted); cursor: pointer;
}
.wl-close:hover, .wl-close:focus-visible { background: var(--wl-card-hover); color: var(--wl-fg); outline: none; }
.wl-add { background: transparent; border: 1px dashed var(--wl-line); }
.wl-add .wl-avatar {
    background: transparent; border: 1px dashed var(--wl-line); box-shadow: none;
    color: var(--wl-muted); font-weight: 300; font-size: 42px;
}
.wl-add:hover .wl-avatar, .wl-add:focus-visible .wl-avatar { color: var(--wl-fg); }
.wl-form { cursor: default; padding: 16px 12px 12px; gap: 9px; border-color: color-mix(in srgb, var(--wl-color) 70%, transparent); }
.wl-form:hover { transform: none; }
.wl-form .wl-avatar { width: 52px; height: 52px; font-size: 22px; margin: 0; transition: background .15s; }
.wl-input {
    width: 100%; box-sizing: border-box; padding: 6px 9px; border-radius: 8px;
    border: 1px solid var(--wl-line); background: color-mix(in srgb, var(--wl-bg) 70%, transparent);
    color: inherit; font: inherit; font-size: 13px; outline: none; text-align: center;
}
.wl-input:focus { border-color: var(--wl-color); }
.wl-swatches { display: flex; flex-wrap: wrap; justify-content: center; gap: 5px; }
.wl-swatch {
    width: 14px; height: 14px; padding: 0; border-radius: 50%; border: none; cursor: pointer;
    outline: 2px solid transparent; outline-offset: 1px;
}
.wl-swatch.wl-selected, .wl-swatch:focus-visible { outline-color: var(--wl-fg); }
.wl-create {
    margin-top: auto; width: 100%; padding: 5px; border: none; border-radius: 8px; cursor: pointer;
    background: var(--wl-color); color: #fff; font: inherit; font-size: 13px; font-weight: 500;
}
.wl-create:hover { filter: brightness(1.1); }
.wl-footer {
    flex: none; display: flex; align-items: center; justify-content: space-between;
    padding: 14px 24px; border-top: 1px solid var(--wl-line);
}
.wl-guest {
    display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 8px;
    border: none; background: transparent; color: var(--wl-muted); font: inherit; font-size: 13px; cursor: pointer;
}
.wl-guest:hover, .wl-guest:focus-visible { background: var(--wl-card-hover); color: var(--wl-fg); outline: none; }
.wl-toggle { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 13px; color: var(--wl-muted); cursor: pointer; user-select: none; }
.wl-toggle input { position: absolute; opacity: 0; pointer-events: none; }
.wl-switch {
    position: relative; width: 32px; height: 18px; border-radius: 9px;
    background: var(--wl-line); transition: background .15s;
}
.wl-switch::after {
    content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
    background: #fff; transition: transform .15s;
}
.wl-toggle input:checked + .wl-switch { background: var(--theme-primary, #3b82f6); }
.wl-toggle input:checked + .wl-switch::after { transform: translateX(14px); }
.wl-toggle input:focus-visible + .wl-switch { outline: 2px solid var(--wl-fg); outline-offset: 2px; }
@keyframes wl-fade { from { opacity: 0 } }
@keyframes wl-fade-out { to { opacity: 0 } }
@keyframes wl-rise { from { opacity: 0; transform: translateY(8px) } }
@media (prefers-reduced-motion: reduce) {
    .wl-root, .wl-card { animation: none !important; transition: none !important; }
}
`
