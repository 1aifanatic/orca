import { join } from 'node:path'
import type { BotShareClient } from '../bots/sharing/bot-share-client'
import type { BotSharePicksStore } from '../bots/sharing/bot-share-picks-store'
import type { BotShareDownloadPolicy } from '../bots/sharing/bot-share-receive'
import type { BotShareService } from '../bots/sharing/bot-share-service'
import type { readBotShareable } from '../bots/sharing/bot-share-sources'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

export type BotShareClientSource = BotShareClient | (() => Promise<BotShareClient>)

type ReadShareableInput = Parameters<typeof readBotShareable>[0]

export type BotShareLoaderDeps = {
  listAutomations: () => ReadShareableInput['automations']
  listRepos: () => ReadShareableInput['repos']
}

/** Lazy loader for bot-sharing stores and services so sharing modules stay off the startup path. */
export class LazyBotShareServices {
  private sharePicks: Promise<BotSharePicksStore> | null = null
  private botShareClient: {
    client: BotShareClientSource
    download: BotShareDownloadPolicy
  } | null = null
  private botShareService: Promise<BotShareService> | null = null

  constructor(private readonly deps: BotShareLoaderDeps) {}

  picks(): Promise<BotSharePicksStore> {
    if (!this.sharePicks) {
      const loading = import('../bots/sharing/bot-share-picks-store')
        .then(
          ({ BotSharePicksStore }) =>
            new BotSharePicksStore(join(getProfileUserDataPath(), 'bot-share-picks.json'))
        )
        .catch((error) => {
          if (this.sharePicks === loading) {
            this.sharePicks = null
          }
          throw error
        })
      this.sharePicks = loading
    }
    return this.sharePicks
  }

  setClient(client: BotShareClientSource, download: BotShareDownloadPolicy): void {
    this.botShareClient = { client, download }
    this.botShareService = null
  }

  service(): Promise<BotShareService> {
    const config = this.botShareClient
    if (!config) {
      return Promise.reject(new Error('Sharing a bot needs the Orca desktop app.'))
    }
    if (!this.botShareService) {
      const loading = Promise.all([
        typeof config.client === 'function' ? config.client() : Promise.resolve(config.client),
        this.picks(),
        import('../bots/sharing/bot-share-service'),
        import('../bots/sharing/bot-package-export'),
        import('../bots/sharing/bot-share-sources')
      ])
        .then(
          ([client, picks, { BotShareService }, { BotShareCandidates }, { readBotShareable }]) =>
            new BotShareService({
              client,
              download: config.download,
              candidates: new BotShareCandidates(
                join(getProfileUserDataPath(), 'bot-share-candidates')
              ),
              picks,
              readShareable: (bot, skills) =>
                readBotShareable({
                  bot,
                  automations: this.deps.listAutomations(),
                  repos: this.deps.listRepos(),
                  ...skills
                })
            })
        )
        .catch((error) => {
          if (this.botShareService === loading) {
            this.botShareService = null
          }
          throw error
        })
      this.botShareService = loading
    }
    return this.botShareService
  }
}
