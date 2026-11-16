/** A workspace is the equivalent of a Chrome profile: its own window, its own pinned tabs. */
export interface Workspace {
    id: string
    name: string
    color: string
    createdAt: number
    lastOpenedAt?: number
}

/** One pinned tab, as stored for a workspace. */
export interface PinRecord {
    id: string
    /** Tabby recovery token (profile, cwd, custom title, ...) */
    token: any
    /** Typed into the shell after the tab is restored */
    startupCommand?: string
    /** Attach the tab to a persistent tmux session (WSL tabs only) */
    tmux?: boolean
}

/** Per-tab runtime metadata, kept for the lifetime of a tab. */
export interface PinMeta {
    id: string
    startupCommand?: string
    tmux?: boolean
}

export interface ExportFile {
    format: 'tabby-workspaces'
    version: 1
    exportedAt: string
    workspaces: (Workspace & { pins: PinRecord[] })[]
}

export const WORKSPACE_COLORS: { name: string, value: string }[] = [
    { name: 'Blue', value: '#3b82f6' },
    { name: 'Green', value: '#22c55e' },
    { name: 'Orange', value: '#f97316' },
    { name: 'Purple', value: '#a855f7' },
    { name: 'Red', value: '#ef4444' },
    { name: 'Teal', value: '#14b8a6' },
    { name: 'Pink', value: '#ec4899' },
    { name: 'Yellow', value: '#eab308' },
    { name: 'Gray', value: '#6b7280' },
]

export function newId (): string {
    return crypto.randomUUID()
}
