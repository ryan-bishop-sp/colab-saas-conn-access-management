import { EntitlementV2025 } from 'sailpoint-api-client'
import { OuApplicationDefinition } from '../model/config'

/** Entitlement attribute on the target source that holds group DNs. */
export const GROUP_ATTRIBUTE = 'memberOf'

/** Thrown when OU applications can't be applied safely. Lists every problem found, not just the first. */
export class OuApplicationError extends Error {
    constructor(readonly kind: string, readonly problems: string[]) {
        super(`${kind} (${problems.length}):\n- ${problems.join('\n- ')}`)
        this.name = 'OuApplicationError'
    }
}

/** Split a DN into RDNs on unescaped commas outside quotes. */
export const splitDn = (dn: string): string[] => {
    const parts: string[] = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < dn.length; i++) {
        const char = dn[i]
        if (char === '\\' && i + 1 < dn.length) {
            current += char + dn[++i]
        } else if (char === '"') {
            inQuotes = !inQuotes
            current += char
        } else if (char === ',' && !inQuotes) {
            parts.push(current)
            current = ''
        } else {
            current += char
        }
    }
    parts.push(current)
    return parts.map((p) => p.trim())
}

/** Normalize a DN for comparison: case-insensitive, no whitespace around separators. */
export const normalizeDn = (dn: string): string =>
    splitDn(dn)
        .map((rdn) => {
            const eq = rdn.indexOf('=')
            if (eq < 0) return rdn.toLowerCase().replace(/\s+/g, ' ')
            const type = rdn.slice(0, eq).trim()
            const value = rdn
                .slice(eq + 1)
                .trim()
                .replace(/\s+/g, ' ')
            return `${type}=${value}`.toLowerCase()
        })
        .join(',')

/** True when the group DN sits anywhere beneath the OU. Both must be normalized. */
export const isInSubtree = (groupDn: string, ouDn: string): boolean => groupDn.endsWith(`,${ouDn}`)

const isOuDn = (dn: string): boolean => {
    const rdns = splitDn(dn)
    return rdns.length > 1 && /^ou\s*=\s*\S/i.test(rdns[0]) && rdns.every((rdn) => /^[a-z]+\s*=\s*\S/i.test(rdn))
}

const asList = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
    if (typeof value === 'string') return value.trim() ? [value.trim()] : []
    return []
}

export interface OuApplication {
    definition: OuApplicationDefinition
    name: string
    targetSourceName: string
    /** Normalized OU DNs, de-duplicated, with OUs nested inside another listed OU removed. */
    organizationalUnits: string[]
}

/**
 * Validate every OU application definition together. Fails on missing fields, duplicate names, malformed
 * OUs, and any OU that is the same as or nested inside an OU of another application, since a group would
 * then belong to two applications.
 */
export const validateOuApplications = (definitions: OuApplicationDefinition[]): OuApplication[] => {
    const problems: string[] = []
    const apps: OuApplication[] = []
    const names = new Map<string, number>()

    definitions.forEach((definition, index) => {
        const name = (definition.name ?? '').trim()
        const label = name ? `"${name}"` : `definition #${index + 1}`
        const rowProblems: string[] = []
        if (!name) rowProblems.push('missing application name')
        if (/[[\]]/.test(name)) rowProblems.push('application name must not contain [ or ]')
        if (name) names.set(name.toLowerCase(), (names.get(name.toLowerCase()) ?? 0) + 1)
        const targetSourceName = (definition.targetSourceName ?? '').trim()
        if (!targetSourceName) rowProblems.push('missing target source name')

        const rawOus = asList(definition.organizationalUnits)
        if (rawOus.length === 0) rowProblems.push('no organizational units')
        const malformed = rawOus.filter((ou) => !isOuDn(ou))
        if (malformed.length > 0)
            rowProblems.push(`not an OU distinguished name: ${malformed.map((ou) => `"${ou}"`).join(', ')}`)

        if (rowProblems.length > 0) {
            problems.push(`${label}: ${rowProblems.join('; ')}`)
            return
        }

        const normalized = [...new Set(rawOus.map(normalizeDn))]
        const organizationalUnits = normalized.filter(
            (ou) => !normalized.some((other) => other !== ou && isInSubtree(ou, other))
        )
        apps.push({ definition, name, targetSourceName, organizationalUnits })
    })

    for (const [name, count] of names) {
        if (count > 1) problems.push(`application name "${name}" is used by ${count} definitions`)
    }

    for (let i = 0; i < apps.length; i++) {
        for (let j = i + 1; j < apps.length; j++) {
            const [a, b] = [apps[i], apps[j]]
            if (a.targetSourceName !== b.targetSourceName) continue
            for (const ouA of a.organizationalUnits) {
                for (const ouB of b.organizationalUnits) {
                    if (ouA === ouB) {
                        problems.push(`OU "${ouA}" is listed by both "${a.name}" and "${b.name}"`)
                    } else if (isInSubtree(ouA, ouB)) {
                        problems.push(`OU "${ouA}" of "${a.name}" is inside OU "${ouB}" of "${b.name}"`)
                    } else if (isInSubtree(ouB, ouA)) {
                        problems.push(`OU "${ouB}" of "${b.name}" is inside OU "${ouA}" of "${a.name}"`)
                    }
                }
            }
        }
    }

    if (problems.length > 0) throw new OuApplicationError('Invalid OU application definitions', problems)
    return apps
}

export interface OuApplicationTarget {
    app: OuApplication
    entitlements: EntitlementV2025[]
    /** Matched group count per OU, in the order listed. */
    groupsPerOu: Record<string, number>
}

/**
 * Collect each application's groups from the target source's group entitlements.
 * Fails if any listed OU contains no groups, which usually means a typo or an AD aggregation that hasn't run.
 */
export const matchOuApplications = (apps: OuApplication[], candidates: EntitlementV2025[]): OuApplicationTarget[] => {
    const normalizedCandidates = candidates
        .map((entitlement) => ({ entitlement, dn: normalizeDn(entitlement.value ?? entitlement.name ?? '') }))
        .filter((c) => c.dn)

    const empty: string[] = []
    const targets = apps.map((app) => {
        const groupsPerOu: Record<string, number> = {}
        const matched = new Map<string, EntitlementV2025>()
        for (const ou of app.organizationalUnits) {
            const inOu = normalizedCandidates.filter((c) => isInSubtree(c.dn, ou))
            groupsPerOu[ou] = inOu.length
            if (inOu.length === 0) empty.push(`"${app.name}": no groups found under "${ou}"`)
            for (const c of inOu) matched.set(c.dn, c.entitlement)
        }
        return { app, entitlements: [...matched.values()], groupsPerOu }
    })

    if (empty.length > 0) throw new OuApplicationError('Organizational units with no groups', empty)
    return targets
}
