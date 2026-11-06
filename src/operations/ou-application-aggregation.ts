import { logger } from '@sailpoint/connector-sdk'
import { JsonPatchOperationV2025, RequestabilityV2025, SourceV2025 } from 'sailpoint-api-client'
import { ISCClient } from '../isc-client'
import { OuApplicationDefinition } from '../model/config'
import {
    buildApprovalSchemesConfig,
    buildEntitlementPatch,
    detectRequestableAndConfigChanges,
    entitlementToRef,
    runWithConcurrency,
    shouldSkipUpdate,
} from '../utils'
import {
    GROUP_ATTRIBUTE,
    OuApplication,
    OuApplicationError,
    OuApplicationTarget,
    matchOuApplications,
    validateOuApplications,
} from '../utils/ou-applications'
import { checkOwnership, describeOwned } from '../utils/ownership'

const API_CONCURRENCY = 8

/** A new app isn't immediately available for update. */
export const timing = { appReadyDelayMs: 2000 }

export type OuApplicationClient = Pick<
    ISCClient,
    | 'resolveSourceByName'
    | 'listEntitlements'
    | 'searchAccessProfilesByNames'
    | 'listAppsByName'
    | 'listMarkedAccessProfiles'
    | 'listMarkedApps'
    | 'getAppAccessProfiles'
    | 'createAccessProfile'
    | 'updateAccessProfile'
    | 'createApp'
    | 'updateSourceAccessProfiles'
    | 'deleteAccessProfile'
    | 'deleteSourceApp'
>

type Action = 'create' | 'update' | 'unchanged' | 'delete' | 'absent'

export interface OuApplicationResult {
    name: string
    dryRun: boolean
    groups: number
    groupsPerOu: Record<string, number>
    accessProfile: Action
    app: Action
}

export interface OuApplicationReport {
    applications: OuApplicationResult[]
    /** Objects carrying an AMC marker for a definition that no longer exists. Reported, never deleted. */
    orphans: { accessProfiles: string[]; apps: string[] }
    failures: string[]
}

const isOn = (value: unknown): boolean => value === true || String(value) === 'true'

const logReport = (report: OuApplicationReport): void => {
    const lines = report.applications.map(
        (r) =>
            `  ${r.dryRun ? '[DRY RUN] ' : ''}${r.name}: access profile ${r.accessProfile}, app ${r.app}, ${
                r.groups
            } groups (${Object.entries(r.groupsPerOu)
                .map(([ou, n]) => `${ou}: ${n}`)
                .join('; ')})`
    )
    const list = (label: string, names: string[]) =>
        names.length > 0 ? [`  ${label} (${names.length}): ${names.join(', ')}`] : []
    logger.info(
        [
            `OU applications report (${report.applications.length}):`,
            ...lines,
            ...list('orphan access profiles (not deleted)', report.orphans.accessProfiles),
            ...list('orphan apps (not deleted)', report.orphans.apps),
            ...list('failures', report.failures),
        ].join('\n')
    )
    logger.info({ ouApplicationReport: report })
}

/**
 * Validate definitions and resolve their target sources. Run by Test Connection; makes no changes.
 */
export async function checkOuApplications(
    isc: Pick<OuApplicationClient, 'resolveSourceByName'>,
    definitions: OuApplicationDefinition[]
): Promise<void> {
    const apps = validateOuApplications(definitions)
    for (const name of new Set(apps.map((a) => a.targetSourceName))) {
        await isc.resolveSourceByName(name)
    }
    logger.info(`OU applications: ${apps.length} definitions are valid`)
}

interface Plan {
    app: OuApplication
    source: SourceV2025
    dryRun: boolean
    target?: OuApplicationTarget
    accessProfile: Action
    appAction: Action
    accessProfileId?: string
    appId?: string
}

/**
 * Process every OU application definition together. All checks run before any write: definition
 * validation, source resolution, group matching (every OU must contain groups) and ownership of every
 * target name. Throws after the run if any individual write failed.
 */
