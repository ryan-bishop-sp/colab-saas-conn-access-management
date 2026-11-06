import { logger } from '@sailpoint/connector-sdk'
import { EntitlementV2025, JsonPatchOperationV2025 } from 'sailpoint-api-client'
import { ISCClient } from '../isc-client'
import { Config, EntitlementDefinition } from '../model/config'
import {
    areJsonEqual,
    buildEntitlementVelocityContext,
    buildEntitlementRequestConfig,
    evaluateVelocityExpression,
    runWithConcurrency,
} from '../utils'

// Limit concurrent API calls to avoid overwhelming the API
const API_CONCURRENCY = 8

// ISC API limit for bulk entitlement updates
const BULK_UPDATE_CHUNK_SIZE = 50

export type EntitlementAggregationClient = Pick<
    ISCClient,
    'listEntitlements' | 'updateEntitlementsInBulk' | 'putEntitlementRequestConfig' | 'patchEntitlement'
>

interface DefinitionPlan {
    definition: EntitlementDefinition
    selected: EntitlementV2025[]
}

interface EnrichmentPlan {
    definition: EntitlementDefinition
    entitlement: EntitlementV2025
    patch: JsonPatchOperationV2025[]
}

export class EntitlementEnrichmentError extends Error {
    constructor(readonly problems: string[]) {
        super(`Invalid entitlement application enrichment (${problems.length}):\n- ${problems.join('\n- ')}`)
        this.name = 'EntitlementEnrichmentError'
    }
}

const MARKER = 'AMC-ENT'
const markerFor = (name: string): string => `[${MARKER}:${name}]`
const markerOwner = (description?: string | null): string | undefined => description?.match(/\[AMC-ENT:([^\]]+)\]/)?.[1]
const withoutMarker = (description: string): string => description.replace(/\s*\[AMC-ENT:[^\]]+\]\s*/g, ' ').trim()
const asExpressions = (definition: EntitlementDefinition): string[] => [
    definition.entitlementExpression,
    ...(definition.additionalEntitlementExpressions ?? []),
]
const renders = (expression: string, context: Record<string, unknown>): string =>
    evaluateVelocityExpression(expression, context).trim()
const technicalName = (entitlement: EntitlementV2025): string => {
    const value = entitlement.value ?? entitlement.name ?? ''
    const first = value.split(/(?<!\\),/, 1)[0]
    const equals = first.indexOf('=')
    return equals >= 0
        ? first
              .slice(equals + 1)
              .replace(/\\,/g, ',')
              .trim()
        : value
}

const metadataWith = (
    entitlement: EntitlementV2025,
    values: Array<{ key?: string; value?: string }>
): NonNullable<EntitlementV2025['accessModelMetadata']> => {
    const updates = new Map(values.filter((item) => item.key && item.value).map((item) => [item.key!, item.value!]))
    const existing = entitlement.accessModelMetadata?.attributes ?? []
    const attributes = existing
        .filter((attribute) => !updates.has(attribute.key ?? ''))
        .map((attribute) => ({ ...attribute }))
    for (const [key, value] of updates) {
        const current = existing.find((attribute) => attribute.key === key)
        attributes.push({ ...current, key, values: [{ value }] })
    }
    return { attributes }
}

/**
 * Chunks an array into smaller arrays of at most `size` elements.
 */
function chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size))
    }
    return chunks
}

/**
 * Aggregates entitlements: uses the same selection logic as roles/access profiles
 * (query + entitlementExpression), then bulk-updates requestable/privileged and
 * optionally sets entitlement request config (approval) per entitlement.
 *
 * Flow:
 * 1. For each definition: fetch entitlements via query, filter by entitlementExpression.
 * 2. Bulk-update requestable/privileged (chunks of 50; API limit).
 * 3. If requireApproval + approverType: set entitlement request config per entitlement.
 *
 * - [Bulk update](https://developer.sailpoint.com/docs/api/v2025/update-entitlements-in-bulk):
 *   requestable, privileged (max 50 items per request).
 * - [Put entitlement request config](https://developer.sailpoint.com/docs/api/v2025/put-entitlement-request-config):
 *   approval schemes per entitlement.
 */
