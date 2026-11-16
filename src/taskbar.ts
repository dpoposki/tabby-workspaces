import * as fs from 'fs'
import * as path from 'path'
import { Injectable } from '@angular/core'
import { HostAppService, Platform, PlatformService } from 'tabby-core'
import { TabbyCompat } from './tabby-compat'
import { initialOf, safeColor, Workspace } from './models'

/*
 * Makes a workspace window recognisable in the taskbar, like Chrome profiles:
 * the window icon becomes Tabby's logo with the workspace's colored initial in the
 * corner, and on Windows the window gets its own App User Model ID, so each
 * workspace has its own taskbar button instead of hiding in Tabby's group.
 *
 * Windows and Linux only: macOS has a single Dock icon per app, so there the
 * workspace name in the window title (Window menu, Dock menu, Mission Control)
 * is what tells windows apart.
 */

const SIZES = [16, 20, 24, 32, 40, 48, 64, 256]

@Injectable({ providedIn: 'root' })
export class TaskbarIdentity {
    private applied: string | null = null
    private logo: Promise<HTMLImageElement | null> | null = null

    constructor (
        private hostApp: HostAppService,
        private compat: TabbyCompat,
        private platform: PlatformService,
    ) { }

    /** macOS has one Dock icon per app, so per-window icons don't exist there */
    static isSupported (platform: Platform): boolean {
        return platform === Platform.Windows || platform === Platform.Linux
    }

    /** Applies (or refreshes) the workspace's icon; cheap to call repeatedly. */
    async apply (workspace: Workspace | null, enabled: boolean): Promise<void> {
        if (!TaskbarIdentity.isSupported(this.hostApp.platform) || !workspace || !enabled) {
            // A window never leaves its workspace, and a switched-off setting applies
            // to new windows, so there is nothing to undo here
            return
        }
        const key = `${workspace.id}|${workspace.name}|${workspace.color}`
        if (this.applied === key) {
            return
        }
        const window = this.compat.getNativeWindow()
        const dir = this.iconDirectory()
        if (!window || !dir) {
            return
        }
        const logo = await this.loadLogo()
        const pngs = SIZES.map(size => drawIcon(size, logo, workspace))

        // The file name changes with name and color: Windows caches icons by path
        const base = path.join(dir, `${workspace.id}-${hash(key)}`)
        fs.mkdirSync(dir, { recursive: true })
        removeStale(dir, workspace.id, path.basename(base))

        if (this.hostApp.platform === Platform.Windows) {
            const ico = `${base}.ico`
            fs.writeFileSync(ico, buildIco(SIZES, pngs))
            window.setIcon(ico)
            window.setAppDetails({
                appId: `Tabby.Workspace.${workspace.id}`,
                appIconPath: ico,
                appIconIndex: 0,
                relaunchCommand: `"${process.execPath}"`,
                relaunchDisplayName: `Tabby (${workspace.name})`,
            })
        } else {
            const png = `${base}.png`
            fs.writeFileSync(png, pngs[SIZES.indexOf(256)])
            window.setIcon(png)
        }
        this.applied = key
    }

    private iconDirectory (): string | null {
        const configPath = this.platform.getConfigPath()
        return configPath ? path.join(path.dirname(configPath), 'workspace-icons') : null
    }

    /** Tabby's own logo, from its app bundle; null if it can't be read (the badge is drawn alone then). */
    private loadLogo (): Promise<HTMLImageElement | null> {
        this.logo ??= new Promise(resolve => {
            try {
                const svg = fs.readFileSync(path.join((process as any).resourcesPath, 'app.asar', 'assets', 'logo.svg'))
                const image = new Image()
                image.onload = () => resolve(image)
                image.onerror = () => resolve(null)
                image.src = `data:image/svg+xml;base64,${svg.toString('base64')}`
            } catch {
                resolve(null)
            }
        })
        return this.logo
    }
}

function drawIcon (size: number, logo: HTMLImageElement | null, workspace: Workspace): Buffer {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')!
    const color = safeColor(workspace.color)
    const initial = initialOf(workspace.name)

    if (logo) {
        // Logo in the top left, colored initial over the bottom right (Chrome's profile badge)
        ctx.drawImage(logo, 0, 0, size * 0.86, size * 0.86)
        const r = size * 0.3
        const c = size - r - size * 0.02
        ctx.beginPath()
        ctx.arc(c, c, r + Math.max(1, size * 0.035), 0, Math.PI * 2)
        ctx.fillStyle = '#ffffff'
        ctx.fill()
        drawBadge(ctx, c, c, r, color, initial)
    } else {
        drawBadge(ctx, size / 2, size / 2, size / 2, color, initial)
    }
    const base64 = canvas.toDataURL('image/png').split(',')[1]
    return Buffer.from(base64, 'base64')
}

function drawBadge (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, initial: string): void {
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = `700 ${Math.round(r * 1.3)}px "Segoe UI", system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(initial, x, y + r * 0.06)
}

/** .ico file with PNG-compressed images (supported since Windows Vista). */
function buildIco (sizes: number[], pngs: Buffer[]): Buffer {
    const header = Buffer.alloc(6 + 16 * sizes.length)
    header.writeUInt16LE(0, 0)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(sizes.length, 4)
    let offset = header.length
    sizes.forEach((size, i) => {
        const entry = 6 + 16 * i
        header.writeUInt8(size >= 256 ? 0 : size, entry)
        header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
        header.writeUInt16LE(1, entry + 4) // color planes
        header.writeUInt16LE(32, entry + 6) // bits per pixel
        header.writeUInt32LE(pngs[i].length, entry + 8)
        header.writeUInt32LE(offset, entry + 12)
        offset += pngs[i].length
    })
    return Buffer.concat([header, ...pngs])
}

function removeStale (dir: string, workspaceId: string, keep: string): void {
    try {
        for (const file of fs.readdirSync(dir)) {
            if (file.startsWith(`${workspaceId}-`) && path.parse(file).name !== keep) {
                fs.rmSync(path.join(dir, file), { force: true })
            }
        }
    } catch {
        // Locked by Explorer or already gone; harmless
    }
}

function hash (value: string): string {
    let h = 0
    for (let i = 0; i < value.length; i++) {
        h = Math.imul(31, h) + value.charCodeAt(i) | 0
    }
    return (h >>> 0).toString(36)
}
