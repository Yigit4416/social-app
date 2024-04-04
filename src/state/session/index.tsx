import React from 'react'
import {
  AtpPersistSessionHandler,
  BSKY_LABELER_DID,
  BskyAgent,
} from '@atproto/api'
import {jwtDecode} from 'jwt-decode'

import {track} from '#/lib/analytics/analytics'
import {networkRetry} from '#/lib/async/retry'
import {IS_TEST_USER} from '#/lib/constants'
import {logEvent, LogEvents} from '#/lib/statsig/statsig'
import {hasProp} from '#/lib/type-guards'
import {logger} from '#/logger'
import * as persisted from '#/state/persisted'
import {PUBLIC_BSKY_AGENT} from '#/state/queries'
import {useLoggedOutViewControls} from '#/state/shell/logged-out'
import {useCloseAllActiveElements} from '#/state/util'
import {emitSessionDropped} from '../events'
import {readLabelers} from './agent-config'

/**
 * @deprecated use `agent` from `useSession` instead
 */
let __globalAgent: BskyAgent = PUBLIC_BSKY_AGENT

/**
 * NOTE
 * Never hold on to the object returned by this function.
 * Call `getAgent()` at the time of invocation to ensure
 * that you never have a stale agent.
 *
 * @deprecated use `agent` from `useSession` instead
 */
export function getAgent() {
  return __globalAgent
}

export type SessionAccount = persisted.PersistedAccount

export type StateContext = {
  agent: BskyAgent
  isInitialLoad: boolean
  isSwitchingAccounts: boolean
  hasSession: boolean
  accounts: SessionAccount[]
  currentAccount: SessionAccount | undefined
}
export type ApiContext = {
  createAccount: (props: {
    service: string
    email: string
    password: string
    handle: string
    inviteCode?: string
    verificationPhone?: string
    verificationCode?: string
  }) => Promise<void>
  login: (
    props: {
      service: string
      identifier: string
      password: string
    },
    logContext: LogEvents['account:loggedIn']['logContext'],
  ) => Promise<void>
  /**
   * A full logout. Clears the `currentAccount` from session, AND removes
   * access tokens from all accounts, so that returning as any user will
   * require a full login.
   */
  logout: (
    logContext: LogEvents['account:loggedOut']['logContext'],
  ) => Promise<void>
  /**
   * A partial logout. Clears the `currentAccount` from session, but DOES NOT
   * clear access tokens from accounts, allowing the user to return to their
   * other accounts without logging in.
   *
   * Used when adding a new account, deleting an account.
   */
  clearCurrentAccount: () => void
  initSession: (account: SessionAccount) => Promise<void>
  resumeSession: (account?: SessionAccount) => Promise<void>
  removeAccount: (account: SessionAccount) => void
  selectAccount: (
    account: SessionAccount,
    logContext: LogEvents['account:loggedIn']['logContext'],
  ) => Promise<void>
  /**
   * Refreshes the BskyAgent's session and derive a fresh `currentAccount`
   */
  refreshSession: () => void
}

const StateContext = React.createContext<StateContext>({
  agent: PUBLIC_BSKY_AGENT,
  isInitialLoad: true,
  isSwitchingAccounts: false,
  accounts: [],
  currentAccount: undefined,
  hasSession: false,
})

const ApiContext = React.createContext<ApiContext>({
  createAccount: async () => {},
  login: async () => {},
  logout: async () => {},
  initSession: async () => {},
  resumeSession: async () => {},
  removeAccount: () => {},
  selectAccount: async () => {},
  refreshSession: () => {},
  clearCurrentAccount: () => {},
})

function agentToSessionAccount(agent: BskyAgent): SessionAccount | undefined {
  if (!agent.session) return undefined

  return {
    service: agent.service.toString(),
    did: agent.session.did,
    handle: agent.session.handle,
    email: agent.session.email,
    emailConfirmed: agent.session.emailConfirmed,
    deactivated: isSessionDeactivated(agent.session.accessJwt),

    /*
     * Tokens are undefined if the session expires, or if creation fails for
     * any reason e.g. tokens are invalid, network error, etc.
     */
    refreshJwt: agent.session.refreshJwt,
    accessJwt: agent.session.accessJwt,
  }
}

function sessionAccountToAgentSession(
  account: SessionAccount,
): BskyAgent['session'] {
  return {
    did: account.did,
    handle: account.handle,
    email: account.email,
    emailConfirmed: account.emailConfirmed,
    accessJwt: account.accessJwt || '',
    refreshJwt: account.refreshJwt || '',
  }
}

