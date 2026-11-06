import {
    AccessProfilesV2025Api,
    AccessProfilesV2025ApiCreateAccessProfileRequest,
    AccessProfilesV2025ApiListAccessProfilesRequest,
    AccessProfilesV2025ApiPatchAccessProfileRequest,
    AccessProfileV2025,
    AppsV2025Api,
    AppsV2025ApiCreateSourceAppRequest,
    AppsV2025ApiGetSourceAppRequest,
    AppsV2025ApiListAccessProfilesForSourceAppRequest,
    AppsV2025ApiListAllSourceAppRequest,
    AppsV2025ApiPatchSourceAppRequest,
    Configuration,
    ConfigurationParameters,
    EntitlementBulkUpdateRequestV2025,
    EntitlementRefV2025,
    EntitlementRequestConfigV2025,
    EntitlementsV2025Api,
    EntitlementsV2025ApiListEntitlementsRequest,
    EntitlementsV2025ApiPutEntitlementRequestConfigRequest,
    EntitlementsV2025ApiUpdateEntitlementsInBulkRequest,
    EntitlementV2025,
    JsonPatchOperationV2025,
    Paginator,
    PublicIdentitiesConfigApi,
    PublicIdentityConfig,
    RequestabilityForRoleV2025,
    RequestabilityV2025,
    RoleMembershipSelectorV2025,
    RolesV2025Api,
    RolesV2025ApiCreateRoleRequest,
    RolesV2025ApiListRolesRequest,
    RolesV2025ApiPatchRoleRequest,
    RoleV2025,
    SearchV2025,
    SearchV2025Api,
    SourceAppV2025,
    SourcesApi,
    SourcesV2025Api,
    SourceV2025,
} from 'sailpoint-api-client'
import { logger } from '@sailpoint/connector-sdk'
import axios from 'axios'
import axiosRetry from 'axios-retry'
import { TOKEN_URL_PATH } from './data/constants'
import { Config } from './model/config'
import { retriesConfig } from './axios'
import { throttle } from './utils/throttle'
import { MappingColumns } from './utils/mapping-source'
import { planMappingSourceSetup } from './utils/mapping-source-setup'
import { hasOwnershipMarker } from './utils/ownership'

// Lightweight types for search results - only keep essential fields to reduce memory
export interface LightweightAccessProfile {
    id: string
    name: string
    description?: string | null
    source?: { id?: string } | null
    entitlements?: Array<{ id?: string | null }> | null
    requestable?: boolean
    accessRequestConfig?: unknown
    enabled?: boolean
    app?: {
        id?: string
        name?: string
        accountSource?: { id?: string } | null
    }
}

export interface LightweightRole {
    id: string
    name: string
    entitlements?: Array<{ id?: string | null }> | null
    requestable?: boolean
    accessRequestConfig?: unknown
    membership?: unknown
    enabled?: boolean
}

export class ISCClient {
    private config: Configuration
    private static throttleInterceptorId: number | null = null

    constructor(config: Config) {
        const conf: ConfigurationParameters = {
            baseurl: config.baseurl,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            tokenUrl: new URL(config.baseurl).origin + TOKEN_URL_PATH,
        }
        this.config = new Configuration(conf)
        this.config.retriesConfig = retriesConfig
        this.config.experimental = true
        axiosRetry(axios as any, retriesConfig)

        // Throttle: 100 requests per 10 seconds (ISC rate limit)
        if (ISCClient.throttleInterceptorId === null) {
            ISCClient.throttleInterceptorId = axios.interceptors.request.use(
                async (config) => {
                    await throttle()
                    return config
                },
                (error) => Promise.reject(error)
            )
        }
    }

    async getPublicIdentityConfig(): Promise<PublicIdentityConfig> {
        const api = new PublicIdentitiesConfigApi(this.config)

        const response = await api.getPublicIdentityConfig()

        return response.data
    }

