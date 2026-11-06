import { EntitlementV2025 } from 'sailpoint-api-client'
import { OuApplicationDefinition } from '../model/config'
import {
    OuApplicationError,
    isInSubtree,
    matchOuApplications,
    normalizeDn,
    splitDn,
    validateOuApplications,
} from './ou-applications'

const BASE = 'OU=Apps,DC=example,DC=com'

const definition = (name: string, ...organizationalUnits: string[]): OuApplicationDefinition => ({
    name,
    targetSourceName: 'Directory',
    organizationalUnits,
    requestable: false,
    requireApproval: false,
})

const group = (dn: string): EntitlementV2025 => ({ id: `grp-${dn}`, name: dn, value: dn, attribute: 'memberOf' })

const groups = [
    group(`CN=Payroll_Users,OU=Prod,OU=Payroll,${BASE}`),
    group(`CN=Payroll_Dev,OU=Dev,OU=Payroll,${BASE}`),
    group(`CN=Payroll_Root,OU=Payroll,${BASE}`),
    group(`CN=Portal Users,OU=Portal,${BASE}`),
    group(`CN=Smith\\, John Team,OU=Groups,OU=Portal,${BASE}`),
    group(`CN=Elsewhere,OU=Other,${BASE}`),
]

const expectError = (fn: () => unknown, kind: string, count: number): OuApplicationError => {
    try {
        fn()
    } catch (e) {
        expect(e).toBeInstanceOf(OuApplicationError)
        const error = e as OuApplicationError
        expect(error.kind).toBe(kind)
        expect(error.problems).toHaveLength(count)
        return error
    }
    throw new Error('expected an OuApplicationError')
}

describe('DN helpers', () => {
    it('splits on unescaped commas only', () => {
        expect(splitDn('CN=Smith\\, John,OU=Groups,DC=example')).toEqual([
            'CN=Smith\\, John',
            'OU=Groups',
            'DC=example',
        ])
    })

    it('normalizes case and whitespace around separators, keeping inner spaces', () => {
        expect(normalizeDn(' ou=Prod , OU=Payroll  App,DC=Example ')).toBe('ou=prod,ou=payroll app,dc=example')
    })

    it('matches anywhere in the subtree but not the OU itself or a sibling with a shared suffix', () => {
        const ou = normalizeDn(`OU=Payroll,${BASE}`)
        expect(isInSubtree(normalizeDn(`CN=A,OU=Prod,OU=Payroll,${BASE}`), ou)).toBe(true)
        expect(isInSubtree(normalizeDn(`CN=A,OU=Payroll,${BASE}`), ou)).toBe(true)
        expect(isInSubtree(ou, ou)).toBe(false)
        expect(isInSubtree(normalizeDn(`CN=A,OU=OldPayroll,${BASE}`), ou)).toBe(false)
    })
})

describe('validateOuApplications', () => {
    it('normalizes OUs, accepts a single string, and drops OUs nested in another OU of the same app', () => {
        const [app] = validateOuApplications([
            {
                ...definition('Payroll'),
                organizationalUnits: [`OU=Payroll,${BASE}`, `OU=Prod,OU=Payroll,${BASE}`, `ou=payroll, ${BASE}`],
            },
        ])
        expect(app.organizationalUnits).toEqual([normalizeDn(`OU=Payroll,${BASE}`)])
        const [single] = validateOuApplications([
            { ...definition('Portal'), organizationalUnits: `OU=Portal,${BASE}` as any },
        ])
        expect(single.organizationalUnits).toHaveLength(1)
    })

    it('fails on every invalid definition at once', () => {
        const error = expectError(
            () =>
                validateOuApplications([
                    definition('', `OU=A,${BASE}`),
                    definition('Bad [name]', `OU=B,${BASE}`),
                    definition('No OUs'),
                    definition('Not OU', `CN=Group,${BASE}`, 'garbage'),
                    { ...definition('No Source', `OU=C,${BASE}`), targetSourceName: '' },
                ]),
            'Invalid OU application definitions',
            5
        )
        expect(error.problems[0]).toContain('missing application name')
        expect(error.problems[1]).toContain('must not contain [ or ]')
        expect(error.problems[2]).toContain('no organizational units')
        expect(error.problems[3]).toContain('not an OU distinguished name: "CN=Group')
        expect(error.problems[4]).toContain('missing target source name')
    })

    it('fails on duplicate application names, ignoring case', () => {
        expectError(
            () =>
                validateOuApplications([definition('Payroll', `OU=A,${BASE}`), definition('payroll', `OU=B,${BASE}`)]),
            'Invalid OU application definitions',
            1
        )
    })

    it('fails when two applications list the same OU or one OU sits inside another', () => {
        const error = expectError(
            () =>
                validateOuApplications([
                    definition('Payroll', `OU=Payroll,${BASE}`),
                    definition('Payroll Prod', `OU=Prod,OU=Payroll,${BASE}`),
                    definition('Payroll Again', `ou=payroll,${BASE}`),
                ]),
            'Invalid OU application definitions',
            3
        )
        expect(error.problems).toEqual(
            expect.arrayContaining([
                expect.stringContaining('of "Payroll Prod" is inside OU'),
                expect.stringContaining('is listed by both "Payroll" and "Payroll Again"'),
            ])
        )
    })

    it('allows the same OU on different target sources', () => {
        expect(
            validateOuApplications([
                definition('Payroll', `OU=Payroll,${BASE}`),
                { ...definition('Payroll Test', `OU=Payroll,${BASE}`), targetSourceName: 'Test Directory' },
            ])
        ).toHaveLength(2)
    })
})

describe('matchOuApplications', () => {
    it('collects every group in each OU subtree, de-duplicated across OUs', () => {
        const apps = validateOuApplications([
            definition('Payroll', `OU=Payroll,${BASE}`),
            definition('Portal', `OU=Portal,${BASE}`),
        ])
        const [payroll, portal] = matchOuApplications(apps, groups)
        expect(payroll.entitlements.map((e) => e.name).sort()).toEqual([
            `CN=Payroll_Dev,OU=Dev,OU=Payroll,${BASE}`,
            `CN=Payroll_Root,OU=Payroll,${BASE}`,
            `CN=Payroll_Users,OU=Prod,OU=Payroll,${BASE}`,
        ])
        expect(portal.entitlements).toHaveLength(2)
        expect(portal.groupsPerOu).toEqual({ [normalizeDn(`OU=Portal,${BASE}`)]: 2 })
    })

    it('combines several OUs into one application', () => {
        const apps = validateOuApplications([
            definition('Payroll', `OU=Prod,OU=Payroll,${BASE}`, `OU=Dev,OU=Payroll,${BASE}`),
        ])
        expect(matchOuApplications(apps, groups)[0].entitlements).toHaveLength(2)
    })

    it('fails on every OU that contains no groups', () => {
        const apps = validateOuApplications([
            definition('Payroll', `OU=Prod,OU=Payroll,${BASE}`, `OU=QA,OU=Payroll,${BASE}`),
            definition('Missing', `OU=Missing,${BASE}`),
        ])
        const error = expectError(() => matchOuApplications(apps, groups), 'Organizational units with no groups', 2)
        expect(error.problems[0]).toContain('"Payroll": no groups found under "ou=qa,ou=payroll')
        expect(error.problems[1]).toContain('"Missing"')
    })
})
