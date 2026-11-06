import { logger } from '@sailpoint/connector-sdk'
import { AccessProfileV2025, JsonPatchOperationV2025, RequestabilityV2025, SourceAppV2025 } from 'sailpoint-api-client'
import { ISCClient, LightweightAccessProfile } from '../isc-client'
import { MappingDefinition } from '../model/config'
import {
    buildApprovalSchemesConfig,
    buildEntitlementPatch,
    detectRequestableAndConfigChanges,
    entitlementToRef,
    runWithConcurrency,
    shouldSkipUpdate,
} from '../utils'
import {
    DEFAULT_TARGET_ENTITLEMENT_ATTRIBUTE,
    MappingError,
    MappingTarget,
    planMapping,
    resolveMappingColumns,
} from '../utils/mapping-source'
import { checkOwnership, describeOwned, ownershipMarker } from '../utils/ownership'

const API_CONCURRENCY = 8

/** A new app isn't immediately available for update. */
export const timing = { appReadyDelayMs: 2000 }

export type MappingClient = Pick<
    ISCClient,
    | 'resolveSourceByName'
    | 'applyMappingSourceSetup'
    | 'listEntitlements'
    | 'searchAccessProfilesByNames'
    | 'listAppsByName'
    | 'listOwnedAccessProfiles'
    | 'listOwnedApps'
    | 'getAppAccessProfiles'
    | 'createAccessProfile'
    | 'updateAccessProfile'
    | 'createApp'
    | 'updateSourceAccessProfiles'
    | 'deleteAccessProfile'
    | 'deleteSourceApp'
>

export interface MappingRunReport {
    definition: string
    dryRun: boolean
    deleteMode: boolean
    setupChanges: string[]
    accessProfiles: { created: string[]; updated: string[]; unchanged: string[]; deleted: string[] }
    apps: { created: string[]; updated: string[]; unchanged: string[]; deleted: string[] }
    orphans: { accessProfiles: string[]; apps: string[] }
    deferredRuleCount: number
    deferredOnlyApplications: string[]
    unmatchedGroupCount: number
    unmatchedGroupSample: string[]
    failures: string[]
}

const isOn = (value: unknown): boolean => value === true || String(value) === 'true'

const emptyReport = (definition: MappingDefinition, dryRun: boolean, deleteMode: boolean): MappingRunReport => ({
    definition: definition.name,
    dryRun,
    deleteMode,
    setupChanges: [],
    accessProfiles: { created: [], updated: [], unchanged: [], deleted: [] },
    apps: { created: [], updated: [], unchanged: [], deleted: [] },
    orphans: { accessProfiles: [], apps: [] },
    deferredRuleCount: 0,
    deferredOnlyApplications: [],
    unmatchedGroupCount: 0,
    unmatchedGroupSample: [],
    failures: [],
})

const logReport = (report: MappingRunReport): void => {
    const prefix = `${report.dryRun ? '[DRY RUN] ' : ''}Mapping definition ${report.definition}`
    const list = (label: string, names: string[]) =>
        names.length > 0 ? `\n  ${label} (${names.length}): ${names.join(', ')}` : ''
    logger.info(
        `${prefix} report:` +
            list('setup changes', report.setupChanges) +
            list('access profiles created', report.accessProfiles.created) +
            list('access profiles updated', report.accessProfiles.updated) +
            `\n  access profiles unchanged: ${report.accessProfiles.unchanged.length}` +
            list('access profiles deleted', report.accessProfiles.deleted) +
            list('apps created', report.apps.created) +
            list('apps updated', report.apps.updated) +
            `\n  apps unchanged: ${report.apps.unchanged.length}` +
            list('apps deleted', report.apps.deleted) +
            list('orphan access profiles (not deleted)', report.orphans.accessProfiles) +
            list('orphan apps (not deleted)', report.orphans.apps) +
            `\n  deferred ou rows: ${report.deferredRuleCount}` +
            list('apps with only deferred rows', report.deferredOnlyApplications) +
            `\n  AD groups matched by no rule: ${report.unmatchedGroupCount}` +
            list('sample of unmatched groups', report.unmatchedGroupSample) +
            list('failures', report.failures)
    )
    logger.info({ mappingReport: report })
}