    async listSources() {
        const api = new SourcesApi(this.config)

        const response = await Paginator.paginate(api, api.listSources)

        return response.data
    }

    /**
     * Resolve a source by exact name. Throws if no source or more than one source has that name.
     */
    async resolveSourceByName(name: string): Promise<SourceV2025> {
        const api = new SourcesV2025Api(this.config)
        const response = await api.listSources({ filters: `name eq "${name}"` })
        const matches = response.data.filter((source) => source.name === name)
        if (matches.length === 0) throw new Error(`Source "${name}" not found`)
        if (matches.length > 1) throw new Error(`${matches.length} sources are named "${name}"`)
        return matches[0]
    }

    /**
     * Bring the mapping source's group schema and delimited-file settings in line with the mapping columns,
     * so an entitlement CSV upload loads one entitlement per row. Only adds or fixes; never removes.
     * Requires the PAT owner to be allowed to update the source and its schemas.
     * Returns the changes made, or the changes that would be made when dryRun is true.
     */
    async applyMappingSourceSetup(source: SourceV2025, columns: MappingColumns, dryRun = false): Promise<string[]> {
        const api = new SourcesV2025Api(this.config)
        const applied: string[] = []
        try {
            const schemas = (await api.getSourceSchemas({ sourceId: source.id! })).data
            const setup = planMappingSourceSetup(
                schemas,
                source.connectorAttributes as Record<string, any> | undefined,
                columns
            )
            if (setup.schema) {
                if (!dryRun) {
                    await api.putSourceSchema({
                        sourceId: source.id!,
                        schemaId: setup.schema.id!,
                        schemaV2025: setup.schema,
                    })
                }
                applied.push(`schema ${setup.schema.name}`)
            }
            if (setup.connectorAttributePatch.length > 0) {
                if (!dryRun) {
                    await api.updateSource({ id: source.id!, jsonPatchOperationV2025: setup.connectorAttributePatch })
                }
                applied.push(...setup.connectorAttributePatch.map((op) => op.path.replace('/connectorAttributes/', '')))
            }
        } catch (error: any) {
            if (error?.response?.status === 403) {
                throw new Error(
                    `Not allowed to update mapping source "${source.name}". The PAT owner needs permission to update sources and source schemas.`
                )
            }
            throw error
        }
        return applied
    }

    async listEntitlements(filters: string, sorters?: string): Promise<EntitlementV2025[]> {
        const api = new EntitlementsV2025Api(this.config)
        const requestParameters: EntitlementsV2025ApiListEntitlementsRequest = {
            filters,
            sorters,
        }
        const response = await Paginator.paginate(api, api.listEntitlements, requestParameters)
        return response.data as EntitlementV2025[]
    }

    async getAccessProfileByName(name: string): Promise<AccessProfileV2025 | undefined> {
        const api = new AccessProfilesV2025Api(this.config)
        const filters = `name eq "${name}"`
        const requestParameters: AccessProfilesV2025ApiListAccessProfilesRequest = {
            filters,
        }
        const response = await api.listAccessProfiles(requestParameters)
        return response.data[0] ? response.data[0] : undefined
    }

    async getRoleByName(name: string): Promise<RoleV2025 | undefined> {
        const api = new RolesV2025Api(this.config)
        const filters = `name eq "${name}"`
        const requestParameters: RolesV2025ApiListRolesRequest = {
            filters,
        }
        const response = await api.listRoles(requestParameters)
        return response.data[0] ? response.data[0] : undefined
    }

    async getAppByName(name: string): Promise<SourceAppV2025 | undefined> {
        const api = new AppsV2025Api(this.config)
        const filters = `name eq "${name}"`
        const requestParameters: AppsV2025ApiListAllSourceAppRequest = {
            filters,
        }

        const response = await api.listAllSourceApp(requestParameters)
        return response.data[0] ? response.data[0] : undefined
    }

