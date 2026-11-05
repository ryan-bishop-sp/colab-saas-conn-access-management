import { checkOwnership, describeOwned, hasOwnershipMarker, ownershipMarker } from './ownership'

const definition = 'Test Apps'
const sourceId = 'src-directory'

describe('ownership marker', () => {
    it('builds and detects the marker for one definition only', () => {
        expect(ownershipMarker(definition)).toBe('[AMC:Test Apps]')
        expect(describeOwned('Payroll', definition)).toBe('Payroll [AMC:Test Apps]')
        expect(hasOwnershipMarker('Payroll [AMC:Test Apps]', definition)).toBe(true)
        expect(hasOwnershipMarker('Payroll [AMC:Other Apps]', definition)).toBe(false)
        expect(hasOwnershipMarker(undefined, definition)).toBe(false)
    })
})

describe('checkOwnership', () => {
    const owned = { id: 'ap-1', name: 'Payroll', description: describeOwned('Payroll', definition), sourceId }

    it('is absent when nothing has the name', () => {
        expect(checkOwnership('Payroll', [{ ...owned, name: 'Payroll Admins' }], sourceId, definition)).toEqual({
            status: 'absent',
        })
    })

    it('is owned when name, source and marker all match', () => {
        expect(checkOwnership('Payroll', [owned], sourceId, definition)).toEqual({ status: 'owned', id: 'ap-1' })
    })

    it('is not owned without the marker', () => {
        const result = checkOwnership('Payroll', [{ ...owned, description: 'Payroll' }], sourceId, definition)
        expect(result).toMatchObject({ status: 'not-owned', reason: expect.stringContaining('marker') })
    })

    it('is not owned on a different source', () => {
        const result = checkOwnership('Payroll', [{ ...owned, sourceId: 'src-other' }], sourceId, definition)
        expect(result).toMatchObject({ status: 'not-owned', reason: expect.stringContaining('another source') })
    })

    it("is not owned with another definition's marker", () => {
        const result = checkOwnership(
            'Payroll',
            [{ ...owned, description: describeOwned('Payroll', 'Other Apps') }],
            sourceId,
            definition
        )
        expect(result.status).toBe('not-owned')
    })

    it('is not owned when several objects share the name', () => {
        const result = checkOwnership('Payroll', [owned, { ...owned, id: 'ap-2' }], sourceId, definition)
        expect(result).toMatchObject({ status: 'not-owned', reason: '2 objects share this name' })
    })
})