function createPersistSessionHandler(
  account: SessionAccount,
  persistSessionCallback: (props: {
    expired: boolean
    refreshedAccount: SessionAccount
  }) => void,
  {
    networkErrorCallback,
  }: {
    networkErrorCallback?: () => void
  } = {},
): AtpPersistSessionHandler {
  return function persistSession(event, session) {
    const expired = event === 'expired' || event === 'create-failed'

    if (event === 'network-error') {
      logger.warn(`session: persistSessionHandler received network-error event`)
      networkErrorCallback?.()
      return
    }

    const refreshedAccount: SessionAccount = {
      service: account.service,
      did: session?.did || account.did,
      handle: session?.handle || account.handle,
      email: session?.email || account.email,
      emailConfirmed: session?.emailConfirmed || account.emailConfirmed,
      deactivated: isSessionDeactivated(session?.accessJwt),

      /*
       * Tokens are undefined if the session expires, or if creation fails for
       * any reason e.g. tokens are invalid, network error, etc.
       */
      refreshJwt: session?.refreshJwt,
      accessJwt: session?.accessJwt,
    }

    logger.debug(`session: persistSession`, {
      event,
      deactivated: refreshedAccount.deactivated,
    })

    if (expired) {
      logger.warn(`session: expired`)
      emitSessionDropped()
    }

    /*
     * If the session expired, or it was successfully created/updated, we want
     * to update/persist the data.
     *
     * If the session creation failed, it could be a network error, or it could
     * be more serious like an invalid token(s). We can't differentiate, so in
     * order to allow the user to get a fresh token (if they need it), we need
     * to persist this data and wipe their tokens, effectively logging them
     * out.
     */
    persistSessionCallback({
      expired,
      refreshedAccount,
    })
  }
}

