export const Injectable = () => (target: any) => target
export const Inject = () => () => undefined

export class NgZone {
    run<T> (fn: () => T): T {
        return fn()
    }
}
