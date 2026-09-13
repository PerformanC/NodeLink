/**
 * Represents a group of synchronized players.
 */
export interface PlayerGroup {
  /**
   * Unique group identifier.
   */
  id: string

  /**
   * Set of guild IDs belonging to this group.
   */
  guildIds: Set<string>

  /**
   * Timestamp of group creation.
   */
  createdAt: number
}

/**
 * JSON-serializable representation of a player group.
 */
export interface GroupStateJSON {
  /**
   * Group identifier.
   */
  id: string

  /**
   * Array of guild IDs in this group.
   */
  guildIds: string[]

  /**
   * Timestamp of group creation.
   */
  createdAt: number
}