export function Provider({children}: React.PropsWithChildren<{}>) {
  const isDirty = React.useRef(false)
  const [agent, setAgent] = React.useState<BskyAgent>(PUBLIC_BSKY_AGENT)
  const [accounts, setAccounts] = React.useState<SessionAccount[]>(
    persisted.get('session').accounts,
  )
  const [isInitialLoad, setIsInitialLoad] = React.useState(true)
  const [isSwitchingAccounts, setIsSwitchingAccounts] = React.useState(false)
  const currentAccount = React.useMemo(
    () => agentToSessionAccount(agent),
    [agent],
  )

  const persistNextUpdate = React.useCallback(
    () => (isDirty.current = true),
    [],
  )

  const upsertAccount = React.useCallback(
    (account: SessionAccount) => {
      persistNextUpdate()
      setAccounts(accounts => [
        account,
        ...accounts.filter(a => a.did !== account.did),
      ])
    },
    [setAccounts, persistNextUpdate],
  )

  const clearCurrentAccount = React.useCallback(() => {
    logger.warn(`session: clear current account`)

    persistNextUpdate()
    setAgent(PUBLIC_BSKY_AGENT)
    BskyAgent.configure({appLabelers: [BSKY_LABELER_DID]})
  }, [persistNextUpdate, setAgent])

  const createAccount = React.useCallback<ApiContext['createAccount']>(
    async ({
      service,
      email,
      password,
      handle,
      inviteCode,
      verificationPhone,
      verificationCode,
    }: any) => {
      logger.info(`session: creating account`)
      track('Try Create Account')
      logEvent('account:create:begin', {})

      const agent = new BskyAgent({service})

      await agent.createAccount({
        handle,
        password,
        email,
        inviteCode,
        verificationPhone,
        verificationCode,
      })

      if (!agent.session) {
        throw new Error(`session: createAccount failed to establish a session`)
      }

      const deactivated = isSessionDeactivated(agent.session.accessJwt)
      if (!deactivated) {
        /*dont await*/ agent.upsertProfile(_existing => {
          return {
            displayName: '',

            // HACKFIX
            // creating a bunch of identical profile objects is breaking the relay
            // tossing this unspecced field onto it to reduce the size of the problem
            // -prf
            createdAt: new Date().toISOString(),
          }
        })
      }

      const account = agentToSessionAccount(agent)!

      await configureModeration(agent, account)

      agent.setPersistSessionHandler(
        createPersistSessionHandler(
          account,
          ({expired, refreshedAccount}) => {
            upsertAccount(refreshedAccount)
            if (expired) clearCurrentAccount()
          },
          {networkErrorCallback: clearCurrentAccount},
        ),
      )

      setAgent(agent)
      upsertAccount(account)

      logger.debug(`session: created account`, {}, logger.DebugContext.session)
      track('Create Account')
      logEvent('account:create:success', {})
    },
    [upsertAccount, clearCurrentAccount],
  )

  const login = React.useCallback<ApiContext['login']>(
    async ({service, identifier, password}, logContext) => {
      logger.debug(`session: login`, {}, logger.DebugContext.session)

      const agent = new BskyAgent({service})
      await agent.login({identifier, password})

      if (!agent.session) {
        throw new Error(`session: login failed to establish a session`)
      }

      const account = agentToSessionAccount(agent)!
      await configureModeration(agent, account)

      agent.setPersistSessionHandler(
        createPersistSessionHandler(
          account,
          ({expired, refreshedAccount}) => {
            upsertAccount(refreshedAccount)
            if (expired) clearCurrentAccount()
          },
          {networkErrorCallback: clearCurrentAccount},
        ),
      )

      setAgent(agent)
      upsertAccount(account)

      logger.debug(`session: logged in`, {}, logger.DebugContext.session)

      track('Sign In', {resumedSession: false})
      logEvent('account:loggedIn', {logContext, withPassword: true})
    },
    [upsertAccount, clearCurrentAccount],
  )

  const logout = React.useCallback<ApiContext['logout']>(
    async logContext => {
      logger.debug(`session: logout`)

      clearCurrentAccount()
      persistNextUpdate()
      setAccounts(accounts =>
        accounts.map(a => ({
          ...a,
          accessJwt: undefined,
          refreshJwt: undefined,
        })),
      )

      logEvent('account:loggedOut', {logContext})
    },
    [clearCurrentAccount, persistNextUpdate, setAccounts],
  )

  const initSession = React.useCallback<ApiContext['initSession']>(
    async account => {
      logger.debug(`session: initSession`, {}, logger.DebugContext.session)

      const agent = new BskyAgent({
        service: account.service,
        persistSession: createPersistSessionHandler(
          account,
          ({expired, refreshedAccount}) => {
            upsertAccount(refreshedAccount)
            if (expired) clearCurrentAccount()
          },
          {networkErrorCallback: clearCurrentAccount},
        ),
      })

      const prevSession = {
        ...account,
        accessJwt: account.accessJwt || '',
        refreshJwt: account.refreshJwt || '',
      }

      let canReusePrevSession = false
      try {
        if (account.accessJwt) {
          const decoded = jwtDecode(account.accessJwt)
          if (decoded.exp) {
            const didExpire = Date.now() >= decoded.exp * 1000
            if (!didExpire) {
              canReusePrevSession = true
            }
          }
        }
      } catch (e) {
        logger.error(`session: could not decode jwt`)
      }

      // optimistic, we'll update this if we can't reuse or resume the session
      await configureModeration(agent, account)

      if (canReusePrevSession) {
        logger.debug(
          `session: attempting to reuse previous session`,
          {},
          logger.DebugContext.session,
        )
        agent.session = prevSession
        setAgent(agent)
        upsertAccount(account)
      } else {
        logger.debug(
          `session: attempting to resumeSession using previous session`,
          {},
          logger.DebugContext.session,
        )
        try {
          // will call `persistSession` on `BskyAgent` instance above if success
          await networkRetry(1, () => agent.resumeSession(prevSession))
          setAgent(agent)
        } catch (e) {
          logger.error(`session: resumeSession failed`, {message: e})
          clearCurrentAccount()
        }
      }
    },
    [upsertAccount, clearCurrentAccount],
  )

  const resumeSession = React.useCallback<ApiContext['resumeSession']>(
    async account => {
      try {
        if (account) {
          await initSession(account)
        }
      } catch (e) {
        logger.error(`session: resumeSession failed`, {message: e})
      } finally {
        setIsInitialLoad(false)
      }
    },
    [initSession, setIsInitialLoad],
  )

  const removeAccount = React.useCallback<ApiContext['removeAccount']>(
    account => {
      persistNextUpdate()
      setAccounts(accounts => accounts.filter(a => a.did !== account.did))
    },
    [setAccounts, persistNextUpdate],
  )

  const refreshSession = React.useCallback<
    ApiContext['refreshSession']
  >(async () => {
    await agent.refreshSession()
    persistNextUpdate()
    upsertAccount(agentToSessionAccount(agent)!)
    setAgent(agent.clone())
  }, [agent, setAgent, persistNextUpdate, upsertAccount])

  const selectAccount = React.useCallback<ApiContext['selectAccount']>(
    async (account, logContext) => {
      setIsSwitchingAccounts(true)
      try {
        await initSession(account)
        setIsSwitchingAccounts(false)
        logEvent('account:loggedIn', {logContext, withPassword: false})
      } catch (e) {
        // reset this in case of error
        setIsSwitchingAccounts(false)
        // but other listeners need a throw
        throw e
      }
    },
    [setIsSwitchingAccounts, initSession],
  )

  React.useEffect(() => {
    if (isDirty.current) {
      isDirty.current = false
      persisted.write('session', {
        accounts,
        currentAccount,
      })
    }
  }, [accounts, currentAccount])

  React.useEffect(() => {
    return persisted.onUpdate(async () => {
      const persistedSession = persisted.get('session')

      logger.debug(`session: persisted onUpdate`, {
        persistedCurrentAccount: persistedSession.currentAccount,
        currentAccount,
      })

      setAccounts(persistedSession.accounts)

      if (
        persistedSession.currentAccount &&
        persistedSession.currentAccount.refreshJwt
      ) {
        if (persistedSession.currentAccount?.did !== currentAccount?.did) {
          logger.debug(`session: persisted onUpdate, switching accounts`, {
            from: {
              did: currentAccount?.did,
              handle: currentAccount?.handle,
            },
            to: {
              did: persistedSession.currentAccount.did,
              handle: persistedSession.currentAccount.handle,
            },
          })

          await initSession(persistedSession.currentAccount)
        } else {
          logger.debug(`session: persisted onUpdate, updating session`, {})
          agent.session = sessionAccountToAgentSession(
            persistedSession.currentAccount,
          )
          setAgent(agent.clone())
        }
      } else if (!persistedSession.currentAccount && currentAccount) {
        logger.debug(
          `session: persisted onUpdate, logging out`,
          {},
          logger.DebugContext.session,
        )

        /*
         * No need to do a hard logout here. If we reach this, tokens for this
         * account have already been cleared either by an `expired` event
         * handled by `persistSession` (which nukes this accounts tokens only),
         * or by a `logout` call  which nukes all accounts tokens)
         */
        clearCurrentAccount()
      }
    })
  }, [
    currentAccount,
    setAccounts,
    clearCurrentAccount,
    initSession,
    agent,
    setAgent,
  ])

  const stateContext = React.useMemo(
    () => ({
      agent,
      isInitialLoad,
      isSwitchingAccounts,
      currentAccount,
      accounts,
      hasSession: Boolean(currentAccount),
    }),
    [agent, isInitialLoad, isSwitchingAccounts, accounts, currentAccount],
  )

  const api = React.useMemo(
    () => ({
      createAccount,
      login,
      logout,
      initSession,
      resumeSession,
      removeAccount,
      selectAccount,
      refreshSession,
      clearCurrentAccount,
    }),
    [
      createAccount,
      login,
      logout,
      initSession,
      resumeSession,
      removeAccount,
      selectAccount,
      refreshSession,
      clearCurrentAccount,
    ],
  )

  // as we migrate, continue to keep this updated
  __globalAgent = agent

  return (
    <StateContext.Provider value={stateContext}>
      <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
    </StateContext.Provider>
  )
}

