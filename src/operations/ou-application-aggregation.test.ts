import { EntitlementV2025 } from 'sailpoint-api-client'
import { OuApplicationDefinition } from '../model/config'
import { OuApplicationError } from '../utils/ou-applications'
import { describeOwned } from '../utils/ownership'
import { OuApplicationClient, aggregateOuApplications, checkOuApplications, timing } from './ou-application-aggregation'

jest.mock('@sailpoint/connector-sdk', () => ({
    logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const DIRECTORY = 'src-directory'
const OTHER = 'src-other'
const BASE = 'OU=Apps,DC=example,DC=com'

const definition = (name: string, ...organizationalUnits: string[]): OuApplicationDefinition => ({
    name,
    targetSourceName: 'Directory',
    organizationalUnits,
    requestable: false,
    requireApproval: false,
})

const payroll = definition('Payroll', `OU=Payroll,${BASE}`)
const portal = definition('Portal', `OU=Portal,${BASE}`)

const group = (cn: string, ou: string): EntitlementV2025 => {
    const dn = `CN=${cn},${ou},${BASE}`
    return { id: `grp-${cn}`, name: dn, value: dn, attribute: 'memberOf' }
}
const groups = [
    group('Payroll_Users', 'OU=Prod,OU=Payroll'),
    group('Payroll_Dev', 'OU=Dev,OU=Payroll'),
    group('Portal Users', 'OU=Portal'),
    group('Elsewhere', 'OU=Other'),
]

const owned = (name: string, extra: Record<string, unknown> = {}) => ({
    id: `ap-${name}`,
    name,
    description: describeOwned(name, name),
    source: { id: DIRECTORY },
    enabled: true,
    ...extra,
})

const ownedApp = (name: string) => ({
    id: `app-${name}`,
    name,
    description: describeOwned(name, name),
    accountSource: { id: DIRECTORY },
})

const WRITES = [
    'createAccessProfile',
    'updateAccessProfile',
    'createApp',
    'updateSourceAccessProfiles',
    'deleteAccessProfile',
    'deleteSourceApp',
] as const

function makeClient(overrides: Partial<Record<keyof OuApplicationClient, jest.Mock>> = {}) {
    let created = 0
    const client: Record<keyof OuApplicationClient, jest.Mock> = {
        resolveSourceByName: jest.fn(async (name: string) => ({
            id: DIRECTORY,
            name,
            owner: { id: 'owner-1', type: 'IDENTITY' },
        })),
        listEntitlements: jest.fn(async () => groups),
        searchAccessProfilesByNames: jest.fn(async () => []),
        listAppsByName: jest.fn(async () => []),
        listMarkedAccessProfiles: jest.fn(async () => []),
        listMarkedApps: jest.fn(async () => []),
        getAppAccessProfiles: jest.fn(async () => []),
        createAccessProfile: jest.fn(async (name: string) => ({ id: `ap-new-${++created}`, name })),
        updateAccessProfile: jest.fn(async (id: string) => ({ id })),
        createApp: jest.fn(async (name: string) => ({ id: `app-new-${name}`, name })),
        updateSourceAccessProfiles: jest.fn(async (id: string) => ({ id })),
        deleteAccessProfile: jest.fn(async () => undefined),
        deleteSourceApp: jest.fn(async () => undefined),
        ...overrides,
    }
    return client
}
type Client = ReturnType<typeof makeClient>
const run = (client: Client, definitions: OuApplicationDefinition[]) =>
    aggregateOuApplications(client as unknown as OuApplicationClient, definitions)
const expectNoWrites = (client: Client) => {
    for (const method of WRITES) expect(client[method]).not.toHaveBeenCalled()
}

beforeAll(() => {
    timing.appReadyDelayMs = 0
})

describe('aggregateOuApplications: create and update', () => {
    it('creates one marked, non-requestable access profile and app per definition', async () => {
        const client = makeClient()
        const report = await run(client, [payroll, portal])

        expect(report.applications.map((a) => [a.name, a.accessProfile, a.app, a.groups])).toEqual([
            ['Payroll', 'create', 'create', 2],
            ['Portal', 'create', 'create', 1],
        ])
        const call = client.createAccessProfile.mock.calls.find((c) => c[0] === 'Payroll')!
        expect(call[1]).toBe('owner-1')
        expect(call[2]).toBe(DIRECTORY)
        expect(call[3].map((r: any) => r.id).sort()).toEqual(['grp-Payroll_Dev', 'grp-Payroll_Users'])
        expect(call[4]).toBe(false)
        expect(call[6]).toBe('Payroll [AMC:Payroll]')
        expect(client.createApp).toHaveBeenCalledWith('Payroll', DIRECTORY, 'Payroll [AMC:Payroll]')
        const patch = client.updateSourceAccessProfiles.mock.calls.find((c) => c[0] === 'app-new-Payroll')![1]
        expect(patch).toEqual(
            expect.arrayContaining([
                { op: 'replace', path: '/accessProfiles', value: [expect.stringMatching(/^ap-new-/)] },
                { op: 'replace', path: '/appCenterEnabled', value: false },
                { op: 'replace', path: '/provisionRequestEnabled', value: false },
            ])
        )
    })

    it("loads each target source's groups once for all definitions", async () => {
        const client = makeClient()
        await run(client, [payroll, portal])
        expect(client.listEntitlements).toHaveBeenCalledTimes(1)
        expect(client.listEntitlements).toHaveBeenCalledWith(
            `source.id eq "${DIRECTORY}" and attribute eq "memberOf"`,
            'id'
        )
    })

    it('leaves matching owned objects alone and updates owned objects that differ', async () => {
        const client = makeClient({
            searchAccessProfilesByNames: jest.fn(async () => [
                owned('Payroll', { entitlements: [{ id: 'grp-Payroll_Users' }, { id: 'grp-Payroll_Dev' }] }),
                owned('Portal', { entitlements: [{ id: 'grp-Old' }] }),
            ]),
            listAppsByName: jest.fn(async (name: string) => [ownedApp(name)]),
            getAppAccessProfiles: jest.fn(async (id: string) => (id === 'app-Payroll' ? ['ap-Payroll'] : ['ap-x'])),
        })
        const report = await run(client, [payroll, portal])

        expect(report.applications.map((a) => [a.name, a.accessProfile, a.app])).toEqual([
            ['Payroll', 'unchanged', 'unchanged'],
            ['Portal', 'update', 'update'],
        ])
        expect(client.createAccessProfile).not.toHaveBeenCalled()
        expect(client.createApp).not.toHaveBeenCalled()
        expect(client.updateAccessProfile).toHaveBeenCalledTimes(1)
        expect(client.updateAccessProfile.mock.calls[0][0]).toBe('ap-Portal')
        expect(client.updateSourceAccessProfiles).toHaveBeenCalledTimes(1)
        expect(client.updateSourceAccessProfiles.mock.calls[0][1]).toContainEqual({
            op: 'replace',
            path: '/accessProfiles',
            value: ['ap-Portal'],
        })
    })

    it('reports marked objects whose definition is gone as orphans, without deleting them', async () => {
        const client = makeClient({
            listMarkedAccessProfiles: jest.fn(async () => [
                { id: 'ap-old', name: 'Retired', markedBy: 'Retired' },
                { id: 'ap-Payroll', name: 'Payroll', markedBy: 'Payroll' },
            ]),
            listMarkedApps: jest.fn(async () => [{ id: 'app-old', name: 'Retired', markedBy: 'Retired' }]),
        })
        const report = await run(client, [payroll])
        expect(report.orphans).toEqual({ accessProfiles: ['Retired'], apps: ['Retired'] })
        expect(client.deleteAccessProfile).not.toHaveBeenCalled()
        expect(client.deleteSourceApp).not.toHaveBeenCalled()
    })

    it('throws after the run when a write fails, and does not link an app to a missing profile', async () => {
        const client = makeClient({
            createAccessProfile: jest.fn(async (name: string) => {
                if (name === 'Portal') throw new Error('boom')
                return { id: 'ap-new-payroll', name }
            }),
        })
        await expect(run(client, [payroll, portal])).rejects.toThrow(/access profile "Portal" create: Error: boom/)
        expect(client.createApp).toHaveBeenCalledWith('Payroll', DIRECTORY, expect.any(String))
        expect(client.createApp).not.toHaveBeenCalledWith('Portal', expect.anything(), expect.anything())
    })
})

describe('aggregateOuApplications: no writes unless every check passes', () => {
    it('dry run reports the plan and writes nothing', async () => {
        const client = makeClient()
        const report = await run(client, [
            { ...payroll, dryRun: true },
            { ...portal, dryRun: 'true' as any },
        ])
        expect(report.applications.every((a) => a.dryRun)).toBe(true)
        expect(report.applications.map((a) => a.accessProfile)).toEqual(['create', 'create'])
        expectNoWrites(client)
    })

    it('dry run applies per definition', async () => {
        const client = makeClient()
        await run(client, [{ ...payroll, dryRun: true }, portal])
        expect(client.createAccessProfile).toHaveBeenCalledTimes(1)
        expect(client.createAccessProfile.mock.calls[0][0]).toBe('Portal')
    })

    it('fails on invalid definitions before reading the tenant', async () => {
        const client = makeClient()
        await expect(run(client, [payroll, definition('Payroll', `OU=Other,${BASE}`)])).rejects.toBeInstanceOf(
            OuApplicationError
        )
        expect(client.resolveSourceByName).not.toHaveBeenCalled()
        expectNoWrites(client)
    })

    it('fails on an OU with no groups, for every definition', async () => {
        const client = makeClient()
        await expect(run(client, [payroll, definition('Missing', `OU=Missing,${BASE}`)])).rejects.toThrow(
            /no groups found under "ou=missing/
        )
        expect(client.searchAccessProfilesByNames).not.toHaveBeenCalled()
        expectNoWrites(client)
    })

    it('fails on a name held by an unmarked access profile', async () => {
        const client = makeClient({
            searchAccessProfilesByNames: jest.fn(async () => [owned('Payroll', { description: 'Hand built' })]),
        })
        const error: OuApplicationError = await run(client, [payroll, portal]).catch((e) => e)
        expect(error).toBeInstanceOf(OuApplicationError)
        expect(error.problems).toEqual([expect.stringContaining('access profile "Payroll": its description lacks')])
        expectNoWrites(client)
    })

    it('fails on a name held by an app on another source', async () => {
        const client = makeClient({
            listAppsByName: jest.fn(async (name: string) =>
                name === 'Portal' ? [{ ...ownedApp(name), accountSource: { id: OTHER } }] : []
            ),
        })
        await expect(run(client, [payroll, portal])).rejects.toThrow(/app "Portal": it belongs to another source/)
        expectNoWrites(client)
    })

    it('fails when the target source has no owner', async () => {
        const client = makeClient({ resolveSourceByName: jest.fn(async (name: string) => ({ id: DIRECTORY, name })) })
        await expect(run(client, [payroll])).rejects.toThrow(/has no owner/)
        expectNoWrites(client)
    })
})

describe('aggregateOuApplications: delete mode', () => {
    const markedClient = () =>
        makeClient({
            listMarkedAccessProfiles: jest.fn(async () => [
                { id: 'ap-Payroll', name: 'Payroll', markedBy: 'Payroll' },
                { id: 'ap-Portal', name: 'Portal', markedBy: 'Portal' },
            ]),
            listMarkedApps: jest.fn(async () => [{ id: 'app-Payroll', name: 'Payroll', markedBy: 'Payroll' }]),
        })

    it("deletes only that definition's marked objects, app first, without loading groups", async () => {
        const client = markedClient()
        const order: string[] = []
        client.deleteSourceApp.mockImplementation(async (id: string) => void order.push(id))
        client.deleteAccessProfile.mockImplementation(async (id: string) => void order.push(id))

        const report = await run(client, [{ ...payroll, deleteMode: true }])

        expect(order).toEqual(['app-Payroll', 'ap-Payroll'])
        expect(report.applications[0]).toMatchObject({ accessProfile: 'delete', app: 'delete' })
        expect(report.orphans.accessProfiles).toEqual(['Portal'])
        expect(client.listEntitlements).not.toHaveBeenCalled()
    })

    it('reports absent when nothing is marked for the definition', async () => {
        const client = makeClient()
        const report = await run(client, [{ ...payroll, deleteMode: true }])
        expect(report.applications[0]).toMatchObject({ accessProfile: 'absent', app: 'absent' })
        expectNoWrites(client)
    })

    it('dry run lists what would be deleted and deletes nothing', async () => {
        const client = markedClient()
        const report = await run(client, [{ ...payroll, deleteMode: true, dryRun: true }])
        expect(report.applications[0]).toMatchObject({ accessProfile: 'delete', app: 'delete', dryRun: true })
        expectNoWrites(client)
    })
})

describe('checkOuApplications', () => {
    it('validates definitions and resolves each target source once, without writing', async () => {
        const client = makeClient()
        await checkOuApplications(client as unknown as OuApplicationClient, [payroll, portal])
        expect(client.resolveSourceByName).toHaveBeenCalledTimes(1)
        expect(client.resolveSourceByName).toHaveBeenCalledWith('Directory')
        expectNoWrites(client)
    })

    it('fails on invalid definitions', async () => {
        const client = makeClient()
        await expect(
            checkOuApplications(client as unknown as OuApplicationClient, [definition('No OUs')])
        ).rejects.toThrow(/no organizational units/)
    })
})