/**
 * Entry point for one mapping definition. Throws on any check failure before writing access profiles or apps,
 * and throws after the run if any individual write failed.
 */
export async function aggregateMappingDefinition(
    isc: MappingClient,
    definition: MappingDefinition
): Promise<MappingRunReport> {
    const dryRun = isOn(definition.dryRun)
    const deleteMode = isOn(definition.deleteMode)
    logger.info(
        `Processing mapping definition: ${definition.name}${dryRun ? ' (dry run)' : ''}${
            deleteMode ? ' (delete mode)' : ''
        }`
    )

    const report = deleteMode
        ? await deleteOwnedAccessProfilesAndApps(isc, definition, dryRun)
        : await createOrUpdateFromMapping(isc, definition, dryRun)

    logReport(report)
    if (report.failures.length > 0) {
        throw new MappingError(`Mapping definition ${definition.name} finished with failures`, report.failures)
    }
    return report
}

/**
 * One-time setup run by Test Connection: resolve both sources and apply the mapping columns to the
 * mapping source, so the first CSV upload loads. Always applies, even when the definition is a dry run.
 */
export async function setUpMappingDefinition(isc: MappingClient, definition: MappingDefinition): Promise<string[]> {
    const mappingSource = await isc.resolveSourceByName(definition.mappingSourceName)
    await isc.resolveSourceByName(definition.targetSourceName)
    const changes = await isc.applyMappingSourceSetup(mappingSource, resolveMappingColumns(definition))
    logger.info(
        `Mapping definition ${definition.name}: mapping source ${mappingSource.name} ${
            changes.length > 0 ? `updated (${changes.join(', ')})` : 'already set up'
        }`
    )
    return changes
}

interface AccessProfileChange {
    target: MappingTarget
    action: 'create' | 'update' | 'unchanged'
    existingId?: string
}

interface AppChange {
    name: string
    existingId?: string
}