    /**
     * All source apps with an exact name, tenant-wide. Used by the mapping-mode ownership check.
     */
    async listAppsByName(name: string): Promise<SourceAppV2025[]> {
        const api = new AppsV2025Api(this.config)
        const requestParameters: AppsV2025ApiListAllSourceAppRequest = {
            filters: `name eq "${name}"`,
            xSailPointExperimental: 'true',
        }
        const response = await api.listAllSourceApp(requestParameters)
        return response.data.filter((app) => app.name === name)
    }

    async getAppById(id: string): Promise<SourceAppV2025> {
        const api = new AppsV2025Api(this.config)
        const requestParameters: AppsV2025ApiGetSourceAppRequest = {
            id,
            xSailPointExperimental: 'true',
        }
        const response = await api.getSourceApp(requestParameters)
        return response.data
    }

    async getAppAccessProfiles(appId: string): Promise<string[]> {
        const api = new AppsV2025Api(this.config)
        const requestParameters: AppsV2025ApiListAccessProfilesForSourceAppRequest = {
            id: appId,
            xSailPointExperimental: 'true',
        }
        const response = await api.listAccessProfilesForSourceApp(requestParameters)
        return response.data.map((ap: any) => ap.id).filter(Boolean)
    }

    async createApp(name: string, sourceId: string, description: string = name): Promise<SourceAppV2025> {
        const api = new AppsV2025Api(this.config)
        const requestParameters: AppsV2025ApiCreateSourceAppRequest = {
            sourceAppCreateDtoV2025: {
                name,
                description,
                accountSource: {
                    id: sourceId,
                },
            },
            xSailPointExperimental: 'true',
        }
        const response = await api.createSourceApp(requestParameters)
        return response.data
    }

    async updateSourceAccessProfiles(
        id: string,
        jsonPatchOperationV2025: JsonPatchOperationV2025[]
    ): Promise<SourceAppV2025> {
        const api = new AppsV2025Api(this.config)

        const requestParameters: AppsV2025ApiPatchSourceAppRequest = {
            id,
            jsonPatchOperationV2025,
            xSailPointExperimental: 'true',
        }
        const response = await api.patchSourceApp(requestParameters)
        return response.data
    }

    async getSource(id: string): Promise<SourceAppV2025> {
        const api = new SourcesV2025Api(this.config)
        const requestParameters: AppsV2025ApiGetSourceAppRequest = {
            id,
        }
        const response = await api.getSource(requestParameters)
        return response.data
    }

    async createAccessProfile(
        name: string,
        ownerId: string,
        sourceId: string,
        entitlements: EntitlementRefV2025[],
        requestable: boolean = false,
        accessRequestConfig?: RequestabilityV2025,
        description: string = name
    ): Promise<AccessProfileV2025> {
        const api = new AccessProfilesV2025Api(this.config)
        const requestParameters: AccessProfilesV2025ApiCreateAccessProfileRequest = {
            accessProfileV2025: {
                name,
                description,
                owner: {
                    id: ownerId,
                    type: 'IDENTITY',
                },
                source: {
                    id: sourceId,
                },
                enabled: true,
                entitlements,
                requestable,
            },
        }
        if (accessRequestConfig) requestParameters.accessProfileV2025.accessRequestConfig = accessRequestConfig
        const response = await api.createAccessProfile(requestParameters)
        return response.data
    }

    async updateAccessProfile(
        id: string,
        jsonPatchOperationV2025: JsonPatchOperationV2025[]
    ): Promise<AccessProfileV2025> {
        const api = new AccessProfilesV2025Api(this.config)
        const requestParameters: AccessProfilesV2025ApiPatchAccessProfileRequest = {
            id,
            jsonPatchOperationV2025,
        }
        const response = await api.patchAccessProfile(requestParameters)
        return response.data
    }

