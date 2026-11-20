import {
    createConnector,
    readConfig,
    logger,
    StdEntitlementListHandler,
    StdTestConnectionHandler,
    ConnectorError,
} from '@sailpoint/connector-sdk'
import { ISCClient } from './isc-client'
import { Config } from './model/config'
import { aggregateAccessProfiles, aggregateEntitlements, aggregateRoles } from './operations'

export const PROCESSINGWAIT = 60 * 1000
const safeErrorMessage = (error: unknown): string => {
    if (!(error instanceof Error)) return String(error)
    const response = (error as Error & { response?: { status?: number; data?: unknown } }).response
    const details = response?.data === undefined ? '' : `; response=${JSON.stringify(response.data)}`
    return `${error.name}: ${error.message}${response?.status ? `; status=${response.status}` : ''}${details}`
}

export const connector = async () => {
    const config: Config = await readConfig()
    logger.level = 'debug'
    const isc = new ISCClient(config)

    const stdTestConnection: StdTestConnectionHandler = async (context, input, res) => {
        try {
            await isc.getPublicIdentityConfig()
            res.send({})
        } catch (error) {
            const message = safeErrorMessage(error)
            logger.error(message)
            throw new ConnectorError(message)
        }
    }

    const stdEntitlementList: StdEntitlementListHandler = async (context, input, res) => {
        const interval = setInterval(() => {
            res.keepAlive()
        }, PROCESSINGWAIT)

        try {
            switch (input.type) {
                case 'accessProfile':
                    if (config.accessProfiles) {
                        logger.debug(`Processing ${config.accessProfiles.length} access profile definitions`)
                        for (const definition of config.accessProfiles) {
                            await aggregateAccessProfiles(config, isc, definition)
                        }
                    }
                    break
                case 'role':
                    if (config.roles) {
                        logger.debug(`Processing ${config.roles.length} roles`)
                        await aggregateRoles(config, isc)
                    }
                    break
                case 'entitlement':
                    if (config.entitlements) {
                        logger.debug(`Processing ${config.entitlements.length} entitlement definitions`)
                        await aggregateEntitlements(config, isc)
                    }
                    break
                default:
                    logger.debug(`Unknown entitlement type: ${input.type}`)
                    break
            }
        } catch (error) {
            const message = safeErrorMessage(error)
            logger.error(message)
            throw new ConnectorError(message)
        } finally {
            clearInterval(interval)
        }
    }

    return createConnector().stdTestConnection(stdTestConnection).stdEntitlementList(stdEntitlementList)
}