async function createOrUpdateFromMapping(
    isc: MappingClient,
    definition: MappingDefinition,
    dryRun: boolean
): Promise<MappingRunReport> {
    const report = emptyReport(definition, dryRun, false)
    const columns = resolveMappingColumns(definition)

    // Step 1: resolve sources and bring the mapping source in line with the mapping columns
    const mappingSource = await isc.resolveSourceByName(definition.mappingSourceName)
    const targetSource = await isc.resolveSourceByName(definition.targetSourceName)
    if (mappingSource.id === targetSource.id) {
        throw new MappingError('Invalid mapping definition', ['mapping source and target source are the same source'])
    }
    if (!targetSource.owner?.id) {
        throw new MappingError('Invalid mapping definition', [
            `target source ${targetSource.name} has no owner to assign to access profiles`,
        ])
    }
    report.setupChanges = await isc.applyMappingSourceSetup(mappingSource, columns, dryRun)

    // Step 2: load rules and candidates, then match. Throws on invalid rows, unmatched rules and conflicts.
    const mappingEntitlements = await isc.listEntitlements(`source.id eq "${mappingSource.id}"`, 'id')
    const candidates = await isc.listEntitlements(
        `source.id eq "${targetSource.id}" and attribute eq "${DEFAULT_TARGET_ENTITLEMENT_ATTRIBUTE}"`,
        'id'
    )
    logger.info(
        `Loaded ${mappingEntitlements.length} mapping rows from ${mappingSource.name} and ${candidates.length} groups from ${targetSource.name}`
    )
    const plan = planMapping(mappingEntitlements, candidates, definition)
    report.deferredRuleCount = plan.deferredRules.length
    report.deferredOnlyApplications = plan.deferredOnlyApplications
    report.unmatchedGroupCount = plan.unmatchedCandidateCount
    report.unmatchedGroupSample = plan.unmatchedCandidateSample

    // Step 3: ownership precheck for every target name, before any write
    const targetNames = plan.targets.map((t) => t.applicationName)
    const existingAccessProfiles = await isc.searchAccessProfilesByNames(targetNames)
    const existingApps = (
        await runWithConcurrency(targetNames, API_CONCURRENCY, (name) => isc.listAppsByName(name))
    ).flat()

    const clashes: string[] = []
    const accessProfileChanges: AccessProfileChange[] = []
    const appChanges: AppChange[] = []
    const accessRequestConfig = definition.approverType
        ? (buildApprovalSchemesConfig(definition.approverType) as RequestabilityV2025)
        : undefined
    const requestable = isOn(definition.requestable)

    for (const target of plan.targets) {
        const name = target.applicationName
        const apMatches = existingAccessProfiles.filter((ap) => ap.name === name)
        const apOwnership = checkOwnership(
            name,
            apMatches.map((ap) => ({ id: ap.id, name: ap.name, description: ap.description, sourceId: ap.source?.id })),
            targetSource.id!,
            definition.name
        )
        const appOwnership = checkOwnership(
            name,
            existingApps
                .filter((app) => app.name === name)
                .map((app) => ({
                    id: app.id,
                    name: app.name,
                    description: app.description,
                    sourceId: app.accountSource?.id,
                })),
            targetSource.id!,
            definition.name
        )
        if (apOwnership.status === 'not-owned') clashes.push(`access profile "${name}": ${apOwnership.reason}`)
        if (appOwnership.status === 'not-owned') clashes.push(`app "${name}": ${appOwnership.reason}`)
        if (apOwnership.status === 'not-owned' || appOwnership.status === 'not-owned') continue

        if (apOwnership.status === 'owned') {
            const existing = apMatches[0] as LightweightAccessProfile
            const changes = detectRequestableAndConfigChanges(
                existing,
                target.entitlements.map(entitlementToRef),
                requestable,
                accessRequestConfig
            )
            accessProfileChanges.push({
                target,
                action: shouldSkipUpdate(changes) ? 'unchanged' : 'update',
                existingId: apOwnership.id,
            })
        } else {
            accessProfileChanges.push({ target, action: 'create' })
        }
        appChanges.push({ name, existingId: appOwnership.status === 'owned' ? appOwnership.id : undefined })
    }
    if (clashes.length > 0) throw new MappingError('Names held by objects this definition does not own', clashes)

    // Step 4: orphans are reported, never deleted, outside delete mode
    const targetNameSet = new Set(targetNames)
    const [ownedAccessProfiles, ownedApps] = await Promise.all([
        isc.listOwnedAccessProfiles(targetSource.id!, definition.name),
        isc.listOwnedApps(targetSource.id!, definition.name),
    ])
    report.orphans.accessProfiles = ownedAccessProfiles
        .map((ap) => ap.name!)
        .filter((name) => !targetNameSet.has(name))
        .sort()
    report.orphans.apps = ownedApps
        .map((app) => app.name!)
        .filter((name) => !targetNameSet.has(name))
        .sort()

    // Step 5: access profiles
    const accessProfileIds = new Map<string, string>()
    for (const change of accessProfileChanges) {
        const name = change.target.applicationName
        if (change.action === 'unchanged') {
            report.accessProfiles.unchanged.push(name)
            accessProfileIds.set(name, change.existingId!)
        } else if (change.action === 'update') {
            report.accessProfiles.updated.push(name)
            accessProfileIds.set(name, change.existingId!)
        } else {
            report.accessProfiles.created.push(name)
        }
    }

    if (!dryRun) {
        await runWithConcurrency(
            accessProfileChanges.filter((c) => c.action !== 'unchanged'),
            API_CONCURRENCY,
            async (change) => {
                const name = change.target.applicationName
                const refs = change.target.entitlements.map(entitlementToRef)
                try {
                    if (change.action === 'update') {
                        await isc.updateAccessProfile(
                            change.existingId!,
                            buildEntitlementPatch(refs, { requestable, accessRequestConfig })
                        )
                        logger.info(`Updated access profile: ${name}`)
                    } else {
                        const created: AccessProfileV2025 = await isc.createAccessProfile(
                            name,
                            targetSource.owner!.id!,
                            targetSource.id!,
                            refs,
                            requestable,
                            accessRequestConfig,
                            describeOwned(name, definition.name)
                        )
                        accessProfileIds.set(name, created.id!)
                        logger.info(`Created access profile: ${name}`)
                    }
                } catch (error) {
                    report.failures.push(`access profile "${name}" ${change.action}: ${error}`)
                }
            }
        )
    }

    // Step 6: one app per application name, holding only its access profile
    for (const change of appChanges) {
        const apId = accessProfileIds.get(change.name)
        if (!change.existingId) {
            report.apps.created.push(change.name)
            if (dryRun) continue
        } else {
            const linked = await isc.getAppAccessProfiles(change.existingId)
            if (apId && linked.length === 1 && linked[0] === apId) {
                report.apps.unchanged.push(change.name)
                continue
            }
            report.apps.updated.push(change.name)
            if (dryRun) continue
        }
        if (!apId) {
            report.failures.push(`app "${change.name}": its access profile was not created, so the app was not linked`)
            continue
        }
        try {
            let appId = change.existingId
            if (!appId) {
                const created: SourceAppV2025 = await isc.createApp(
                    change.name,
                    targetSource.id!,
                    describeOwned(change.name, definition.name)
                )
                appId = created.id!
                logger.info(`Created application: ${change.name} (${appId})`)
                await new Promise((resolve) => setTimeout(resolve, timing.appReadyDelayMs))
            }
            const appUpdate: JsonPatchOperationV2025[] = [
                { op: 'replace', path: '/accessProfiles', value: [apId] },
                { op: 'replace', path: '/enabled', value: true },
                { op: 'replace', path: '/appCenterEnabled', value: requestable },
                { op: 'replace', path: '/provisionRequestEnabled', value: requestable },
                { op: 'replace', path: '/matchAllAccounts', value: false },
            ]
            await isc.updateSourceAccessProfiles(appId, appUpdate)
            logger.info(`Linked application ${change.name} to its access profile`)
        } catch (error) {
            report.failures.push(`app "${change.name}": ${error}`)
        }
    }

    return report
}