async function configureModeration(agent: BskyAgent, account: SessionAccount) {
  if (IS_TEST_USER(account.handle)) {
    const did = (
      await agent
        .resolveHandle({handle: 'mod-authority.test'})
        .catch(_ => undefined)
    )?.data.did
    if (did) {
      console.warn('USING TEST ENV MODERATION')
      BskyAgent.configure({appLabelers: [did]})
    }
  } else {
    BskyAgent.configure({appLabelers: [BSKY_LABELER_DID]})
    const labelerDids = await readLabelers(account.did).catch(_ => {})
    if (labelerDids) {
      agent.configureLabelersHeader(
        labelerDids.filter(did => did !== BSKY_LABELER_DID),
      )
    }
  }
}

export function useSession() {
  return React.useContext(StateContext)
}

export function useSessionApi() {
  return React.useContext(ApiContext)
}

export function useRequireAuth() {
  const {hasSession} = useSession()
  const {setShowLoggedOut} = useLoggedOutViewControls()
  const closeAll = useCloseAllActiveElements()

  return React.useCallback(
    (fn: () => void) => {
      if (hasSession) {
        fn()
      } else {
        closeAll()
        setShowLoggedOut(true)
      }
    },
    [hasSession, setShowLoggedOut, closeAll],
  )
}

export function isSessionDeactivated(accessJwt: string | undefined) {
  if (accessJwt) {
    const sessData = jwtDecode(accessJwt)
    return (
      hasProp(sessData, 'scope') && sessData.scope === 'com.atproto.deactivated'
    )
  }
  return false
}
