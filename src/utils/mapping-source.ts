import { EntitlementV2025 } from 'sailpoint-api-client'
import { MappingDefinition } from '../model/config'

export const DEFAULT_TARGET_ENTITLEMENT_ATTRIBUTE = 'memberOf'
export const MATCH_TYPES = ['dn', 'cn_prefix', 'ou'] as const
export type MatchType = (typeof MATCH_TYPES)[number]

/** Match types built in this phase. `ou` rows are set aside and reported as deferred. */
const ACTIVE_MATCH_TYPES: ReadonlySet<MatchType> = new Set(['dn', 'cn_prefix'])

const UNMATCHED_SAMPLE_SIZE = 20

export interface MappingColumns {
    id: string
    applicationName: string
    matchType: string
    matchValue: string
    traceability: string[]
}

export interface MappingRule {
    id: string
    applicationName: string
    matchType: MatchType
    matchValue: string
    traceability: Record<string, string>
}

export interface MappingTarget {
    applicationName: string
    entitlements: EntitlementV2025[]
    ruleIds: string[]
}

export interface MappingPlan {
    targets: MappingTarget[]
    deferredRules: MappingRule[]
    /** Applications whose rules are all deferred, so they produce no access profile this phase. */
    deferredOnlyApplications: string[]
    unmatchedCandidateCount: number
    unmatchedCandidateSample: string[]
}

/** Thrown when the mapping can't be applied safely. Lists every problem found, not just the first. */
export class MappingError extends Error {
    constructor(readonly kind: string, readonly problems: string[]) {
        super(`${kind} (${problems.length}):\n- ${problems.join('\n- ')}`)
        this.name = 'MappingError'
    }
}

export const resolveMappingColumns = (definition: MappingDefinition): MappingColumns => ({
    id: definition.idColumn?.trim() || 'mapping_id',
    applicationName: definition.applicationNameColumn?.trim() || 'application_name',
    matchType: definition.matchTypeColumn?.trim() || 'match_type',
    matchValue: definition.matchValueColumn?.trim() || 'match_value',
    traceability: definition.traceabilityColumns?.map((c) => c.trim()).filter(Boolean) ?? [
        'instance_name',
        'integration_type',
    ],
})

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

/** The CN of a group, from the first RDN of its DN. Undefined if the first RDN isn't a CN. */
export const parseCn = (dn: string): string | undefined => {
    const first = splitDn(dn)[0]
    const match = /^cn\s*=(.*)$/i.exec(first ?? '')
    if (!match) return undefined
    return match[1].trim().replace(/\\(.)/g, '$1')
}

const attributeString = (attributes: Record<string, any> | undefined, key: string): string => {
    const value = attributes?.[key]
    if (value === undefined || value === null) return ''
    if (Array.isArray(value)) return value.length === 1 ? String(value[0]).trim() : ''
    return String(value).trim()
}

/**
 * Read mapping rules from the mapping source's entitlements. The row key is the entitlement value (the
 * delimited source's index column); the other columns come back under attributes.
 * Any invalid row fails the whole load: a skipped row would silently strip groups from a profile.
 */
export const readMappingRules = (
    entitlements: EntitlementV2025[],
    columns: MappingColumns
): { rules: MappingRule[]; deferredRules: MappingRule[] } => {
    const problems: string[] = []
    const seen = new Set<string>()
    const rules: MappingRule[] = []
    const deferredRules: MappingRule[] = []

    for (const entitlement of entitlements) {
        const attributes = entitlement.attributes as Record<string, any> | undefined
        const id = (entitlement.value ?? entitlement.name ?? attributeString(attributes, columns.id)).trim()
        const label = id || `entitlement ${entitlement.id ?? '(no id)'}`
        const applicationName = attributeString(attributes, columns.applicationName)
        const matchType = attributeString(attributes, columns.matchType).toLowerCase()
        const matchValue = attributeString(attributes, columns.matchValue)

        const rowProblems: string[] = []
        if (!id) rowProblems.push(`missing ${columns.id}`)
        if (!applicationName) rowProblems.push(`missing ${columns.applicationName}`)
        if (!matchType) rowProblems.push(`missing ${columns.matchType}`)
        else if (!(MATCH_TYPES as readonly string[]).includes(matchType))
            rowProblems.push(`unknown ${columns.matchType} "${matchType}" (expected ${MATCH_TYPES.join(', ')})`)
        if (!matchValue) rowProblems.push(`missing ${columns.matchValue}`)
        if (id && seen.has(id.toLowerCase())) rowProblems.push(`duplicate ${columns.id}`)
        if (id) seen.add(id.toLowerCase())

        if (rowProblems.length > 0) {
            problems.push(`${label}: ${rowProblems.join('; ')}`)
            continue
        }

        const traceability: Record<string, string> = {}
        for (const column of columns.traceability) {
            const value = attributeString(attributes, column)
            if (value) traceability[column] = value
        }
        const rule: MappingRule = { id, applicationName, matchType: matchType as MatchType, matchValue, traceability }
        if (ACTIVE_MATCH_TYPES.has(rule.matchType)) rules.push(rule)
        else deferredRules.push(rule)
    }

    if (problems.length > 0) throw new MappingError('Invalid mapping rows', problems)
    return { rules, deferredRules }
}

