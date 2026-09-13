import { logger } from '../utils.js';
const normalizeIpBlocks = (blocks) => {
    if (!Array.isArray(blocks))
        return [];
    return blocks
        .map((block) => {
        if (typeof block === 'string')
            return { cidr: block };
        if (block &&
            typeof block === 'object' &&
            typeof block.cidr === 'string') {
            return block;
        }
        return null;
    })
        .filter((block) => block !== null);
};
const resolveConfig = (nodelink) => {
    const cfg = nodelink.options.network.routePlanner;
    return {
        ...cfg,
        ipBlocks: normalizeIpBlocks(cfg.ipBlocks)
    };
};
const BIGINT_MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
/**
 * Provides outbound IP selection and ban tracking for route-planned requests.
 * @remarks Supports round-robin, rotate-on-ban and load-balance strategies.
 * @example
 * ```ts
 * const routePlanner = new RoutePlannerManager(nodelink)
 * const ip = routePlanner.getIP()
 * if (!ip) routePlanner.freeAll()
 * ```
 * @public
 */
export default class RoutePlannerManager {
    nodelink;
    config;
    blocks;
    bannedIps;
    bannedBlocks;
    lastUsedBlockIndex;
    /**
     * Creates a new route planner manager instance.
     * @param nodelink - NodeLink runtime context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = resolveConfig(nodelink);
        this.blocks = [];
        this.bannedIps = new Map();
        this.bannedBlocks = new Map();
        this.lastUsedBlockIndex = -1;
        const configuredBlocks = this.config.ipBlocks ?? [];
        if (configuredBlocks.length > 0) {
            this._loadIpBlocks();
        }
    }
    /**
     * Backward-compatible alias for configured runtime blocks.
     */
    get ipBlocks() {
        return this.blocks;
    }
    /**
     * Compatibility alias used by shutdown paths.
     */
    dispose() {
        this.freeAll();
    }
    /**
     * Converts an IPv4 or IPv6 address string to bigint form.
     * @param ip - IP address string.
     * @internal
     */
    _ipToBigInt(ip) {
        if (ip.includes(':')) {
            let groups;
            if (ip.includes('::')) {
                const [left = '', right = ''] = ip.split('::');
                const leftGroups = left.length > 0 ? left.split(':') : [];
                const rightGroups = right.length > 0 ? right.split(':') : [];
                const missingGroups = 8 - (leftGroups.length + rightGroups.length);
                if (missingGroups < 0) {
                    throw new Error(`Invalid IPv6 address: ${ip}`);
                }
                groups = [
                    ...leftGroups,
                    ...Array.from({ length: missingGroups }, () => '0'),
                    ...rightGroups
                ];
            }
            else {
                groups = ip.split(':');
            }
            if (groups.length !== 8) {
                throw new Error(`Invalid IPv6 address: ${ip}`);
            }
            const fullGroups = groups.map((group) => group.padStart(4, '0'));
            return BigInt(`0x${fullGroups.join('')}`);
        }
        const octets = ip.split('.');
        if (octets.length !== 4) {
            throw new Error(`Invalid IPv4 address: ${ip}`);
        }
        return octets.reduce((acc, octet) => {
            const parsedOctet = Number.parseInt(octet, 10);
            if (!Number.isInteger(parsedOctet) ||
                parsedOctet < 0 ||
                parsedOctet > 255) {
                throw new Error(`Invalid IPv4 address: ${ip}`);
            }
            return (acc << 8n) + BigInt(parsedOctet);
        }, 0n);
    }
    /**
     * Converts an IP bigint into string format.
     * @param value - Bigint representation of the IP.
     * @param isIpv6 - Whether the address should be rendered as IPv6.
     * @internal
     */
    _bigIntToIp(value, isIpv6) {
        if (isIpv6) {
            const hex = value.toString(16).padStart(32, '0');
            const parts = [];
            for (let i = 0; i < 8; i++) {
                parts.push(hex.substring(i * 4, i * 4 + 4));
            }
            return parts.map((part) => part.replace(/^0+/, '') || '0').join(':');
        }
        const parts = [];
        let remaining = value;
        for (let i = 0; i < 4; i++) {
            parts.unshift(Number(remaining & 255n));
            remaining >>= 8n;
        }
        return parts.join('.');
    }
    /**
     * Parses and initializes all configured CIDR blocks.
     * @internal
     */
    _loadIpBlocks() {
        for (const blockConfig of this.config.ipBlocks ?? []) {
            try {
                const [baseIp, maskLengthStr] = blockConfig.cidr.split('/');
                if (!baseIp || !maskLengthStr) {
                    throw new Error(`Invalid CIDR format: ${blockConfig.cidr}`);
                }
                const maskLength = parseInt(maskLengthStr, 10);
                const isIpv6 = baseIp.includes(':');
                const totalBits = isIpv6 ? 128n : 32n;
                if (!Number.isInteger(maskLength) ||
                    maskLength < 0 ||
                    maskLength > Number(totalBits)) {
                    throw new Error(`Invalid mask length in CIDR: ${blockConfig.cidr}`);
                }
                const baseInt = this._ipToBigInt(baseIp);
                const mask = ((1n << BigInt(maskLength)) - 1n) << (totalBits - BigInt(maskLength));
                const networkInt = baseInt & mask;
                const size = 1n << (totalBits - BigInt(maskLength));
                this.blocks.push({
                    cidr: blockConfig.cidr,
                    networkInt,
                    size,
                    lastUsedOffset: -1n,
                    isIpv6
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger('error', 'RoutePlanner', `Failed to parse block ${blockConfig.cidr}: ${message}`);
            }
        }
        logger('info', 'RoutePlanner', `Initialized with ${this.blocks.length} IP blocks.`);
    }
    /**
     * Returns the next available IP using the configured strategy.
     * @returns A routable IP address or null when none are available.
     */
    getIP() {
        if (this.blocks.length === 0)
            return null;
        const strategy = this.config.strategy || 'RotateOnBan';
        switch (strategy) {
            case 'RoundRobin':
            case 'RotateOnBan':
                return this._getNextIp();
            case 'LoadBalance':
                return this._getRandomIp();
            default:
                return this._getNextIp();
        }
    }
    /**
     * Resolves the next available IP using cyclic block traversal.
     * @internal
     */
    _getNextIp() {
        const now = Date.now();
        for (let i = 0; i < this.blocks.length; i++) {
            this.lastUsedBlockIndex =
                (this.lastUsedBlockIndex + 1) % this.blocks.length;
            const block = this.blocks[this.lastUsedBlockIndex];
            if (!block)
                continue;
            const blockBanExpiration = this.bannedBlocks.get(block.cidr);
            if (blockBanExpiration !== undefined && now < blockBanExpiration) {
                continue;
            }
            for (let attempt = 0; attempt < 10; attempt++) {
                block.lastUsedOffset = (block.lastUsedOffset + 1n) % block.size;
                const ipInt = block.networkInt + block.lastUsedOffset;
                const ip = this._bigIntToIp(ipInt, block.isIpv6);
                const ipBanExpiration = this.bannedIps.get(ip);
                if (ipBanExpiration === undefined || now > ipBanExpiration) {
                    return ip;
                }
            }
        }
        return null;
    }
    /**
     * Resolves an available IP using random block/offset selection.
     * @internal
     */
    _getRandomIp() {
        const now = Date.now();
        const availableBlocks = this.blocks.filter((b) => this.bannedBlocks.get(b.cidr) === undefined ||
            now > Number(this.bannedBlocks.get(b.cidr)));
        if (availableBlocks.length === 0)
            return null;
        const block = availableBlocks[Math.floor(Math.random() * availableBlocks.length)];
        if (!block)
            return null;
        const randomOffset = BigInt(Math.floor(Math.random() *
            Number(block.size > BIGINT_MAX_SAFE_INTEGER
                ? Number.MAX_SAFE_INTEGER
                : block.size)));
        const ipInt = block.networkInt + randomOffset;
        return this._bigIntToIp(ipInt, block.isIpv6);
    }
    /**
     * Marks an IP as temporarily banned and escalates to block bans when needed.
     * @param ip - IP address to ban.
     */
    banIP(ip) {
        if (!ip)
            return;
        const cooldown = this.config.bannedIpCooldown || 600000;
        const now = Date.now();
        this.bannedIps.set(ip, now + cooldown);
        // Check if we should ban the whole block (if many IPs are failing)
        const ipInt = this._ipToBigInt(ip);
        const block = this.blocks.find((b) => {
            return ipInt >= b.networkInt && ipInt < b.networkInt + b.size;
        });
        if (block) {
            let failedInBlock = 0;
            for (const bannedIp of this.bannedIps.keys()) {
                const bIpInt = this._ipToBigInt(bannedIp);
                if (bIpInt >= block.networkInt &&
                    bIpInt < block.networkInt + block.size) {
                    failedInBlock++;
                }
            }
            if (failedInBlock >= 5) {
                this.bannedBlocks.set(block.cidr, now + cooldown * 2);
                logger('warn', 'RoutePlanner', `Banning Block: ${block.cidr} due to multiple failures.`);
            }
        }
        logger('warn', 'RoutePlanner', `Banning IP: ${ip} for ${cooldown}ms`);
    }
    /**
     * Removes a single banned IP from the cooldown registry.
     * @param ip - IP address to free.
     */
    freeIP(ip) {
        if (!ip)
            return;
        if (this.bannedIps.has(ip)) {
            this.bannedIps.delete(ip);
            logger('info', 'RoutePlanner', `Freed IP: ${ip}`);
        }
    }
    /**
     * Clears all banned IP and block cooldown entries.
     */
    freeAll() {
        this.bannedIps.clear();
        this.bannedBlocks.clear();
        logger('info', 'RoutePlanner', 'Freed all banned IPs and blocks.');
    }
}