    async createRole(
        name: string,
        ownerId: string,
        entitlements: EntitlementRefV2025[],
        requestable: boolean = false,
        accessRequestConfig?: RequestabilityForRoleV2025,
        membership?: RoleMembershipSelectorV2025
    ): Promise<RoleV2025> {
        const api = new RolesV2025Api(this.config)
        const requestParameters: RolesV2025ApiCreateRoleRequest = {
            roleV2025: {
                name,
                description: name,
                owner: {
                    id: ownerId,
                    type: 'IDENTITY',
                },
                requestable,
                entitlements,
                accessRequestConfig,
                enabled: true,
            },
        }
        if (accessRequestConfig) requestParameters.roleV2025.accessRequestConfig = accessRequestConfig
        if (membership) requestParameters.roleV2025.membership = membership
        const response = await api.createRole(requestParameters)
        return response.data
    }

    async updateRole(id: string, jsonPatchOperationV2025: JsonPatchOperationV2025[]): Promise<RoleV2025> {
        const api = new RolesV2025Api(this.config)
        const requestParameters: RolesV2025ApiPatchRoleRequest = {
            id,
            jsonPatchOperationV2025,
        }
        const response = await api.patchRole(requestParameters)
        return response.data
    }

    /**
     * Bulk update entitlements (requestable, privileged, etc.). Max 50 entitlements per request.
     * @see https://developer.sailpoint.com/docs/api/v2025/update-entitlements-in-bulk
     */
    async updateEntitlementsInBulk(
        entitlementIds: string[],
        jsonPatch: JsonPatchOperationV2025[]
    ): Promise<void> {
        const api = new EntitlementsV2025Api(this.config)
        const body: EntitlementBulkUpdateRequestV2025 = {
            entitlementIds,
            jsonPatch,
        }
        const requestParameters: EntitlementsV2025ApiUpdateEntitlementsInBulkRequest = {
            entitlementBulkUpdateRequestV2025: body,
        }
        await api.updateEntitlementsInBulk(requestParameters)
    }

    /**
     * Replace entitlement request config (approval schemes) for a single entitlement.
     * @see https://developer.sailpoint.com/docs/api/v2025/put-entitlement-request-config
     */
    async putEntitlementRequestConfig(
        id: string,
        entitlementRequestConfigV2025: EntitlementRequestConfigV2025
    ): Promise<EntitlementRequestConfigV2025> {
        const api = new EntitlementsV2025Api(this.config)
        const requestParameters: EntitlementsV2025ApiPutEntitlementRequestConfigRequest = {
            id,
            entitlementRequestConfigV2025,
        }
        const response = await api.putEntitlementRequestConfig(requestParameters)
        return response.data
    }

    /**
     * List access profiles filtered by source IDs. Uses source.id in ("id1","id2") filter.
     */
    async listAccessProfilesBySources(sourceIds: string[]): Promise<AccessProfileV2025[]> {
        if (sourceIds.length === 0) return []
        const api = new AccessProfilesV2025Api(this.config)
        const filterValue = sourceIds.map((id) => `"${id}"`).join(',')
        const filters = `source.id in (${filterValue})`
        const requestParameters: AccessProfilesV2025ApiListAccessProfilesRequest = { filters }
        const response = await Paginator.paginate(api, api.listAccessProfiles as any, requestParameters)
        return response.data as AccessProfileV2025[]
    }

    /**
     * List source apps filtered by account source IDs.
     */
    async listAppsBySources(sourceIds: string[]): Promise<SourceAppV2025[]> {
        if (sourceIds.length === 0) return []
        const api = new AppsV2025Api(this.config)
        const filterValue = sourceIds.map((id) => `"${id}"`).join(',')
        const filters = `accountSource.id in (${filterValue})`
        const requestParameters: AppsV2025ApiListAllSourceAppRequest = {
            filters,
            xSailPointExperimental: 'true',
        }
        const response = await Paginator.paginate(api, api.listAllSourceApp as any, requestParameters)
        return response.data as SourceAppV2025[]
    }

