/**
 * Configured IP block entry accepted by the route planner.
 *
 * The canonical config type allows both raw CIDR strings and `{ cidr }`
 * objects, so the endpoint must accept both shapes here as well.
 * @public
 */
export type RoutePlannerIpBlockEntry = string | { cidr: string }