interface Candidate {
    entitlement: EntitlementV2025
    dn: string
    cn?: string
}

export interface CandidateIndex {
    byDn: Map<string, Candidate>
    all: Candidate[]
}

/** Index the target source's group entitlements by normalized DN and by CN. */
export const buildCandidateIndex = (entitlements: EntitlementV2025[]): CandidateIndex => {
    const byDn = new Map<string, Candidate>()
    const all: Candidate[] = []
    for (const entitlement of entitlements) {
        const raw = entitlement.value ?? entitlement.name
        if (!raw) continue
        const candidate: Candidate = { entitlement, dn: normalizeDn(raw), cn: parseCn(raw)?.toLowerCase() }
        byDn.set(candidate.dn, candidate)
        all.push(candidate)
    }
    return { byDn, all }
}

const matchRule = (rule: MappingRule, index: CandidateIndex): Candidate[] => {
    switch (rule.matchType) {
        case 'dn': {
            const candidate = index.byDn.get(normalizeDn(rule.matchValue))
            return candidate ? [candidate] : []
        }
        case 'cn_prefix': {
            const prefix = rule.matchValue.toLowerCase()
            return index.all.filter((c) => c.cn !== undefined && c.cn.startsWith(prefix))
        }
        default:
            return []
    }
}

/**
 * Match rules against the candidate index and group by application name.
 * Fails before any writes if a rule matches nothing or a group lands under more than one application.
 */
export const matchMappingRules = (
    rules: MappingRule[],
    index: CandidateIndex
): { targets: MappingTarget[]; matchedDns: Set<string> } => {
    const byApp = new Map<string, { entitlements: Map<string, EntitlementV2025>; ruleIds: string[] }>()
    const appsByDn = new Map<string, { display: string; apps: Set<string> }>()
    const unmatched: string[] = []

    for (const rule of rules) {
        const matches = matchRule(rule, index)
        if (matches.length === 0) {
            unmatched.push(`${rule.id} (${rule.applicationName}): ${rule.matchType} "${rule.matchValue}"`)
            continue
        }
        let app = byApp.get(rule.applicationName)
        if (!app) {
            app = { entitlements: new Map(), ruleIds: [] }
            byApp.set(rule.applicationName, app)
        }
        app.ruleIds.push(rule.id)
        for (const candidate of matches) {
            app.entitlements.set(candidate.dn, candidate.entitlement)
            const entry = appsByDn.get(candidate.dn) ?? {
                display: candidate.entitlement.value ?? candidate.dn,
                apps: new Set<string>(),
            }
            entry.apps.add(rule.applicationName)
            appsByDn.set(candidate.dn, entry)
        }
    }

    if (unmatched.length > 0) throw new MappingError('Mapping rules matched no group', unmatched)

    const conflicts = [...appsByDn.values()]
        .filter((e) => e.apps.size > 1)
        .map((e) => `group "${e.display}" found in ${[...e.apps].map((a) => `"${a}"`).join(' and ')}`)
    if (conflicts.length > 0) throw new MappingError('Mapping conflicts', conflicts)

    const targets = [...byApp.entries()]
        .map(([applicationName, app]) => ({
            applicationName,
            entitlements: [...app.entitlements.values()],
            ruleIds: app.ruleIds,
        }))
        .sort((a, b) => a.applicationName.localeCompare(b.applicationName))

    return { targets, matchedDns: new Set(appsByDn.keys()) }
}

/** Load, validate and match the mapping rules into one target per application name. No API calls. */
export const planMapping = (
    mappingEntitlements: EntitlementV2025[],
    candidateEntitlements: EntitlementV2025[],
    definition: MappingDefinition
): MappingPlan => {
    const { rules, deferredRules } = readMappingRules(mappingEntitlements, resolveMappingColumns(definition))
    const index = buildCandidateIndex(candidateEntitlements)
    const { targets, matchedDns } = matchMappingRules(rules, index)

    const activeApps = new Set(rules.map((r) => r.applicationName))
    const deferredOnlyApplications = [...new Set(deferredRules.map((r) => r.applicationName))]
        .filter((app) => !activeApps.has(app))
        .sort()

    const unmatchedCandidates = index.all.filter((c) => !matchedDns.has(c.dn))

    return {
        targets,
        deferredRules,
        deferredOnlyApplications,
        unmatchedCandidateCount: unmatchedCandidates.length,
        unmatchedCandidateSample: unmatchedCandidates
            .slice(0, UNMATCHED_SAMPLE_SIZE)
            .map((c) => c.entitlement.value ?? c.dn),
    }
}