    /**
     * Access profiles on a source that carry a mapping definition's ownership marker.
     */
    async listOwnedAccessProfiles(sourceId: string, definitionName: string): Promise<AccessProfileV2025[]> {
        const accessProfiles = await this.listAccessProfilesBySources([sourceId])
        return accessProfiles.filter((ap) => hasOwnershipMarker(ap.description, definitionName))
    }

    /**
     * Source apps on an account source that carry a mapping definition's ownership marker.
     */
    async listOwnedApps(sourceId: string, definitionName: string): Promise<SourceAppV2025[]> {
        const apps = await this.listAppsBySources([sourceId])
        return apps.filter((app) => hasOwnershipMarker(app.description, definitionName))
    }

    /**
     * List roles filtered by owner IDs.
     */
    async listRolesByOwners(ownerIds: string[]): Promise<RoleV2025[]> {
        if (ownerIds.length === 0) return []
        const api = new RolesV2025Api(this.config)
        const filterValue = ownerIds.map((id) => `"${id}"`).join(',')
        const filters = `owner.id in (${filterValue})`
        const requestParameters: RolesV2025ApiListRolesRequest = { filters }
        const response = await Paginator.paginate(api, api.listRoles as any, requestParameters)
        return response.data as RoleV2025[]
    }

    async deleteAccessProfile(id: string): Promise<void> {
        const api = new AccessProfilesV2025Api(this.config)
        await api.deleteAccessProfile({ id })
    }

    async deleteRole(id: string): Promise<void> {
        const api = new RolesV2025Api(this.config)
        await api.deleteRole({ id })
    }

    async deleteSourceApp(id: string): Promise<void> {
        const api = new AppsV2025Api(this.config)
        await api.deleteSourceApp({ id, xSailPointExperimental: 'true' })
    }

    /**
     * Search for access profiles by entitlement IDs using the Search API.
     * Batches up to 10 entitlements per query for efficiency.
     * Returns only essential fields to minimize memory usage.
     * @param entitlementIds List of entitlement IDs to search for
     * @returns Lightweight access profiles with only essential fields
     */
    async searchAccessProfilesByEntitlements(entitlementIds: string[]): Promise<LightweightAccessProfile[]> {
        if (entitlementIds.length === 0) return []
        const api = new SearchV2025Api(this.config)
        const results: LightweightAccessProfile[] = []
        const BATCH_SIZE = 10
        for (let i = 0; i < entitlementIds.length; i += BATCH_SIZE) {
            const batch = entitlementIds.slice(i, i + BATCH_SIZE)
            const query = batch.map((id) => `@entitlements(id:${id})`).join(' OR ')
            const searchRequest: SearchV2025 = {
                indices: ['accessprofiles' as any],
                query: { query } as any,
            }
            const response = await api.searchPost({ searchV2025: searchRequest })
            const accessProfiles = response.data as any[]
            
            for (const ap of accessProfiles) {
                if (ap.id && ap.name) {
                    results.push({
                        id: ap.id,
                        name: ap.name,
                        entitlements: ap.entitlements,
                        requestable: ap.requestable,
                        accessRequestConfig: ap.accessRequestConfig,
                        enabled: ap.enabled,
                        app: ap.app
                            ? {
                                  id: ap.app.id,
                                  name: ap.app.name,
                                  accountSource: ap.app.accountSource,
                              }
                            : undefined,
                    })
                }
            }
        }
        return results
    }

