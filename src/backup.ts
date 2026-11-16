import { Injectable } from '@angular/core'
import { NotificationsService, PlatformService, SelectorService } from 'tabby-core'
import { EXPORT_FORMAT, EXPORT_VERSION, ExportFile, plural, WORKSPACE_COLORS } from './models'
import { WorkspaceStore } from './store'
import { WindowRegistry } from './registry'
import { WorkspaceSession } from './session'

/** Export and import of all workspaces with their pins (Settings → Workspaces → Backup). */
@Injectable({ providedIn: 'root' })
export class WorkspacesBackup {
    constructor (
        private platform: PlatformService,
        private selector: SelectorService,
        private notifications: NotificationsService,
        private store: WorkspaceStore,
        private registry: WindowRegistry,
        private session: WorkspaceSession,
    ) { }

    async exportWorkspaces (): Promise<void> {
        await this.session.save()
        const data: ExportFile = {
            format: EXPORT_FORMAT,
            version: EXPORT_VERSION,
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

        const parsed = parseExport(new TextDecoder().decode(concat(chunks)))
        if ('error' in parsed) {
            this.notifications.error('Import failed', parsed.error)
            return
        }
        const data = parsed.data

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
        if (this.session.current) {
            open.add(this.session.current.id)
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
}

/** Reads an export file; an error message if it isn't one this version can import. */
export function parseExport (text: string): { data: ExportFile } | { error: string } {
    let data: ExportFile
    try {
        data = JSON.parse(text)
    } catch {
        return { error: 'The file is not valid JSON.' }
    }
    if (data?.format !== EXPORT_FORMAT || !Array.isArray(data.workspaces)) {
        return { error: 'This is not a Tabby workspaces export.' }
    }
    if (typeof data.version !== 'number' || data.version > EXPORT_VERSION) {
        return { error: 'This file was exported by a newer version of the workspaces plugin. Update the plugin first.' }
    }
    return { data }
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