/**
 * Delete mode: remove every access profile and app on the target source that carries this definition's
 * ownership marker, and nothing else. Never reads the mapping file, so a bad file can't change what's deleted.
 */
async function deleteOwnedAccessProfilesAndApps(
    isc: MappingClient,
    definition: MappingDefinition,
    dryRun: boolean
): Promise<MappingRunReport> {
    const report = emptyReport(definition, dryRun, true)
    const targetSource = await isc.resolveSourceByName(definition.targetSourceName)
    const [ownedAccessProfiles, ownedApps] = await Promise.all([
        isc.listOwnedAccessProfiles(targetSource.id!, definition.name),
        isc.listOwnedApps(targetSource.id!, definition.name),
    ])
    logger.info(
        `Delete mode: ${ownedAccessProfiles.length} access profiles and ${
            ownedApps.length
        } apps carry ${ownershipMarker(definition.name)}`
    )

    report.apps.deleted = ownedApps.map((app) => app.name!).sort()
    report.accessProfiles.deleted = ownedAccessProfiles.map((ap) => ap.name!).sort()
    if (dryRun) return report

    // Apps first, so no app still references an access profile being deleted
    await runWithConcurrency(ownedApps, API_CONCURRENCY, async (app) => {
        try {
            await isc.deleteSourceApp(app.id!)
            logger.info(`Deleted application: ${app.name}`)
        } catch (error) {
            report.failures.push(`delete app "${app.name}": ${error}`)
        }
    })
    if (report.failures.length > 0) return report

    await runWithConcurrency(ownedAccessProfiles, API_CONCURRENCY, async (ap) => {
        try {
            await isc.deleteAccessProfile(ap.id!)
            logger.info(`Deleted access profile: ${ap.name}`)
        } catch (error) {
            report.failures.push(`delete access profile "${ap.name}": ${error}`)
        }
    })
    return report
}