export async function aggregateEntitlements(config: Config, isc: EntitlementAggregationClient): Promise<void> {
    if (!config.entitlements?.length) {
        logger.debug('No entitlement definitions configured, skipping entitlement aggregation')
        return
    }

    const problems: string[] = []
    const names = new Set<string>()
    for (const definition of config.entitlements) {
        if (!definition.businessApplicationName) continue
        const name = definition.businessApplicationName.trim()
        if (!name) problems.push(`definition "${definition.name}": missing business application name`)
        if (/[[\]]/.test(name))
            problems.push(`definition "${definition.name}": application name must not contain [ or ]`)
        if (!definition.displayNameExpression?.trim())
            problems.push(`definition "${definition.name}": missing display name expression`)
        if (definition.environmentMetadataKey && !definition.environmentExpression?.trim())
            problems.push(`definition "${definition.name}": environment metadata requires an environment expression`)
        const normalized = name.toLowerCase()
        if (names.has(normalized)) problems.push(`business application "${name}" is configured more than once`)
        names.add(normalized)
    }
    if (problems.length > 0) throw new EntitlementEnrichmentError(problems)

    const cache = new Map<string, EntitlementV2025[]>()
    const plans: DefinitionPlan[] = []
    for (const definition of config.entitlements) {
        logger.debug(`Processing entitlement definition: ${definition.name}`)
        let entitlements = cache.get(definition.query)
        if (!entitlements) {
            entitlements = await isc.listEntitlements(definition.query)
            cache.set(definition.query, entitlements)
        }
        logger.debug(`Found ${entitlements.length} entitlements for definition ${definition.name}`)

        const selected: EntitlementV2025[] = []
        for (const entitlement of entitlements) {
            const context = buildEntitlementVelocityContext(entitlement, {
                definitionName: definition.name,
                businessApplication: definition.businessApplicationName,
                technicalName: technicalName(entitlement),
            })
            if (!asExpressions(definition).some((expression) => expression.trim() && renders(expression, context))) {
                logger.info(`Skipping entitlement ${entitlement.id}: all expressions evaluated to empty`)
                continue
            }
            selected.push(entitlement)
        }
        plans.push({ definition, selected })
    }

    const selectedById = new Map<string, string[]>()
    for (const { definition, selected } of plans.filter((plan) => plan.definition.businessApplicationName)) {
        for (const entitlement of selected) {
            if (!entitlement.id) continue
            const applications = selectedById.get(entitlement.id) ?? []
            applications.push(definition.businessApplicationName!)
            selectedById.set(entitlement.id, applications)
        }
    }
    for (const [id, applications] of selectedById) {
        if (applications.length > 1)
            problems.push(`entitlement ${id} matches multiple business applications: ${applications.join(', ')}`)
    }

    const enrichments: EnrichmentPlan[] = []
    for (const { definition, selected } of plans.filter((plan) => plan.definition.businessApplicationName)) {
        const application = definition.businessApplicationName!.trim()
        const marker = markerFor(application)
        for (const entitlement of selected) {
            if (!entitlement.id) {
                problems.push(`business application "${application}" selected an entitlement without an id`)
                continue
            }
            const owner = markerOwner(entitlement.description)
            if (owner && owner !== application) {
                problems.push(`entitlement ${entitlement.id} is owned by business application "${owner}"`)
                continue
            }
            const context = buildEntitlementVelocityContext(entitlement, {
                definitionName: definition.name,
                businessApplication: application,
                technicalName: technicalName(entitlement),
            })
            const environment = definition.environmentExpression
                ? renders(definition.environmentExpression, context)
                : ''
            if (definition.environmentMetadataKey && !environment) {
                problems.push(
                    `business application "${application}" produced an empty environment for entitlement ${entitlement.id}`
                )
                continue
            }
            const enrichedContext = { ...context, environment }
            const name = renders(definition.displayNameExpression!, enrichedContext)
            if (!name) {
                problems.push(
                    `business application "${application}" produced an empty name for entitlement ${entitlement.id}`
                )
                continue
            }
            const descriptionBase = definition.descriptionExpression
                ? renders(definition.descriptionExpression, enrichedContext)
                : withoutMarker(entitlement.description ?? name)
            const description = `${descriptionBase || name} ${marker}`.trim()
            if (description.length > 2000) {
                problems.push(`business application "${application}" produced a description over 2000 characters`)
                continue
            }
            const manuallyUpdated = entitlement.manuallyUpdatedFields ?? {}
            if (!owner && manuallyUpdated.DISPLAY_NAME === true && entitlement.name !== name)
                problems.push(`entitlement ${entitlement.id} has a manually managed display name`)
            if (!owner && manuallyUpdated.DESCRIPTION === true && entitlement.description !== description)
                problems.push(`entitlement ${entitlement.id} has a manually managed description`)

            const metadata = metadataWith(entitlement, [
                { key: definition.businessApplicationMetadataKey, value: application },
                { key: definition.environmentMetadataKey, value: environment },
            ])
            const patch: JsonPatchOperationV2025[] = []
            if (entitlement.name !== name) patch.push({ op: 'replace', path: '/name', value: name })
            if (entitlement.description !== description)
                patch.push({ op: 'replace', path: '/description', value: description })
            if (
                (definition.businessApplicationMetadataKey || definition.environmentMetadataKey) &&
                !areJsonEqual(entitlement.accessModelMetadata ?? { attributes: [] }, metadata)
            )
                patch.push({ op: 'replace', path: '/accessModelMetadata', value: metadata })
            enrichments.push({ definition, entitlement, patch })
        }
    }
    if (problems.length > 0) throw new EntitlementEnrichmentError(problems)

    for (const { definition, selected } of plans) {
        if (selected.length === 0) {
            logger.debug(`No entitlements selected for definition ${definition.name}`)
            continue
        }
        const entitlementIds = selected.map((e) => e.id!).filter(Boolean)

        // Build JSON patch for bulk update (requestable, privileged); API allows max 50 per request
        const jsonPatch: JsonPatchOperationV2025[] = []
        if (definition.requestable) {
            jsonPatch.push({
                op: 'replace',
                path: '/requestable',
                value: true as JsonPatchOperationV2025['value'],
            })
        }
        if (definition.privileged === true) {
            jsonPatch.push({
                op: 'replace',
                path: '/privileged',
                value: true as JsonPatchOperationV2025['value'],
            })
        }
        if (definition.privileged === false) {
            jsonPatch.push({
                op: 'replace',
                path: '/privileged',
                value: false as JsonPatchOperationV2025['value'],
            })
        }

        if (jsonPatch.length > 0 && !definition.dryRun) {
            // Process in chunks of 50 (bulk API limit)
            const chunks = chunk(entitlementIds, BULK_UPDATE_CHUNK_SIZE)
            for (let i = 0; i < chunks.length; i++) {
                try {
                    logger.debug(`Bulk updating ${chunks[i].length} entitlements (chunk ${i + 1}/${chunks.length})`)
                    await isc.updateEntitlementsInBulk(chunks[i], jsonPatch)
                } catch (error) {
                    logger.error(
                        `Error bulk updating entitlements chunk ${i + 1}/${chunks.length} for definition ${
                            definition.name
                        }: ${error}`
                    )
                    // Continue with remaining chunks instead of breaking
                }
            }
        }

        // Set entitlement request config (approval) per entitlement when requireApproval and approverType are defined
        if (definition.requestable && definition.requireApproval && definition.approverType && !definition.dryRun) {
            const requestConfig = buildEntitlementRequestConfig(definition.approverType)
            const withIds = selected.filter((e): e is EntitlementV2025 & { id: string } => Boolean(e.id))
            await runWithConcurrency(withIds, API_CONCURRENCY, async (entitlement) => {
                try {
                    logger.debug(`Setting entitlement request config for ${entitlement.name} (${entitlement.id})`)
                    await isc.putEntitlementRequestConfig(entitlement.id, requestConfig)
                } catch (error) {
                    logger.error(`Error setting request config for entitlement ${entitlement.id}: ${error}`)
                }
            })
        }
    }

    for (const { definition } of plans.filter((plan) => plan.definition.businessApplicationName)) {
        const application = definition.businessApplicationName!
        const targets = enrichments.filter((plan) => plan.definition === definition)
        const updates = targets.filter((target) => target.patch.length > 0)
        logger.info(
            `${definition.dryRun ? '[DRY RUN] ' : ''}Entitlement application "${application}": ` +
                `${targets.length} matched, ${updates.length} update, ${targets.length - updates.length} unchanged`
        )
        if (!definition.dryRun) {
            await runWithConcurrency(updates, API_CONCURRENCY, async (target) => {
                await isc.patchEntitlement(target.entitlement.id!, target.patch)
            })
        }
    }
}