    /**
     * Search for roles by entitlement IDs using the Search API.
     * Batches up to 10 entitlements per query for efficiency.
     * Returns only essential fields to minimize memory usage.
     * @param entitlementIds List of entitlement IDs to search for
     * @returns Lightweight roles with only essential fields
     */
    async searchRolesByEntitlements(entitlementIds: string[]): Promise<LightweightRole[]> {
        if (entitlementIds.length === 0) return []
        const api = new SearchV2025Api(this.config)
        const results: LightweightRole[] = []
        const BATCH_SIZE = 10
        for (let i = 0; i < entitlementIds.length; i += BATCH_SIZE) {
            const batch = entitlementIds.slice(i, i + BATCH_SIZE)
            const query = batch.map((id) => `@entitlements(id:${id})`).join(' OR ')
            logger.debug(`Role search query batch ${i / BATCH_SIZE + 1}: ${query}`)
            const searchRequest: SearchV2025 = {
                indices: ['roles' as any],
                query: { query } as any,
            }
            const response = await api.searchPost({ searchV2025: searchRequest })
            const roles = response.data as any[]
            logger.debug(`Role search batch ${i / BATCH_SIZE + 1} returned ${roles.length} roles${roles.length > 0 ? ': ' + roles.map((r: any) => r.name).join(', ') : ''}`)
            
            for (const role of roles) {
                if (role.id && role.name) {
                    results.push({
                        id: role.id,
                        name: role.name,
                        entitlements: role.entitlements,
                        requestable: role.requestable,
                        accessRequestConfig: role.accessRequestConfig,
                        membership: role.membership,
                        enabled: role.enabled,
                    })
                }
            }
        }
        return results
    }

    /**
     * Fallback: Search for access profiles by exact name matches using the dedicated API.
     * Used when Search API returns no results (e.g., for special sources).
     * @param names Array of exact access profile names to search for
     * @returns Lightweight access profiles matching the given names
     */
    async searchAccessProfilesByNames(names: string[]): Promise<LightweightAccessProfile[]> {
        if (names.length === 0) return []
        logger.debug(`Fallback: Searching access profiles by name (${names.length} names)`)
        const api = new AccessProfilesV2025Api(this.config)
        const results: LightweightAccessProfile[] = []
        
        const response = await Paginator.paginate(api, api.listAccessProfiles as any, {})
        const allAccessProfiles = response.data as any[]
        
        for (const accessProfile of allAccessProfiles) {
            if (accessProfile.name && names.includes(accessProfile.name)) {
                results.push({
                    id: accessProfile.id!,
                    name: accessProfile.name,
                    description: accessProfile.description,
                    source: accessProfile.source ? { id: accessProfile.source.id } : undefined,
                    entitlements: accessProfile.entitlements,
                    requestable: accessProfile.requestable,
                    accessRequestConfig: accessProfile.accessRequestConfig,
                    enabled: accessProfile.enabled,
                    app: accessProfile.app
                        ? {
                              id: accessProfile.app.id,
                              name: accessProfile.app.name,
                              accountSource: accessProfile.app.accountSource,
                          }
                        : undefined,
                })
            }
        }
        logger.debug(`Fallback: Found ${results.length} access profiles by name: ${results.map(ap => ap.name).join(', ')}`)
        return results
    }

    /**
     * Fallback: Search for roles by exact name matches using the dedicated API.
     * Used when Search API returns no results (e.g., for special sources).
     * @param names Array of exact role names to search for
     * @returns Lightweight roles matching the given names
     */
    async searchRolesByNames(names: string[]): Promise<LightweightRole[]> {
        if (names.length === 0) return []
        logger.debug(`Fallback: Searching roles by name (${names.length} names)`)
        const api = new RolesV2025Api(this.config)
        const results: LightweightRole[] = []
        
        const response = await Paginator.paginate(api, api.listRoles as any, {})
        const allRoles = response.data as RoleV2025[]
        
        for (const role of allRoles) {
            if (role.name && names.includes(role.name)) {
                results.push({
                    id: role.id!,
                    name: role.name,
                    entitlements: role.entitlements,
                    requestable: role.requestable,
                    accessRequestConfig: role.accessRequestConfig,
                    membership: role.membership,
                    enabled: role.enabled,
                })
            }
        }
        logger.debug(`Fallback: Found ${results.length} roles by name: ${results.map(r => r.name).join(', ')}`)
        return results
    }
}
