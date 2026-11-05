/**
 * Ownership marker for objects created by a mapping definition. An existing access profile or app counts as
 * owned only if its name matches, it sits on the expected source, and its description carries this marker.
 */
export const ownershipMarker = (definitionName: string): string => `[AMC:${definitionName}]`

export const hasOwnershipMarker = (description: string | null | undefined, definitionName: string): boolean =>
    (description ?? '').includes(ownershipMarker(definitionName))

export const describeOwned = (name: string, definitionName: string): string =>
    `${name} ${ownershipMarker(definitionName)}`

export interface OwnedObjectCandidate {
    id?: string
    name?: string | null
    description?: string | null
    sourceId?: string | null
}

export type OwnershipResult =
    | { status: 'absent' }
    | { status: 'owned'; id: string }
    | { status: 'not-owned'; reason: string }

/**
 * Decide whether the objects found under a target name belong to this definition.
 * `existing` is every object with that name, from a tenant-wide search.
 */
export const checkOwnership = (
    name: string,
    existing: OwnedObjectCandidate[],
    expectedSourceId: string,
    definitionName: string
): OwnershipResult => {
    const sameName = existing.filter((o) => o.name === name)
    if (sameName.length === 0) return { status: 'absent' }
    if (sameName.length > 1) return { status: 'not-owned', reason: `${sameName.length} objects share this name` }

    const [object] = sameName
    if (object.sourceId !== expectedSourceId)
        return { status: 'not-owned', reason: `it belongs to another source (${object.sourceId ?? 'none'})` }
    if (!hasOwnershipMarker(object.description, definitionName))
        return { status: 'not-owned', reason: `its description lacks the marker ${ownershipMarker(definitionName)}` }
    return { status: 'owned', id: object.id! }
}
