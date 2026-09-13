import type {
  GroupStateJSON,
  PlayerGroup
} from '../typings/playback/group.types.ts'
import { logger } from '../utils.ts'

/**
 * Manages groups of players within a session for multi-guild synchronization.
 *
 * @remarks
 * A group is a pure orchestration layer — it does not share streams, decoders,
 * or buffers between players. Each player in a group keeps its own independent
 * audio pipeline (decoder, FlowController, OpusEncoder, voice connection).
 *
 * The group provides a single API surface to apply the same operations
 * (play, pause, seek, volume, filters, etc.) to all member players at once,
 * while still allowing individual player control.
 *
 * This is designed for radio bots that need to keep N guilds synchronized
 * on the same track and position.
 */
export default class GroupManager {
  /**
   * Map of group ID to PlayerGroup.
   */
  private readonly groups: Map<string, PlayerGroup> = new Map()

  /**
   * Creates a new player group.
   *
   * @param id - Unique group identifier.
   * @param guildIds - Initial set of guild IDs to include.
   * @returns The created group.
   * @throws Error if a group with the same ID already exists.
   */
  create(id: string, guildIds: string[] = []): PlayerGroup {
    if (this.groups.has(id)) {
      throw new Error(`Group '${id}' already exists`)
    }

    const group: PlayerGroup = {
      id,
      guildIds: new Set(guildIds),
      createdAt: Date.now()
    }

    this.groups.set(id, group)

    logger(
      'debug',
      'GroupManager',
      `Group '${id}' created with ${guildIds.length} player(s)`
    )

    return group
  }

  /**
   * Retrieves a group by ID.
   *
   * @param id - Group identifier.
   * @returns The group, or `undefined` if not found.
   */
  get(id: string): PlayerGroup | undefined {
    return this.groups.get(id)
  }

  /**
   * Checks whether a group exists.
   *
   * @param id - Group identifier.
   * @returns `true` when the group exists.
   */
  has(id: string): boolean {
    return this.groups.has(id)
  }

  /**
   * Deletes a group. Does not destroy the member players.
   *
   * @param id - Group identifier.
   * @returns `true` if the group existed and was deleted.
   */
  delete(id: string): boolean {
    const existed = this.groups.delete(id)

    if (existed) {
      logger('debug', 'GroupManager', `Group '${id}' deleted`)
    }

    return existed
  }

  /**
   * Adds a guild to a group.
   *
   * @param groupId - Target group identifier.
   * @param guildId - Guild to add.
   * @throws Error if the group does not exist.
   */
  addPlayer(groupId: string, guildId: string): void {
    const group = this.groups.get(groupId)
    if (!group) throw new Error(`Group '${groupId}' not found`)

    group.guildIds.add(guildId)

    logger(
      'debug',
      'GroupManager',
      `Added guild ${guildId} to group '${groupId}' (${group.guildIds.size} member(s))`
    )
  }

  /**
   * Removes a guild from a group.
   *
   * @param groupId - Target group identifier.
   * @param guildId - Guild to remove.
   * @throws Error if the group does not exist.
   */
  removePlayer(groupId: string, guildId: string): void {
    const group = this.groups.get(groupId)
    if (!group) throw new Error(`Group '${groupId}' not found`)

    group.guildIds.delete(guildId)

    logger(
      'debug',
      'GroupManager',
      `Removed guild ${guildId} from group '${groupId}' (${group.guildIds.size} member(s))`
    )
  }

  /**
   * Returns the guild IDs for a group.
   *
   * @param groupId - Target group identifier.
   * @returns Array of guild IDs, or empty array if group not found.
   */
  getGuildIds(groupId: string): string[] {
    const group = this.groups.get(groupId)
    return group ? Array.from(group.guildIds) : []
  }

  /**
   * Lists all groups as JSON.
   *
   * @returns Array of serialized group states.
   */
  list(): GroupStateJSON[] {
    return Array.from(this.groups.values()).map((g) => this._toJSON(g))
  }

  /**
   * Serializes a specific group to JSON.
   *
   * @param groupId - Target group identifier.
   * @returns Serialized group state, or `null` if not found.
   */
  toJSON(groupId: string): GroupStateJSON | null {
    const group = this.groups.get(groupId)
    return group ? this._toJSON(group) : null
  }

  /**
   * Destroys all groups. Called during session cleanup.
   */
  destroy(): void {
    this.groups.clear()
  }

  /**
   * Returns the number of groups.
   */
  get size(): number {
    return this.groups.size
  }

  /**
   * Internal JSON serialization helper.
   */
  private _toJSON(group: PlayerGroup): GroupStateJSON {
    return {
      id: group.id,
      guildIds: Array.from(group.guildIds),
      createdAt: group.createdAt
    }
  }
}
