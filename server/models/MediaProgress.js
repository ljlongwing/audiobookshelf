const { DataTypes, Model, Op } = require('sequelize')
const Logger = require('../Logger')
const { isNullOrNaN, cleanStringForSearch } = require('../utils')

class MediaProgress extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {UUIDV4} */
    this.id
    /** @type {UUIDV4} */
    this.mediaItemId
    /** @type {string} */
    this.mediaItemType
    /** @type {number} */
    this.duration
    /** @type {number} */
    this.currentTime
    /** @type {boolean} */
    this.isFinished
    /** @type {boolean} */
    this.hideFromContinueListening
    /** @type {string} */
    this.ebookLocation
    /** @type {number} */
    this.ebookProgress
    /** @type {Date} */
    this.finishedAt
    /** @type {Object} */
    this.extraData
    /** @type {UUIDV4} */
    this.userId
    /** @type {Date} */
    this.updatedAt
    /** @type {Date} */
    this.createdAt
    /** @type {UUIDV4} */
    this.podcastId
  }

  static removeById(mediaProgressId) {
    return this.destroy({
      where: {
        id: mediaProgressId
      }
    })
  }

  /**
   * When a new book library item is created by a scan, look for media progress left behind by
   * missing (or deleted) library items in the same library and re-link it to the new book, so
   * users don't lose their listening progress when a folder is recreated and rescanned.
   *
   * Candidates are matched using a tiered check (the first tier with any match wins):
   *   1. Both ASINs non-empty and equal, and duration within 5 seconds
   *   2. Only for books where ASIN can't be compared on at least one side: normalized title and
   *      author names equal, and duration within 5 seconds
   *   3. Only when neither tier above matched: same number of audio files with an identical set
   *      of audio file byte sizes, and duration within 5 seconds - metadata-independent, catches
   *      files that were moved or copied with no tag changes
   * A tier with more than one match is ambiguous and is skipped entirely (nothing is relinked).
   * Users who already have progress on the new book are left alone.
   *
   * Best-effort: failures are logged and swallowed so a scan is never broken by this.
   *
   * @param {import('./LibraryItem').LibraryItemExpanded} newExpandedLibraryItem
   */
  static async relinkFromMissingItems(newExpandedLibraryItem) {
    if (newExpandedLibraryItem?.mediaType !== 'book' || !newExpandedLibraryItem.media) return

    try {
      const newBook = newExpandedLibraryItem.media
      const bookModel = this.sequelize.models.book
      const libraryItemModel = this.sequelize.models.libraryItem
      const authorModel = this.sequelize.models.author

      // Books left behind by missing library items in the same library
      const missingItemBooks = await bookModel.findAll({
        include: [
          {
            model: libraryItemModel,
            required: true,
            where: {
              libraryId: newExpandedLibraryItem.libraryId,
              isMissing: true
            }
          },
          {
            model: authorModel,
            through: { attributes: [] }
          }
        ]
      })

      // Books whose library item no longer exists at all (library cannot be determined for these)
      const orphanedBooks = await bookModel.findAll({
        include: [
          {
            model: libraryItemModel,
            required: false
          },
          {
            model: authorModel,
            through: { attributes: [] }
          }
        ],
        where: { '$libraryItem.id$': null }
      })

      const candidateBooks = [...missingItemBooks, ...orphanedBooks]
      if (!candidateBooks.length) return

      const matches = this.getBookIdentityMatches(newBook, candidateBooks)
      if (matches.length !== 1) {
        if (matches.length > 1) {
          Logger.debug(`[MediaProgress] Not relinking media progress for new book "${newBook.title}" because ${matches.length} missing/orphaned books matched`)
        }
        return
      }

      const oldBook = matches[0]
      const numRelinked = await this.moveBookProgresses(oldBook, newBook, newExpandedLibraryItem.id)
      if (numRelinked) {
        Logger.info(`[MediaProgress] Relinked media progress for ${numRelinked} user${numRelinked === 1 ? '' : 's'} from missing item "${oldBook.title}" to new library item "${newExpandedLibraryItem.path}"`)
      }
    } catch (error) {
      Logger.error(`[MediaProgress] Failed to relink media progress for new library item "${newExpandedLibraryItem.path}"`, error)
    }
  }

  /**
   * When a book library item is set as missing, look for a library item in the same library that is
   * not missing, was created after the missing one and identity-matches it (same tiers as
   * relinkFromMissingItems), and re-link the media progress to it. Covers a book that was copied to
   * a new folder and scanned in as a new item before the original was removed - when the copy was
   * scanned the original was not missing yet, so there was nothing to relink from.
   *
   * More than one match is ambiguous and nothing is relinked. Users who already have progress on
   * the matched book are left alone.
   *
   * Best-effort: failures are logged and swallowed so a scan is never broken by this.
   *
   * @param {import('./LibraryItem')} missingLibraryItem
   */
  static async relinkToPresentItem(missingLibraryItem) {
    if (missingLibraryItem?.mediaType !== 'book' || !missingLibraryItem.mediaId) return

    try {
      const bookModel = this.sequelize.models.book
      const libraryItemModel = this.sequelize.models.libraryItem
      const authorModel = this.sequelize.models.author

      const numProgresses = await this.count({
        where: {
          mediaItemId: missingLibraryItem.mediaId,
          mediaItemType: 'book'
        }
      })
      if (!numProgresses) return

      const missingBook = await bookModel.findByPk(missingLibraryItem.mediaId, {
        include: {
          model: authorModel,
          through: { attributes: [] }
        }
      })
      if (!missingBook) return

      const presentItemBooks = await bookModel.findAll({
        include: [
          {
            model: libraryItemModel,
            required: true,
            where: {
              libraryId: missingLibraryItem.libraryId,
              isMissing: false,
              id: { [Op.ne]: missingLibraryItem.id },
              createdAt: { [Op.gt]: missingLibraryItem.createdAt }
            }
          },
          {
            model: authorModel,
            through: { attributes: [] }
          }
        ]
      })
      if (!presentItemBooks.length) return

      const matches = this.getBookIdentityMatches(missingBook, presentItemBooks)
      if (matches.length !== 1) {
        if (matches.length > 1) {
          Logger.debug(`[MediaProgress] Not relinking media progress for missing book "${missingBook.title}" because ${matches.length} library items matched`)
        }
        return
      }

      const presentBook = matches[0]
      const numRelinked = await this.moveBookProgresses(missingBook, presentBook, presentBook.libraryItem.id)
      if (numRelinked) {
        Logger.info(`[MediaProgress] Relinked media progress for ${numRelinked} user${numRelinked === 1 ? '' : 's'} from missing item "${missingLibraryItem.path}" to library item "${presentBook.libraryItem.path}"`)
      }
    } catch (error) {
      Logger.error(`[MediaProgress] Failed to relink media progress for missing library item "${missingLibraryItem.path}"`, error)
    }
  }

  /**
   * Candidate books that identity-match a book, using the tiered check described on
   * relinkFromMissingItems. Only the first tier with any match is returned.
   *
   * @param {import('./Book')} book expanded with authors
   * @param {import('./Book')[]} candidateBooks expanded with authors
   * @returns {import('./Book')[]} more than one is an ambiguous match
   */
  static getBookIdentityMatches(book, candidateBooks) {
    const durationsMatch = (candidate) => Math.abs((candidate.duration || 0) - (book.duration || 0)) <= 5
    const getAudioFileSizes = (b) =>
      (b.audioFiles || [])
        .map((af) => af.metadata?.size)
        .filter((size) => !isNaN(size))
        .sort((a, b) => a - b)
    const getAuthorNamesKey = (b) =>
      (b.authors || [])
        .map((au) => cleanStringForSearch(au.name))
        .sort()
        .join(',')

    const bookAsin = book.asin?.trim().toLowerCase() || ''
    const bookTitle = cleanStringForSearch(book.title)
    const bookAuthorNamesKey = getAuthorNamesKey(book)
    const bookAudioFileSizes = getAudioFileSizes(book)

    // Sort candidates into tier 1 matches, tier 2 candidates (ASIN not comparable on one side)
    // and books explicitly excluded by a disagreeing ASIN (never matched at any tier)
    const tier1Matches = []
    const tier2Candidates = []
    const excludedByAsinMismatch = new Set()
    for (const candidate of candidateBooks) {
      const asin = candidate.asin?.trim().toLowerCase() || ''
      if (bookAsin && asin) {
        if (asin === bookAsin && durationsMatch(candidate)) {
          tier1Matches.push(candidate)
        } else if (asin !== bookAsin) {
          excludedByAsinMismatch.add(candidate.id)
        }
      } else {
        tier2Candidates.push(candidate)
      }
    }

    let winningTierMatches = tier1Matches

    if (!winningTierMatches.length) {
      winningTierMatches = tier2Candidates.filter((candidate) => cleanStringForSearch(candidate.title) === bookTitle && getAuthorNamesKey(candidate) === bookAuthorNamesKey && durationsMatch(candidate))
    }

    if (!winningTierMatches.length && bookAudioFileSizes.length) {
      winningTierMatches = candidateBooks.filter((candidate) => {
        if (excludedByAsinMismatch.has(candidate.id)) return false
        const audioFileSizes = getAudioFileSizes(candidate)
        return JSON.stringify(audioFileSizes) === JSON.stringify(bookAudioFileSizes) && durationsMatch(candidate)
      })
    }

    return winningTierMatches
  }

  /**
   * Re-link media progress from one book to another. Users who already have progress on the book
   * being re-linked to are left alone.
   *
   * @param {import('./Book')} fromBook
   * @param {import('./Book')} toBook
   * @param {string} toLibraryItemId
   * @returns {Promise<number>} number of media progress rows re-linked
   */
  static async moveBookProgresses(fromBook, toBook, toLibraryItemId) {
    const oldProgresses = await this.findAll({
      where: {
        mediaItemId: fromBook.id,
        mediaItemType: 'book'
      }
    })
    if (!oldProgresses.length) return 0

    const existingUserIds = (
      await this.findAll({
        attributes: ['userId'],
        where: {
          mediaItemId: toBook.id,
          mediaItemType: 'book'
        }
      })
    ).map((mp) => mp.userId)

    const progressesToRelink = oldProgresses.filter((mp) => !existingUserIds.includes(mp.userId))
    if (!progressesToRelink.length) return 0

    // Per-row updates rather than one bulk update: extraData is serialized to clients as the
    // progress row's libraryItemId (see toOldJSON), so it has to be repointed at the new library
    // item, and the JSON merge preserving each row's other extraData keys is per-row by nature
    await Promise.all(
      progressesToRelink.map((mp) =>
        mp.update({
          mediaItemId: toBook.id,
          extraData: { ...(mp.extraData || {}), libraryItemId: toLibraryItemId }
        })
      )
    )

    // Cached user objects hold their media progress rows, so evict affected users to avoid serving stale progress
    this.sequelize.models.user.mediaProgressesRelinked(progressesToRelink.map((mp) => mp.userId))

    return progressesToRelink.length
  }

  /**
   * Initialize model
   *
   * Polymorphic association: Book has many MediaProgress. PodcastEpisode has many MediaProgress.
   * @see https://sequelize.org/docs/v6/advanced-association-concepts/polymorphic-associations/
   *
   * @param {import('../Database').sequelize} sequelize
   */
  static init(sequelize) {
    super.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true
        },
        mediaItemId: DataTypes.UUID,
        mediaItemType: DataTypes.STRING,
        duration: DataTypes.FLOAT,
        currentTime: DataTypes.FLOAT,
        isFinished: DataTypes.BOOLEAN,
        hideFromContinueListening: DataTypes.BOOLEAN,
        ebookLocation: DataTypes.STRING,
        ebookProgress: DataTypes.FLOAT,
        finishedAt: DataTypes.DATE,
        extraData: DataTypes.JSON,
        podcastId: DataTypes.UUID
      },
      {
        sequelize,
        modelName: 'mediaProgress',
        indexes: [
          {
            fields: ['updatedAt']
          },
          {
            name: 'media_progresses_user_item_finished_time',
            fields: ['userId', 'mediaItemId', 'isFinished', 'currentTime']
          }
        ]
      }
    )

    const { book, podcastEpisode, user } = sequelize.models

    book.hasMany(MediaProgress, {
      foreignKey: 'mediaItemId',
      constraints: false,
      scope: {
        mediaItemType: 'book'
      }
    })
    MediaProgress.belongsTo(book, { foreignKey: 'mediaItemId', constraints: false })

    podcastEpisode.hasMany(MediaProgress, {
      foreignKey: 'mediaItemId',
      constraints: false,
      scope: {
        mediaItemType: 'podcastEpisode'
      }
    })
    MediaProgress.belongsTo(podcastEpisode, { foreignKey: 'mediaItemId', constraints: false })

    MediaProgress.addHook('afterFind', (findResult) => {
      if (!findResult) return

      if (!Array.isArray(findResult)) findResult = [findResult]

      for (const instance of findResult) {
        if (instance.mediaItemType === 'book' && instance.book !== undefined) {
          instance.mediaItem = instance.book
          instance.dataValues.mediaItem = instance.dataValues.book
        } else if (instance.mediaItemType === 'podcastEpisode' && instance.podcastEpisode !== undefined) {
          instance.mediaItem = instance.podcastEpisode
          instance.dataValues.mediaItem = instance.dataValues.podcastEpisode
        }
        // To prevent mistakes:
        delete instance.book
        delete instance.dataValues.book
        delete instance.podcastEpisode
        delete instance.dataValues.podcastEpisode
      }
    })

    // make sure to call the afterDestroy hook for each instance
    MediaProgress.addHook('beforeBulkDestroy', (options) => {
      options.individualHooks = true
    })

    // update the potentially cached user after destroying the media progress
    MediaProgress.addHook('afterDestroy', (instance) => {
      user.mediaProgressRemoved(instance)
    })

    user.hasMany(MediaProgress, {
      onDelete: 'CASCADE'
    })
    MediaProgress.belongsTo(user)
  }

  getMediaItem(options) {
    if (!this.mediaItemType) return Promise.resolve(null)
    const mixinMethodName = `get${this.sequelize.uppercaseFirst(this.mediaItemType)}`
    return this[mixinMethodName](options)
  }

  getOldMediaProgress() {
    const isPodcastEpisode = this.mediaItemType === 'podcastEpisode'

    return {
      id: this.id,
      userId: this.userId,
      libraryItemId: this.extraData?.libraryItemId || null,
      episodeId: isPodcastEpisode ? this.mediaItemId : null,
      mediaItemId: this.mediaItemId,
      mediaItemType: this.mediaItemType,
      duration: this.duration,
      progress: this.extraData?.progress || 0,
      currentTime: this.currentTime,
      isFinished: !!this.isFinished,
      hideFromContinueListening: !!this.hideFromContinueListening,
      ebookLocation: this.ebookLocation,
      ebookProgress: this.ebookProgress,
      lastUpdate: this.updatedAt.valueOf(),
      startedAt: this.createdAt.valueOf(),
      finishedAt: this.finishedAt?.valueOf() || null
    }
  }

  get progress() {
    // Value between 0 and 1
    if (!this.duration) return 0
    return Math.max(0, Math.min(this.currentTime / this.duration, 1))
  }

  /**
   * Apply update to media progress
   *
   * @param {import('./User').ProgressUpdatePayload} progressPayload
   * @returns {Promise<MediaProgress>}
   */
  async applyProgressUpdate(progressPayload) {
    if (!this.extraData) this.extraData = {}
    if (progressPayload.isFinished !== undefined) {
      if (progressPayload.isFinished && !this.isFinished) {
        this.finishedAt = progressPayload.finishedAt || Date.now()
        this.extraData.progress = 1
        this.changed('extraData', true)
        delete progressPayload.finishedAt
      } else if (!progressPayload.isFinished && this.isFinished) {
        this.finishedAt = null
        this.extraData.progress = 0
        this.currentTime = 0
        this.changed('extraData', true)
        delete progressPayload.finishedAt
        delete progressPayload.currentTime
      }
    } else if (!isNaN(progressPayload.progress) && progressPayload.progress !== this.progress) {
      // Old model stored progress on object
      this.extraData.progress = Math.min(1, Math.max(0, progressPayload.progress))
      this.changed('extraData', true)
    }

    this.set(progressPayload)

    // Reset hideFromContinueListening if the progress has changed
    if (this.changed('currentTime') && !progressPayload.hideFromContinueListening) {
      this.hideFromContinueListening = false
    }

    const timeRemaining = this.duration - this.currentTime

    // Check if progress is far enough to mark as finished
    //   - If markAsFinishedPercentComplete is provided, use that otherwise use markAsFinishedTimeRemaining (default 10 seconds)
    let shouldMarkAsFinished = false
    if (this.duration) {
      if (!isNullOrNaN(progressPayload.markAsFinishedPercentComplete) && progressPayload.markAsFinishedPercentComplete > 0) {
        const markAsFinishedPercentComplete = Number(progressPayload.markAsFinishedPercentComplete) / 100
        shouldMarkAsFinished = markAsFinishedPercentComplete < this.progress
        if (shouldMarkAsFinished) {
          Logger.info(`[MediaProgress] Marking media progress as finished because progress (${this.progress}) is greater than ${markAsFinishedPercentComplete} (media item ${this.mediaItemId})`)
        }
      } else {
        const markAsFinishedTimeRemaining = isNullOrNaN(progressPayload.markAsFinishedTimeRemaining) ? 10 : Number(progressPayload.markAsFinishedTimeRemaining)
        shouldMarkAsFinished = timeRemaining < markAsFinishedTimeRemaining
        if (shouldMarkAsFinished) {
          Logger.info(`[MediaProgress] Marking media progress as finished because time remaining (${timeRemaining}) is less than ${markAsFinishedTimeRemaining} seconds (media item ${this.mediaItemId})`)
        }
      }
    }

    if (!this.isFinished && shouldMarkAsFinished) {
      this.isFinished = true
      this.finishedAt = this.finishedAt || Date.now()
      this.extraData.progress = 1
      this.changed('extraData', true)
    } else if (this.isFinished && this.changed('currentTime') && !shouldMarkAsFinished) {
      this.isFinished = false
      this.finishedAt = null
    }

    await this.save()

    // For local sync
    if (progressPayload.lastUpdate) {
      if (isNaN(new Date(progressPayload.lastUpdate))) {
        Logger.warn(`[MediaProgress] Invalid date provided for lastUpdate: ${progressPayload.lastUpdate} (media item ${this.mediaItemId})`)
      } else {
        const escapedDate = this.sequelize.escape(new Date(progressPayload.lastUpdate))
        Logger.info(`[MediaProgress] Manually setting updatedAt to ${escapedDate} (media item ${this.mediaItemId})`)

        await this.sequelize.query(`UPDATE "mediaProgresses" SET "updatedAt" = ${escapedDate} WHERE "id" = '${this.id}'`)

        await this.reload()
      }
    }

    return this
  }
}

module.exports = MediaProgress