export async function aggregateOuApplications(
    isc: OuApplicationClient,
    definitions: OuApplicationDefinition[]
): Promise<OuApplicationReport> {
    const apps = validateOuApplications(definitions)
    logger.info(`Processing ${apps.length} OU application definitions`)

    // Step 1: resolve target sources
    const sources = new Map<string, SourceV2025>()
    for (const name of new Set(apps.map((a) => a.targetSourceName))) {
        const source = await isc.resolveSourceByName(name)
        if (!source.owner?.id) {
            throw new OuApplicationError('Invalid OU application definitions', [
                `target source "${name}" has no owner to assign to access profiles`,
            ])
        }
        sources.set(name, source)
    }

    // Step 2: match groups for every non-delete definition, loading each source's groups once
    const building = apps.filter((a) => !isOn(a.definition.deleteMode))
    const targets = new Map<string, OuApplicationTarget>()
    for (const [sourceName, source] of sources) {
        const forSource = building.filter((a) => a.targetSourceName === sourceName)
        if (forSource.length === 0) continue
        const candidates = await isc.listEntitlements(
            `source.id eq "${source.id}" and attribute eq "${GROUP_ATTRIBUTE}"`,
            'id'
        )
        logger.info(`Loaded ${candidates.length} groups from ${sourceName}`)
        for (const target of matchOuApplications(forSource, candidates)) targets.set(target.app.name, target)
    }

    // Step 3: ownership precheck for every name, plus marked objects per source for deletes and orphans
    const names = apps.map((a) => a.name)
    const existingAccessProfiles = await isc.searchAccessProfilesByNames(names)
    const existingApps = (await runWithConcurrency(names, API_CONCURRENCY, (n) => isc.listAppsByName(n))).flat()
    const marked = new Map(
        await Promise.all(
            [...sources.values()].map(
                async (s) =>
                    [
                        s.id!,
                        { aps: await isc.listMarkedAccessProfiles(s.id!), apps: await isc.listMarkedApps(s.id!) },
                    ] as const
            )
        )
    )

    const requestableOf = (app: OuApplication) => isOn(app.definition.requestable)
    const approvalOf = (app: OuApplication) =>
        app.definition.approverType
            ? (buildApprovalSchemesConfig(app.definition.approverType) as RequestabilityV2025)
            : undefined

    const clashes: string[] = []
    const plans: Plan[] = []
    for (const app of apps) {
        const source = sources.get(app.targetSourceName)!
        const dryRun = isOn(app.definition.dryRun)

        if (isOn(app.definition.deleteMode)) {
            const ownedAp = marked.get(source.id!)!.aps.find((ap) => ap.markedBy === app.name)
            const ownedApp = marked.get(source.id!)!.apps.find((a) => a.markedBy === app.name)
            plans.push({
                app,
                source,
                dryRun,
                accessProfile: ownedAp ? 'delete' : 'absent',
                appAction: ownedApp ? 'delete' : 'absent',
                accessProfileId: ownedAp?.id,
                appId: ownedApp?.id,
            })
            continue
        }

        const apMatches = existingAccessProfiles.filter((ap) => ap.name === app.name)
        const apOwnership = checkOwnership(
            app.name,
            apMatches.map((ap) => ({ id: ap.id, name: ap.name, description: ap.description, sourceId: ap.source?.id })),
            source.id!,
            app.name
        )
        const appOwnership = checkOwnership(
            app.name,
            existingApps
                .filter((a) => a.name === app.name)
                .map((a) => ({ id: a.id, name: a.name, description: a.description, sourceId: a.accountSource?.id })),
            source.id!,
            app.name
        )
        if (apOwnership.status === 'not-owned') clashes.push(`access profile "${app.name}": ${apOwnership.reason}`)
        if (appOwnership.status === 'not-owned') clashes.push(`app "${app.name}": ${appOwnership.reason}`)
        if (apOwnership.status === 'not-owned' || appOwnership.status === 'not-owned') continue

        const target = targets.get(app.name)!
        let accessProfile: Action = 'create'
        if (apOwnership.status === 'owned') {
            const changes = detectRequestableAndConfigChanges(
                apMatches[0],
                target.entitlements.map(entitlementToRef),
                requestableOf(app),
                approvalOf(app)
            )
            accessProfile = shouldSkipUpdate(changes) ? 'unchanged' : 'update'
        }
        const appId = appOwnership.status === 'owned' ? appOwnership.id : undefined
        let appAction: Action = 'create'
        if (appId) {
            const linked = await isc.getAppAccessProfiles(appId)
            appAction =
                apOwnership.status === 'owned' && linked.length === 1 && linked[0] === apOwnership.id
                    ? 'unchanged'
                    : 'update'
        }
        plans.push({
            app,
            source,
            dryRun,
            target,
            accessProfile,
            appAction,
            accessProfileId: apOwnership.status === 'owned' ? apOwnership.id : undefined,
            appId,
        })
    }
    if (clashes.length > 0) throw new OuApplicationError('Names held by objects these definitions do not own', clashes)

    const report: OuApplicationReport = {
        applications: plans.map((p) => ({
            name: p.app.name,
            dryRun: p.dryRun,
            groups: p.target?.entitlements.length ?? 0,
            groupsPerOu: p.target?.groupsPerOu ?? {},
            accessProfile: p.accessProfile,
            app: p.appAction,
        })),
        orphans: { accessProfiles: [], apps: [] },
        failures: [],
    }
    const nameSet = new Set(names)
    for (const { aps, apps: markedApps } of marked.values()) {
        report.orphans.accessProfiles.push(...aps.filter((ap) => !nameSet.has(ap.markedBy)).map((ap) => ap.name!))
        report.orphans.apps.push(...markedApps.filter((a) => !nameSet.has(a.markedBy)).map((a) => a.name!))
    }
    report.orphans.accessProfiles.sort()
    report.orphans.apps.sort()

    // Step 4: writes, skipping dry-run definitions
    const live = plans.filter((p) => !p.dryRun)
    await runWithConcurrency(
        live.filter((p) => p.accessProfile === 'create' || p.accessProfile === 'update'),
        API_CONCURRENCY,
        async (p) => {
            const refs = p.target!.entitlements.map(entitlementToRef)
            try {
                if (p.accessProfile === 'update') {
                    await isc.updateAccessProfile(
                        p.accessProfileId!,
                        buildEntitlementPatch(refs, {
                            requestable: requestableOf(p.app),
                            accessRequestConfig: approvalOf(p.app),
                        })
                    )
                    logger.info(`Updated access profile: ${p.app.name}`)
                } else {
                    const created = await isc.createAccessProfile(
                        p.app.name,
                        p.source.owner!.id!,
                        p.source.id!,
                        refs,
                        requestableOf(p.app),
                        approvalOf(p.app),
                        describeOwned(p.app.name, p.app.name)
                    )
                    p.accessProfileId = created.id!
                    logger.info(`Created access profile: ${p.app.name}`)
                }
            } catch (error) {
                report.failures.push(`access profile "${p.app.name}" ${p.accessProfile}: ${error}`)
                p.accessProfileId = undefined
            }
        }
    )

    for (const p of live.filter((p) => p.appAction === 'create' || p.appAction === 'update')) {
        if (!p.accessProfileId) {
            report.failures.push(`app "${p.app.name}": its access profile is missing, so the app was not linked`)
            continue
        }
        try {
            let appId = p.appId
            if (!appId) {
                const created = await isc.createApp(p.app.name, p.source.id!, describeOwned(p.app.name, p.app.name))
                appId = created.id!
                logger.info(`Created application: ${p.app.name} (${appId})`)
                await new Promise((resolve) => setTimeout(resolve, timing.appReadyDelayMs))
            }
            const requestable = requestableOf(p.app)
            const appUpdate: JsonPatchOperationV2025[] = [
                { op: 'replace', path: '/accessProfiles', value: [p.accessProfileId] },
                { op: 'replace', path: '/enabled', value: true },
                { op: 'replace', path: '/appCenterEnabled', value: requestable },
                { op: 'replace', path: '/provisionRequestEnabled', value: requestable },
                { op: 'replace', path: '/matchAllAccounts', value: false },
            ]
            await isc.updateSourceAccessProfiles(appId, appUpdate)
            logger.info(`Linked application ${p.app.name} to its access profile`)
        } catch (error) {
            report.failures.push(`app "${p.app.name}": ${error}`)
        }
    }

    // Delete mode: only this definition's marked objects, apps first so no app references a deleted profile
    for (const p of live.filter((p) => p.appAction === 'delete' || p.accessProfile === 'delete')) {
        try {
            if (p.appAction === 'delete') {
                await isc.deleteSourceApp(p.appId!)
                logger.info(`Deleted application: ${p.app.name}`)
            }
            if (p.accessProfile === 'delete') {
                await isc.deleteAccessProfile(p.accessProfileId!)
                logger.info(`Deleted access profile: ${p.app.name}`)
            }
        } catch (error) {
            report.failures.push(`delete "${p.app.name}": ${error}`)
        }
    }

    logReport(report)
    if (report.failures.length > 0) {
        throw new OuApplicationError('OU applications finished with failures', report.failures)
    }
    return report
}
